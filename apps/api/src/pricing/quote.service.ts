/**
 * Quote service — wires the pricing kernel into the engagement flow.
 *
 *   • computeAndPersistForEngagement(): runs Stage 1 (scope normalisation)
 *     + Stage 2 (deterministic base price) for an engagement and writes
 *     the result to engagement_quotes. Idempotent: re-running upserts.
 *   • getForEngagement(): manager approval card reads this.
 *   • approve(): records the manager-confirmed final price.
 *
 * Stage 3 (modifier prediction) is not invoked here today — the existing
 * MlService.predictForEngagement runs as a fire-and-forget after submit
 * and writes its prediction back onto the engagement directly. Wiring
 * the modifier into this row (predicted_*, modifier_drivers fields) is
 * the obvious next step once the model is retargeted to log(final/base).
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  computeBasePrice,
  normaliseScope,
  type Answer,
  type AnswersByIter,
  type BasePriceResult,
  type CustomerType,
  type Methodology,
  type ScopedEntity,
  type TemplateWithNodes,
} from '@rhud/shared';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { PricingService } from './pricing.service.js';
import {
  RateCardFieldMapperService,
  type InferredEntity,
} from './rate-card-mapper.service.js';

export interface PersistedQuote {
  id: string;
  engagementId: string;
  rateCardId: string | null;
  rateCardVersion: number;
  currency: string;
  baseTotalCents: number;
  baseBreakdown: BasePriceResult['lines'];
  predictedAdjustmentPct: number | null;
  predictedPriceCents: number | null;
  predictedBandLowCents: number | null;
  predictedBandHighCents: number | null;
  winProbability: number | null;
  modifierDrivers: unknown;
  techAdjustedPriceCents: number | null;
  techAdjustedAt: string | null;
  techAdjustedBy: string | null;
  techAdjustmentNote: string | null;
  techAdjustedPredictionId: string | null;
  approvedPriceCents: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  computedAt: string;
}

@Injectable()
export class QuoteService {
  private readonly logger = new Logger(QuoteService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly pricing: PricingService,
    private readonly thread: ThreadService,
    private readonly fieldMapper: RateCardFieldMapperService,
  ) {}

  /**
   * Compute Stage 1 + Stage 2 for the given engagement and upsert the
   * result row. Returns null if the engagement's template has no rate
   * card bound — the demo loop simply skips quoting in that case.
   */
  async computeAndPersistForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<PersistedQuote | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        include: {
          template: {
            include: { nodes: { orderBy: { position: 'asc' } } },
          },
          answers: true,
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      // Direct-ingest opportunities (docs/direct-ingest.md §3.2) may have
      // no template attached. There's no rate card to walk in that case
      // — skip base-price computation. Pricing can still happen later
      // via Layer-3 (extracted-points → modifier ML); the quote row
      // stays null until a template is attached via "Send scoping
      // questions" or until the rep manually authors line items.
      // Effective rate card: a rep can attach a card DIRECTLY to a
      // direct-ingest opportunity (no template) via
      // PATCH /opportunities/:id/rate-card; otherwise it comes from the
      // template the opportunity was issued against. Direct attachment
      // wins so it can override a stale template binding. With no card on
      // either, there's genuinely nothing to price — return null and let
      // the caller skip. (docs/direct-ingest.md §3.2 + engagements.rate_card_id)
      const effectiveRateCardId = eng.rateCardId ?? eng.template?.rateCardId ?? null;
      if (!effectiveRateCardId) {
        this.logger.debug(
          `engagement ${engagementId} has no rate card (direct nor template); skipping quote`,
        );
        return null;
      }

      // Pull the rate card out of the regular service so we use the same
      // canonical shape as the manual /quote endpoint. RLS keeps it
      // bounded to this tenant.
      const card = await this.pricing.getById(tenantId, effectiveRateCardId);

      // Template answers are ONE source of scoped entities. A template-less
      // opportunity simply has none here, and pricing falls back entirely
      // to the extraction-inferred + site-enum entities gathered below.
      // Build the answer-derived scope only when a template is attached.
      let scopeFromAnswers: ScopedEntity[] = [];
      if (eng.template) {
        const tmpl: TemplateWithNodes = {
          id: eng.template.id,
          tenantId: eng.template.tenantId,
          serviceLine: eng.template.serviceLine,
          name: eng.template.name,
          version: eng.template.version,
          status: eng.template.status as TemplateWithNodes['status'],
          rootNodeId: eng.template.rootNodeId,
          createdAt: eng.template.createdAt.toISOString(),
          updatedAt: eng.template.updatedAt.toISOString(),
          nodes: eng.template.nodes.map((n) => ({
            id: n.id,
            templateId: n.templateId,
            tenantId: n.tenantId,
            question: n.question,
            helpText: n.helpText,
            placeholder: n.placeholder,
            required: n.required,
            nodeType: n.nodeType as TemplateWithNodes['nodes'][number]['nodeType'],
            options: (n.options as unknown as TemplateWithNodes['nodes'][number]['options']) ?? null,
            allowFiles: n.allowFiles,
            nextRules: (n.nextRules as unknown as TemplateWithNodes['nodes'][number]['nextRules']) ?? [],
            position: n.position,
            parentNodeId: n.parentNodeId ?? null,
            loopConfig: (n.loopConfig as unknown as TemplateWithNodes['nodes'][number]['loopConfig']) ?? null,
            binding: (n.binding as unknown as TemplateWithNodes['nodes'][number]['binding']) ?? null,
          })),
        };

        // Build the (nodeId → iter → answer) map the normaliser expects.
        const answersByIter: AnswersByIter = new Map();
        for (const a of eng.answers) {
          const inner = answersByIter.get(a.nodeId) ?? new Map<number, Answer>();
          inner.set(a.iterationIndex, a.answer as Answer);
          answersByIter.set(a.nodeId, inner);
        }

        scopeFromAnswers = normaliseScope(tmpl, card, answersByIter);
      }

      // Supplementary input: cached Layer-3 inference from extracted
      // documents. The mapper ran once at extraction time and stored
      // its output on engagement_files.inferred_entities; we just
      // read + filter to confidence-passing entries here. This is
      // what makes Re-predict instant and rate-limit-free — no LLM
      // call on the quote path.
      //
      // Conflict rule: a service line answered by the form ALWAYS
      // wins over its extraction-derived counterpart. The mapper
      // only fills genuine gaps. That preserves "client typed it"
      // as ground truth and avoids surprises when an extraction
      // misreads a value.
      // Warn loudly when extraction is still in flight. We don't refuse
      // to compute (the rep may have manually triggered re-predict to
      // see partial state) but the log makes it discoverable why a
      // quote is light. P0-5 in see-that-is-self-sunny-honey.md.
      const inFlightFiles = await db.engagementFile.count({
        where: {
          engagementId,
          extractionStatus: { in: ['pending', 'processing', 'retry_queued'] },
        },
      });
      if (inFlightFiles > 0) {
        this.logger.warn(
          `engagement ${engagementId}: computing quote while ${inFlightFiles} file(s) ` +
            `still extracting. Inferred entities from those files won't be in this quote — ` +
            `re-run after extraction settles.`,
        );
      }

      const extractedFiles = await db.engagementFile.findMany({
        where: { engagementId, extractionStatus: 'ready' },
        select: { inferredEntities: true },
      });
      const allInferred: InferredEntity[] = extractedFiles.flatMap((f) =>
        Array.isArray(f.inferredEntities)
          ? (f.inferredEntities as unknown as InferredEntity[])
          : [],
      );

      // Convert + filter to confidence-passing ScopedEntity[].
      const extractionEntities = this.fieldMapper.toScopedEntities(allInferred, card);

      // Site-enumeration supplementary input: when the rep ran the site
      // crawler against the prospect's existing site, the mapper cached
      // a per-rate-card snapshot of the resulting ScopedEntity[]. Read
      // it here so the same engagement quote includes whatever the site
      // enum surfaced (API endpoints, form fields, integrations) — same
      // merge rule as extraction (form answers always win, site-enum
      // supplements when slug isn't covered).
      const siteEnumRow = await db.siteEnumeration.findUnique({
        where: { engagementId },
        select: { inferredEntities: true },
      });
      const siteEnumEntities: ScopedEntity[] = readSiteEnumEntitiesFor(
        siteEnumRow?.inferredEntities,
        card.id,
      );

      // Merge: form answers are ground-truth for the iterations they
      // cover. Extraction's surplus (when the doc describes more apps
      // than the form filled out) gets folded in as additional
      // iterations rather than dropped — so a doc describing 5 web
      // apps still contributes apps 3-5 even if the form only walked
      // 1 and 2.
      //
      // Per-slug accounting: count how many entities the form has for
      // each slug, then keep extraction entities beyond that count.
      const formSlugCount = new Map<string, number>();
      for (const e of scopeFromAnswers) {
        formSlugCount.set(e.serviceLineSlug, (formSlugCount.get(e.serviceLineSlug) ?? 0) + 1);
      }
      const seenExtra = new Map<string, number>();
      const supplementary: typeof extractionEntities = [];
      const suppressed: typeof extractionEntities = [];
      for (const e of extractionEntities) {
        const formN = formSlugCount.get(e.serviceLineSlug) ?? 0;
        const seen = seenExtra.get(e.serviceLineSlug) ?? 0;
        if (seen < formN) {
          // The form already has an answer for this slug+iteration;
          // form wins. Mark as suppressed for telemetry.
          suppressed.push(e);
        } else {
          // Extraction adds an iteration the form didn't cover.
          supplementary.push(e);
        }
        seenExtra.set(e.serviceLineSlug, seen + 1);
      }
      if (suppressed.length > 0) {
        const bySlug = new Map<string, number>();
        for (const e of suppressed) bySlug.set(e.serviceLineSlug, (bySlug.get(e.serviceLineSlug) ?? 0) + 1);
        const summary = [...bySlug.entries()].map(([slug, n]) => `${slug}×${n}`).join(', ');
        this.logger.warn(
          `engagement ${engagementId}: form answers covered slugs that doc inference also produced; ` +
            `dropped ${suppressed.length} extraction entit${suppressed.length === 1 ? 'y' : 'ies'} (${summary}). ` +
            `If the doc described additional applications the form didn't cover, the rep should add iterations or override.`,
        );
      }
      if (supplementary.length > 0) {
        const bySlug = new Map<string, number>();
        for (const e of supplementary) bySlug.set(e.serviceLineSlug, (bySlug.get(e.serviceLineSlug) ?? 0) + 1);
        const summary = [...bySlug.entries()].map(([slug, n]) => `${slug}×${n}`).join(', ');
        this.logger.log(
          `engagement ${engagementId}: extraction supplemented ${supplementary.length} ` +
            `additional iteration(s) the form didn't cover (${summary})`,
        );
      }
      // Fold site-enum entities in too — same supplement rule applied
      // again, but the "form" baseline now also includes anything
      // extraction supplied (so we don't double-count between the two
      // discovery sources).
      const baselineForSiteEnum = [...scopeFromAnswers, ...supplementary];
      const baselineSlugCount = new Map<string, number>();
      for (const e of baselineForSiteEnum) {
        baselineSlugCount.set(e.serviceLineSlug, (baselineSlugCount.get(e.serviceLineSlug) ?? 0) + 1);
      }
      const seenSiteEnum = new Map<string, number>();
      const siteEnumSupplementary: ScopedEntity[] = [];
      for (const e of siteEnumEntities) {
        const baseN = baselineSlugCount.get(e.serviceLineSlug) ?? 0;
        const seen = seenSiteEnum.get(e.serviceLineSlug) ?? 0;
        if (seen >= baseN) siteEnumSupplementary.push(e);
        seenSiteEnum.set(e.serviceLineSlug, seen + 1);
      }
      if (siteEnumSupplementary.length > 0) {
        const bySlug = new Map<string, number>();
        for (const e of siteEnumSupplementary)
          bySlug.set(e.serviceLineSlug, (bySlug.get(e.serviceLineSlug) ?? 0) + 1);
        const summary = [...bySlug.entries()].map(([slug, n]) => `${slug}×${n}`).join(', ');
        this.logger.log(
          `engagement ${engagementId}: site-enum supplemented ${siteEnumSupplementary.length} ` +
            `entit${siteEnumSupplementary.length === 1 ? 'y' : 'ies'} the form/extraction didn't cover (${summary})`,
        );
      }

      const scope = [...baselineForSiteEnum, ...siteEnumSupplementary];

      const result = computeBasePrice(card, scope);

      // Upsert the row. UNIQUE(engagement_id) means re-running a
      // submission overwrites the previous quote in place.
      const existing = await db.engagementQuote.findUnique({
        where: { engagementId },
        select: { id: true },
      });

      const baseRow = {
        tenantId,
        engagementId,
        rateCardId: card.id,
        rateCardVersion: card.version,
        currency: card.currency,
        baseTotalCents: BigInt(result.totalCents),
        baseBreakdown: result.lines as unknown as object,
      };

      const saved = existing
        ? await db.engagementQuote.update({
            where: { id: existing.id },
            data: { ...baseRow, computedAt: new Date() },
          })
        : await db.engagementQuote.create({ data: baseRow });

      // Mirror the predicted_price for rough back-compat with the older
      // engagements.predicted_price_cents column the UI used to read.
      // The real Stage-3 modifier writes to the dedicated nullable
      // columns on engagement_quotes once the retargeted ML lands.
      if (result.totalCents > 0) {
        await db.engagement.update({
          where: { id: engagementId },
          data: { predictedPriceCents: BigInt(result.totalCents) },
        });
      }

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'quote_computed',
        actorType: 'system',
        actorId: 'pricing',
        payload: {
          rateCardId: card.id,
          rateCardVersion: card.version,
          currency: card.currency,
          baseTotalCents: result.totalCents,
          lineCount: result.lines.length,
          hasManualQuoteRequired: result.hasManualQuoteRequired,
          hasUnmatched: result.hasUnmatched,
        },
      });

      return rowToDomain(saved, result);
    });
  }

  async getForEngagement(tenantId: string, engagementId: string): Promise<PersistedQuote | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagementQuote.findUnique({ where: { engagementId } });
      if (!row) return null;
      const quote = rowToDomain(row);

      // Metadata-only enrichment: surface, per base-scope line, the
      // methodology options the bound rate card actually offers — so the
      // UI can render a domain-agnostic methodology <select> (no hardcoded
      // cyber values). Does NOT touch pricing math; just annotates each
      // already-persisted breakdown line with the distinct methodologies
      // its service line's tiers expose. Resolve the bound card the same
      // way computeAndPersistForEngagement does: direct attachment wins
      // over the template binding.
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { rateCardId: true, template: { select: { rateCardId: true } } },
      });
      const effectiveRateCardId = eng?.rateCardId ?? eng?.template?.rateCardId ?? null;
      if (effectiveRateCardId) {
        try {
          // Reuse the same canonical loader computeBasePrice uses.
          const card = await this.pricing.getById(tenantId, effectiveRateCardId);
          const methodsBySlug = new Map<string, string[]>();
          for (const sl of card.serviceLines) {
            const distinct = [
              ...new Set(
                sl.tiers
                  .map((t) => t.methodology)
                  .filter((m): m is string => m !== null && m !== undefined),
              ),
            ].sort();
            methodsBySlug.set(sl.slug, distinct);
          }
          quote.baseBreakdown = quote.baseBreakdown.map((line) => ({
            ...line,
            allowedMethodologies: methodsBySlug.get(line.serviceLineSlug) ?? [],
          }));
        } catch {
          // A missing/archived card shouldn't break the approval read —
          // fall back to empty pickers (wildcard / no choice) per line.
          quote.baseBreakdown = quote.baseBreakdown.map((line) => ({
            ...line,
            allowedMethodologies: [],
          }));
        }
      } else {
        quote.baseBreakdown = quote.baseBreakdown.map((line) => ({
          ...line,
          allowedMethodologies: [],
        }));
      }

      return quote;
    });
  }

  /**
   * Tech-team pre-approval price adjustment. Records the adjusted price
   * + note on the engagement_quotes row (bound to the prediction so a
   * later re-predict invalidates it), then emits a price_tech_adjusted
   * thread event for audit. Does NOT change engagement status — the
   * presence of techAdjustedPriceCents is enough signal for the manager
   * UI to show it as an additional approval option.
   */
  async techAdjust(
    tenantId: string,
    engagementId: string,
    args: {
      predictionId: string;
      adjustedPriceCents: number;
      note: string | null;
      adjustedBy: string;
    },
  ): Promise<PersistedQuote> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagementQuote.findUnique({ where: { engagementId } });
      if (!row) throw new NotFoundException('quote_not_found');

      // Sanity: the prediction must belong to this engagement so an
      // adjustment can't be misattributed.
      const pred = await db.prediction.findUnique({
        where: { id: args.predictionId },
        select: { id: true, engagementId: true, basePriceCents: true, predictedPriceCents: true },
      });
      if (!pred || pred.engagementId !== engagementId) {
        throw new NotFoundException('prediction_not_found_for_engagement');
      }

      const now = new Date();
      const updated = await db.engagementQuote.update({
        where: { id: row.id },
        data: {
          techAdjustedPriceCents: BigInt(args.adjustedPriceCents),
          techAdjustedAt: now,
          techAdjustedBy: args.adjustedBy,
          techAdjustmentNote: args.note,
          techAdjustedPredictionId: args.predictionId,
        },
      });

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'price_tech_adjusted',
        actorType: 'user',
        actorId: args.adjustedBy,
        payload: {
          predictionId: args.predictionId,
          basePriceCents: Number(pred.basePriceCents),
          predictedPriceCents: Number(pred.predictedPriceCents),
          adjustedPriceCents: args.adjustedPriceCents,
          ...(args.note ? { note: args.note } : {}),
        },
      });

      return rowToDomain(updated);
    });
  }

  async approve(
    tenantId: string,
    engagementId: string,
    args: { approvedPriceCents: number; approvedBy: string },
  ): Promise<PersistedQuote> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagementQuote.findUnique({ where: { engagementId } });
      if (!row) throw new NotFoundException('quote_not_found');
      const updated = await db.engagementQuote.update({
        where: { id: row.id },
        data: {
          approvedPriceCents: BigInt(args.approvedPriceCents),
          approvedAt: new Date(),
          approvedBy: args.approvedBy,
        },
      });
      // Mirror the approved price onto the engagement so the proposal
      // and Odoo sync read a single field.
      await db.engagement.update({
        where: { id: engagementId },
        data: { approvedPriceCents: BigInt(args.approvedPriceCents) },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'quote_approved',
        actorType: 'user',
        actorId: args.approvedBy,
        payload: {
          approvedPriceCents: args.approvedPriceCents,
          baseTotalCents: Number(row.baseTotalCents),
          predictedPriceCents:
            row.predictedPriceCents == null ? null : Number(row.predictedPriceCents),
        },
      });
      void this.thread.dispatchAfterCommit(tenantId, {
        engagementId,
        eventType: 'quote_approved',
        actorType: 'user',
        actorId: args.approvedBy,
        payload: {
          approvedPriceCents: args.approvedPriceCents,
        },
      });
      return rowToDomain(updated);
    });
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface DbQuote {
  id: string;
  engagementId: string;
  rateCardId: string | null;
  rateCardVersion: number;
  currency: string;
  baseTotalCents: bigint;
  baseBreakdown: unknown;
  predictedAdjustmentPct: { toString(): string } | null;
  predictedPriceCents: bigint | null;
  predictedBandLowCents: bigint | null;
  predictedBandHighCents: bigint | null;
  winProbability: { toString(): string } | null;
  modifierDrivers: unknown;
  techAdjustedPriceCents: bigint | null;
  techAdjustedAt: Date | null;
  techAdjustedBy: string | null;
  techAdjustmentNote: string | null;
  techAdjustedPredictionId: string | null;
  approvedPriceCents: bigint | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  computedAt: Date;
}

