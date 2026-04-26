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
import { parseCsaasRateCard } from './rate-card.parser.js';

export interface CreateRateCardInput {
  name: string;
  currency?: string;
  serviceLines: Array<{
    slug: string;
    displayName: string;
    scopeUnit: ScopeUnit;
    pricingModel?: 'tier_lookup' | 'per_unit' | 'flat' | 'hourly';
    position?: number;
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
  constructor(private readonly tenantDb: TenantDb) {}

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
  ): Promise<{ rateCardId: string; warnings: string[] }> {
    const { draft, warnings } = parseCsaasRateCard(matrix, opts);
    const card = await this.create(tenantId, draft);
    return { rateCardId: card.id, warnings };
  }

  // ── Seed: install the canonical CSaaS sample for a tenant ───────────────

  /**
   * Idempotent: if a rate card with the fixture's name + version already
   * exists for the tenant, returns it as-is. Otherwise creates one. Used
   * by dev seeds + integration tests so they have something realistic
   * to quote against without running the importer.
   */
  async seedCsaasSample(tenantId: string): Promise<RateCard> {
    return this.tenantDb.run(tenantId, async (db) => {
      const fixture = buildCsaasRateCardFixture({
        rateCardId: 'unused',     // we let Postgres assign
        tenantId,
        ids: 'random',
      });

      const existing = await db.rateCard.findFirst({
        where: { tenantId, name: fixture.name, version: fixture.version },
      });
      if (existing) {
        const full = await this.loadFull(db, existing.id);
        if (full) return full;
      }

      const card = await db.rateCard.create({
        data: { tenantId, name: fixture.name, currency: fixture.currency, status: 'published' },
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
      serviceLines,
      openPricedServices,
    };
  }
}
