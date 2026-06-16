/**
 * Rate Card service — Phase 1 surface area for the Rhud Pricing Engine.
 *
 *   • CRUD for rate cards + their service lines, tiers, and open-priced services.
 *   • Loads a canonical RateCard back into memory in one query for the
 *     pure `computeBasePrice` function in @rhud/shared.
 *   • Quote endpoint: caller submits a normalised scope → service returns
 *     the line-itemised base price + total (Stage 2).
 *
 * The service deliberately doesn't model the importer (Phase 2), the
 * historical-quote feature store (Phase 3), or the modifier model
 * (Phase 4). Those land in follow-up sprints. What's here is the
 * foundation: a versioned, RLS-isolated, deterministic price book that
 * every future stage layers on top of.
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  computeBasePrice,
  type BasePriceResult,
  type CustomerType,
  type Methodology,
  type RateCard,
  type RateCardOpenPricedService,
  type RateCardServiceLine,
  type RateCardTier,
  type ScopeUnit,
  type ScopedEntity,
} from '@rhud/shared';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { buildCsaasRateCardFixture } from './csaas-rate-card.fixture.js';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';
import { parseCsaasRateCard } from './rate-card.parser.js';
import {
  RateCardHintSynthesizerService,
  type SynthesiserInput,
} from './rate-card-hint-synthesizer.service.js';

export interface CreateRateCardInput {
  name: string;
  currency?: string;
  /** See packages/shared/src/pricing.ts (RateCard.inferenceContext). */
  inferenceContext?: string | null;
  defaultMethodologyRule?: string | null;
  inferenceExamples?: string[];
  serviceLines: Array<{
    slug: string;
    displayName: string;
    scopeUnit: ScopeUnit;
    pricingModel?: 'tier_lookup' | 'per_unit' | 'flat' | 'hourly';
    position?: number;
    /** Layer-3 mapper hint for THIS slug. See RateCardServiceLine.inferenceHint. */
    inferenceHint?: string | null;
    inferenceExamples?: string[];
    /** Pool volume across multi-app instances (per_unit lines). */
    poolAcrossEntities?: boolean;
    tiers: Array<{
      rangeMin: number;
      rangeMax: number | null;
      methodology: Methodology;
      customerType: CustomerType;
      priceCents: number;
      displayLabel?: string | null;
    }>;
  }>;
  openPricedServices?: Array<{
    slug: string;
    displayName: string;
    category?: string | null;
  }>;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly hintSynthesiser: RateCardHintSynthesizerService,
  ) {}

  // ── Rate card lifecycle ──────────────────────────────────────────────────

  async list(tenantId: string): Promise<Array<Pick<RateCard, 'id' | 'name' | 'version' | 'status' | 'currency'>>> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.rateCard.findMany({ orderBy: [{ name: 'asc' }, { version: 'desc' }] });
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        status: r.status as RateCard['status'],
        currency: r.currency,
      }));
    });
  }

  async getById(tenantId: string, id: string): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await this.loadFull(db, id);
      if (!row) throw new NotFoundException('rate_card_not_found');
      return row;
    });
  }

  async create(tenantId: string, input: CreateRateCardInput): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const card = await db.rateCard.create({
        data: {
          tenantId,
          name: input.name,
          currency: input.currency ?? 'INR',
          status: 'draft',
          inferenceContext: input.inferenceContext ?? null,
          defaultMethodologyRule: input.defaultMethodologyRule ?? null,
          inferenceExamples: input.inferenceExamples ?? [],
        },
      });

      for (const sl of input.serviceLines) {
        const created = await db.rateCardServiceLine.create({
          data: {
            tenantId,
            rateCardId: card.id,
            slug: sl.slug,
            displayName: sl.displayName,
            scopeUnit: sl.scopeUnit,
            pricingModel: sl.pricingModel ?? 'tier_lookup',
            position: sl.position ?? 0,
            inferenceHint: sl.inferenceHint ?? null,
            inferenceExamples: sl.inferenceExamples ?? [],
            poolAcrossEntities: sl.poolAcrossEntities ?? false,
          },
        });
        if (sl.tiers.length > 0) {
          await db.rateCardTier.createMany({
            data: sl.tiers.map((t) => ({
              tenantId,
              serviceLineId: created.id,
              rangeMin: t.rangeMin,
              rangeMax: t.rangeMax,
              methodology: t.methodology,
              customerType: t.customerType,
              priceCents: BigInt(t.priceCents),
              displayLabel: t.displayLabel ?? null,
            })),
          });
        }
      }

      for (const op of input.openPricedServices ?? []) {
        await db.rateCardOpenPricedService.create({
          data: {
            tenantId,
            rateCardId: card.id,
            slug: op.slug,
            displayName: op.displayName,
            category: op.category ?? null,
          },
        });
      }

      const full = await this.loadFull(db, card.id);
      if (!full) throw new Error('rate_card_lost_after_create'); // unreachable
      return full;
    });
  }

  async publish(tenantId: string, id: string): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.rateCard.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('rate_card_not_found');
      if (row.status === 'published') return (await this.loadFull(db, id))!;

      // Sanity-check: a published rate card must have at least one tier
      // somewhere. Empty cards are useless and almost certainly a bug
      // upstream — refuse so the manager doesn't ship a non-quoting card.
      const tierCount = await db.rateCardTier.count({ where: { tenantId } });
      if (tierCount === 0) throw new BadRequestException('rate_card_has_no_tiers');

      // Tier-overlap validator. Within a single (serviceLine, methodology,
      // customerType) bucket, two tiers' [rangeMin, rangeMax] windows must
      // not overlap — `pickTier` returns the *first* matching tier, so
      // overlap makes pricing depend on insertion order (a real bug we
      // hit in the wild — see P0-2 in see-that-is-self-sunny-honey.md).
      const card = await this.loadFull(db, id);
      if (!card) throw new NotFoundException('rate_card_not_found');
      const overlaps = findOverlappingTiers(card);
      if (overlaps.length > 0) {
        throw new BadRequestException({
          code: 'rate_card_tier_overlap',
          message:
            `${overlaps.length} pair${overlaps.length === 1 ? '' : 's'} of tiers overlap. ` +
            `Pricing would be order-dependent. Resolve before publishing.`,
          overlaps,
        });
      }

      await db.rateCard.update({ where: { id }, data: { status: 'published' } });
      return (await this.loadFull(db, id))!;
    });
  }

  async archive(tenantId: string, id: string): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.rateCard.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('rate_card_not_found');
      await db.rateCard.update({ where: { id }, data: { status: 'archived' } });
      return (await this.loadFull(db, id))!;
    });
  }

  /**
   * Hard-delete a rate card. Service lines, tiers, and open-priced
   * services cascade with it (FK onDelete=Cascade in the schema).
   * Templates + engagements that reference this card get their
   * `rateCardId` set to NULL (FK onDelete=SetNull) — they keep
   * existing, just unbound. The caller surfaces this in the UI as a
   * "X templates will be unbound" warning before confirm.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const exists = await db.rateCard.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('rate_card_not_found');
      await db.rateCard.delete({ where: { id } });
    });
  }

  /** Count of templates currently bound to this card. Used for the
   *  delete-confirmation modal so the admin sees the unbinding impact
   *  before clicking Delete. */
  async countTemplateBindings(tenantId: string, id: string): Promise<number> {
    return this.tenantDb.run(tenantId, async (db) => {
      return db.template.count({ where: { rateCardId: id } });
    });
  }

  // ── Quote (Stage 2) ──────────────────────────────────────────────────────

  /**
   * Run the deterministic base-price computation against the given rate
   * card and a normalised scope. No ML, no fallbacks — every rupee is
   * traceable to a tier in the persisted card version.
   */
  async quote(
    tenantId: string,
    rateCardId: string,
    scope: ScopedEntity[],
  ): Promise<BasePriceResult> {
    const card = await this.getById(tenantId, rateCardId);
    return computeBasePrice(card, scope);
  }

  // ── Phase 2 ingestion ───────────────────────────────────────────────────

  /**
   * Run the structural parser over a 2-D matrix (typically read from an
   * uploaded xlsx) and persist the result as a draft rate card. The
   * admin-review UI is the next place this draft surfaces; today we
   * trust the parser end-to-end on the CSaaS layout and let the admin
   * publish it via the regular /publish endpoint.
   *
   * Returns warnings alongside the saved card so the UI can surface
   * tier rows that came back without prices, etc.
   */
  async parseAndSave(
    tenantId: string,
    matrix: string[][],
    opts: { name?: string } = {},
  ): Promise<{ rateCardId: string; warnings: string[]; hintsSynthesized: boolean }> {
    const { draft, warnings } = parseCsaasRateCard(matrix, opts);
    const card = await this.create(tenantId, draft);
    // Auto-synthesize the inference ontology so the Layer-3 mapper has
    // domain-specific hints for THIS rate card from day one. Falls
    // back silently if the LLM is unavailable — the rate card is still
    // usable, it just relies on synthesizeDefaultHint at mapper time.
    const hintsSynthesized = await this.synthesizeAndPersistHints(tenantId, card.id);
    return { rateCardId: card.id, warnings, hintsSynthesized };
  }

  /**
   * Backfill / re-generate the inference ontology (inferenceContext,
   * defaultMethodologyRule, per-slug inferenceHints, examples) for an
   * existing rate card. Use cases:
   *   - Fixing up a rate card that was created when the LLM was offline.
   *   - Tenant changed providers / wants fresher hints.
   *   - Admin imported a rate card via fixture/seed without hints.
   *
   * Idempotent: existing hints are overwritten. The mapper will pick up
   * the new ones on its next call (no cache flush needed — mapper reads
   * the rate card fresh each time).
   *
   * Returns true on success, false when the LLM was unavailable / parse
   * failed; in the failure case the rate card's hints are unchanged.
   */
  async regenerateHints(tenantId: string, rateCardId: string): Promise<boolean> {
    return this.synthesizeAndPersistHints(tenantId, rateCardId);
  }

  /** Shared implementation behind parseAndSave + regenerateHints. */
  private async synthesizeAndPersistHints(tenantId: string, rateCardId: string): Promise<boolean> {
    const card = await this.getById(tenantId, rateCardId);
    const synthInput: SynthesiserInput = {
      name: card.name,
      serviceLines: card.serviceLines.map((sl) => ({
        slug: sl.slug,
        displayName: sl.displayName,
        scopeUnit: sl.scopeUnit,
        methodologies: [
          ...new Set(
            sl.tiers.map((t) => t.methodology).filter((m): m is string => m != null),
          ),
        ],
      })),
    };
    const ontology = await this.hintSynthesiser.synthesize(tenantId, synthInput);
    if (!ontology) return false;

    await this.tenantDb.run(tenantId, async (db) => {
      // Update the rate card's top-level fields.
      await db.rateCard.update({
        where: { id: rateCardId },
        data: {
          inferenceContext: ontology.inferenceContext || null,
          defaultMethodologyRule: ontology.defaultMethodologyRule || null,
          inferenceExamples: ontology.inferenceExamples,
        },
      });
      // Per-slug hints. Loop instead of bulk because Prisma's
      // updateMany doesn't support per-row distinct values for the
      // hint column.
      for (const sl of card.serviceLines) {
        const hint = ontology.hints.get(sl.slug);
        if (hint == null) continue;
        await db.rateCardServiceLine.update({
          where: { id: sl.id },
          data: { inferenceHint: hint },
        });
      }
    });
    return true;
  }

  // ── Seed: install the canonical CSaaS sample for a tenant ───────────────

  /**
   * Idempotent: if a rate card with the fixture's name + version already
   * exists for the tenant, returns it as-is. Otherwise creates one. Used
   * by dev seeds + integration tests so they have something realistic
   * to quote against without running the importer.
   */
  async seedCsaasSample(tenantId: string): Promise<RateCard> {
    return this.seedFromFixture(
      tenantId,
      buildCsaasRateCardFixture({ rateCardId: 'unused', tenantId, ids: 'random' }),
    );
  }

  /** Mirror of `seedCsaasSample` for the Prophaze rate card. */
  async seedProphazeSample(tenantId: string): Promise<RateCard> {
    return this.seedFromFixture(
      tenantId,
      buildProphazeRateCardFixture({ rateCardId: 'unused', tenantId, ids: 'random' }),
    );
  }

  /** Shared installer used by both seed-XYZ-sample helpers. */
  private async seedFromFixture(tenantId: string, fixture: RateCard): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.rateCard.findFirst({
        where: { tenantId, name: fixture.name, version: fixture.version },
      });
      if (existing) {
        const full = await this.loadFull(db, existing.id);
        if (full) return full;
      }

      const card = await db.rateCard.create({
        data: {
          tenantId,
          name: fixture.name,
          currency: fixture.currency,
          status: 'published',
          inferenceContext: fixture.inferenceContext ?? null,
          defaultMethodologyRule: fixture.defaultMethodologyRule ?? null,
          inferenceExamples: fixture.inferenceExamples ?? [],
        },
      });
      for (const sl of fixture.serviceLines) {
        const slRow = await db.rateCardServiceLine.create({
          data: {
            tenantId,
            rateCardId: card.id,
            slug: sl.slug,
            displayName: sl.displayName,
            scopeUnit: sl.scopeUnit,
            pricingModel: sl.pricingModel,
            position: sl.position,
            inferenceHint: sl.inferenceHint ?? null,
            inferenceExamples: sl.inferenceExamples ?? [],
            poolAcrossEntities: sl.poolAcrossEntities ?? false,
          },
        });
        if (sl.tiers.length > 0) {
          await db.rateCardTier.createMany({
            data: sl.tiers.map((t) => ({
              tenantId,
              serviceLineId: slRow.id,
              rangeMin: t.rangeMin,
              rangeMax: t.rangeMax,
              methodology: t.methodology,
              customerType: t.customerType,
              priceCents: BigInt(t.priceCents),
              displayLabel: t.displayLabel ?? null,
            })),
          });
        }
      }
      for (const op of fixture.openPricedServices) {
        await db.rateCardOpenPricedService.create({
          data: {
            tenantId,
            rateCardId: card.id,
            slug: op.slug,
            displayName: op.displayName,
            category: op.category ?? null,
            position: op.position,
          },
        });
      }
      return (await this.loadFull(db, card.id))!;
    });
  }

  // ── Loader ───────────────────────────────────────────────────────────────

  private async loadFull(db: PrismaTx, id: string): Promise<RateCard | null> {
    const row = await db.rateCard.findUnique({
      where: { id },
      include: {
        serviceLines: { include: { tiers: true } },
        openPricedServices: true,
      },
    });
    if (!row) return null;

    const serviceLines: RateCardServiceLine[] = row.serviceLines
      .sort((a, b) => a.position - b.position)
      .map((sl) => ({
        id: sl.id,
        slug: sl.slug,
        displayName: sl.displayName,
        scopeUnit: sl.scopeUnit as ScopeUnit,
        pricingModel: sl.pricingModel as RateCardServiceLine['pricingModel'],
        position: sl.position,
        inferenceHint: sl.inferenceHint ?? null,
        inferenceExamples: parseStringArray(sl.inferenceExamples),
        poolAcrossEntities: sl.poolAcrossEntities ?? false,
        tiers: sl.tiers.map((t): RateCardTier => ({
          id: t.id,
          rangeMin: t.rangeMin,
          rangeMax: t.rangeMax,
          methodology: t.methodology,
          customerType: t.customerType as CustomerType,
          priceCents: Number(t.priceCents),
          displayLabel: t.displayLabel,
        })),
      }));

    const openPricedServices: RateCardOpenPricedService[] = row.openPricedServices
      .sort((a, b) => a.position - b.position)
      .map((o) => ({
        id: o.id,
        slug: o.slug,
        displayName: o.displayName,
        category: o.category,
        position: o.position,
      }));

    return {
      id: row.id,
      tenantId: row.tenantId,
      name: row.name,
      version: row.version,
      status: row.status as RateCard['status'],
      currency: row.currency,
      effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      inferenceContext: row.inferenceContext ?? null,
      defaultMethodologyRule: row.defaultMethodologyRule ?? null,
      inferenceExamples: parseStringArray(row.inferenceExamples),
      serviceLines,
      openPricedServices,
    };
  }
}