function rowToDomain(row: DbQuote, _result?: BasePriceResult): PersistedQuote {
  return {
    id: row.id,
    engagementId: row.engagementId,
    rateCardId: row.rateCardId,
    rateCardVersion: row.rateCardVersion,
    currency: row.currency,
    baseTotalCents: Number(row.baseTotalCents),
    baseBreakdown: row.baseBreakdown as PersistedQuote['baseBreakdown'],
    predictedAdjustmentPct:
      row.predictedAdjustmentPct === null ? null : Number(row.predictedAdjustmentPct.toString()),
    predictedPriceCents: row.predictedPriceCents === null ? null : Number(row.predictedPriceCents),
    predictedBandLowCents:
      row.predictedBandLowCents === null ? null : Number(row.predictedBandLowCents),
    predictedBandHighCents:
      row.predictedBandHighCents === null ? null : Number(row.predictedBandHighCents),
    winProbability:
      row.winProbability === null ? null : Number(row.winProbability.toString()),
    modifierDrivers: row.modifierDrivers ?? null,
    techAdjustedPriceCents:
      row.techAdjustedPriceCents === null ? null : Number(row.techAdjustedPriceCents),
    techAdjustedAt: row.techAdjustedAt?.toISOString() ?? null,
    techAdjustedBy: row.techAdjustedBy ?? null,
    techAdjustmentNote: row.techAdjustmentNote ?? null,
    techAdjustedPredictionId: row.techAdjustedPredictionId ?? null,
    approvedPriceCents:
      row.approvedPriceCents === null ? null : Number(row.approvedPriceCents),
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy ?? null,
    computedAt: row.computedAt.toISOString(),
  };
}

