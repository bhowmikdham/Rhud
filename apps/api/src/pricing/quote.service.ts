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
      if (!eng.template.rateCardId) {
        this.logger.debug(`engagement ${engagementId} template has no rate card; skipping quote`);
        return null;
      }

      // Pull the rate card out of the regular service so we use the same
      // canonical shape as the manual /quote endpoint. RLS keeps it
      // bounded to this tenant.
      const card = await this.pricing.getById(tenantId, eng.template.rateCardId);

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

      const scope = normaliseScope(tmpl, card, answersByIter);
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
      return rowToDomain(row);
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