/**
 * Coerce a Prisma `Json` column back to `string[]`. Defensive — older
 * rows may have written non-array JSON; we round-trip through filter()
 * so the mapper never sees a malformed examples list.
 */
function parseStringArray(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.filter((v): v is string => typeof v === 'string');
}

// ── Validators ───────────────────────────────────────────────────────────

interface TierOverlap {
  serviceLineSlug: string;
  methodology: string | null;
  customerType: string;
  a: { rangeMin: number; rangeMax: number | null; displayLabel: string | null };
  b: { rangeMin: number; rangeMax: number | null; displayLabel: string | null };
}

/**
 * Find tier pairs whose [rangeMin, rangeMax] windows overlap within the
 * same (serviceLine, methodology, customerType) bucket. `pickTier` returns
 * the first match, so any overlap makes pricing order-dependent — which
 * is a silent correctness bug (P0-2). Used by `publish` to refuse a card
 * that would price unpredictably.
 */
export function findOverlappingTiers(card: RateCard): TierOverlap[] {
  const out: TierOverlap[] = [];
  for (const sl of card.serviceLines) {
    // Bucket tiers by (methodology, customerType). null methodology is its
    // own bucket — `pickTier` treats null as a wildcard, but two null tiers
    // can still overlap with each other.
    const bucket = new Map<string, typeof sl.tiers>();
    for (const t of sl.tiers) {
      const key = `${t.methodology ?? '<null>'}::${t.customerType}`;
      const list = bucket.get(key) ?? [];
      list.push(t);
      bucket.set(key, list);
    }
    for (const [, tiers] of bucket) {
      for (let i = 0; i < tiers.length; i++) {
        for (let j = i + 1; j < tiers.length; j++) {
          const a = tiers[i]!;
          const b = tiers[j]!;
          if (rangesOverlap(a.rangeMin, a.rangeMax, b.rangeMin, b.rangeMax)) {
            out.push({
              serviceLineSlug: sl.slug,
              methodology: a.methodology,
              customerType: a.customerType,
              a: { rangeMin: a.rangeMin, rangeMax: a.rangeMax, displayLabel: a.displayLabel ?? null },
              b: { rangeMin: b.rangeMin, rangeMax: b.rangeMax, displayLabel: b.displayLabel ?? null },
            });
          }
        }
      }
    }
  }
  return out;
}

function rangesOverlap(
  aMin: number, aMax: number | null,
  bMin: number, bMax: number | null,
): boolean {
  // Two ranges overlap iff !(a entirely above b) && !(a entirely below b).
  // null rangeMax = open-ended (extends to infinity).
  const aMaxEff = aMax ?? Number.MAX_SAFE_INTEGER;
  const bMaxEff = bMax ?? Number.MAX_SAFE_INTEGER;
  return aMin <= bMaxEff && bMin <= aMaxEff;
}