// Suppress unused-import warnings for re-exports the DI graph wires up.
void Object.create({} as { _t?: PrismaTx; _e?: ScopedEntity; _c?: CustomerType; _m?: Methodology });

/** Read the cached ScopedEntity[] from `SiteEnumeration.inferredEntities`
 *  for the supplied rate-card id.
 *
 *  The mapper persists snapshots keyed by rate-card id:
 *    `{ [rateCardId]: { entities: ScopedEntity[], computedAt: string } }`
 *
 *  We only return the snapshot for THIS rate card — different rate
 *  cards may map the same site differently (different slugs, different
 *  methodologies). Returns `[]` when no snapshot exists yet (caller
 *  must have run `mapToRateCard` once for this rate card). */
export function readSiteEnumEntitiesFor(
  raw: unknown,
  rateCardId: string,
): ScopedEntity[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const snap = obj[rateCardId];
  if (!snap || typeof snap !== 'object') return [];
  const entities = (snap as { entities?: unknown }).entities;
  if (!Array.isArray(entities)) return [];
  return entities.filter((e): e is ScopedEntity =>
    !!e && typeof e === 'object' &&
    typeof (e as { entityId?: unknown }).entityId === 'string' &&
    typeof (e as { serviceLineSlug?: unknown }).serviceLineSlug === 'string' &&
    !!(e as { dimensions?: unknown }).dimensions,
  );
}
