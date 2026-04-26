/**
 * Prediction orchestrator (Sprint 1: cold_start + rules regimes).
 *
 *   predictForEngagement → loads engagement scope, computes base price,
 *     reads tenant_pricing_config, counts closed engagements + client
 *     history, picks regime via the shared cascade, calls the pure
 *     adjustment kernel, writes an APPEND row to predictions, emits
 *     price_predicted into the audit chain.
 *
 *   listForEngagement / latestForEngagement → read-side helpers backing
 *     the controller; predictions is append-only so "latest" = max
 *     created_at.
 *
 * Important invariants:
 *   1. closedEngagementCountSnapshot is set on the engagement at the FIRST
 *      prediction time and never changed thereafter — so a re-predict
 *      months later doesn't shift regime under the row's feet.
 *   2. The function is idempotent across same-regime same-base inputs in
 *      the sense that the math is pure; only the persisted row's id +
 *      created_at differ. Re-predict deliberately writes a fresh row
 *      (the table is append-only).
 *   3. ML predict (apps/ml) is intentionally NOT called here — once the
 *      linear/boosted regimes ship, this orchestrator will dispatch into
 *      that path. For sprint 1 the cascade tops out at rules.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  composePrediction,
  computeAdjustment,
  selectRegime,
  type BasePriceResult,
  type ClientHistorySnapshot,
  type LoyaltyRule,
  type ManualModifier,
  type PredictionDriver,
  type PredictionResult,
  type Regime,
  type TenantPricingConfig,
} from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { QuoteService } from './quote.service.js';

/** Lifecycle states that count as "closed" for regime selection. */
const CLOSED_STATUSES = ['approved', 'sent', 'closed'] as const;

export interface PersistedPrediction {
  id: string;
  engagementId: string;
  regime: Regime;
  basePriceCents: number;
  predictedPriceCents: number;
  adjustmentPct: number;
  bandLowCents: number;
  bandHighCents: number;
  drivers: PredictionDriver[];
  similarPast: unknown[];
  dataQuality: Record<string, unknown>;
  createdAt: string;
}

@Injectable()
export class PredictionService {
  private readonly logger = new Logger(PredictionService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly quotes: QuoteService,
  ) {}

  async predictForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<PersistedPrediction> {
    // 1. Make sure we have a base price to adjust against. computeAndPersist
    //    is idempotent; on a re-predict it just refreshes the quote row.
    const quote = await this.quotes.computeAndPersistForEngagement(tenantId, engagementId);
    if (!quote) {
      throw new NotFoundException('rate_card_not_bound');
    }
    const base: BasePriceResult = {
      rateCardId: quote.rateCardId ?? '',
      rateCardVersion: quote.rateCardVersion,
      currency: quote.currency,
      totalCents: quote.baseTotalCents,
      lines: quote.baseBreakdown,
      hasManualQuoteRequired: quote.baseBreakdown.some((l) => l.manualQuoteRequired),
      hasUnmatched: quote.baseBreakdown.some((l) => l.unmatched),
    };

    // 2. Gather the inputs for regime selection + the rules engine in one
    //    transaction so the snapshot is consistent.
    const ctx = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, clientEmail: true, closedEngagementCountSnapshot: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      // Load (or seed) the tenant pricing config. First-time predict
      // creates a row with the defaults so admins always have something
      // to PATCH against.
      const config = await db.tenantPricingConfig.upsert({
        where: { tenantId },
        create: { tenantId },
        update: {},
      });

      const closedCount = await db.engagement.count({
        where: { status: { in: [...CLOSED_STATUSES] } },
      });

      // Client history snapshot — aggregate over prior closed engagements
      // for the same client_email (RLS keeps it tenant-scoped).
      const closedForClient = await db.engagement.findMany({
        where: {
          clientEmail: eng.clientEmail,
          status: { in: [...CLOSED_STATUSES] },
          NOT: { id: engagementId },
        },
        select: { approvedPriceCents: true, closedAt: true },
        orderBy: { closedAt: 'desc' },
      });
      const lifetimeValueCents = closedForClient.reduce(
        (acc, r) => acc + (r.approvedPriceCents == null ? 0 : Number(r.approvedPriceCents)),
        0,
      );

      const history: ClientHistorySnapshot = {
        totalClosedDeals: closedForClient.length,
        lifetimeValueCents,
        lastCloseAt: closedForClient[0]?.closedAt?.toISOString() ?? null,
      };

      // Pin the snapshot exactly once so future re-predicts are stable.
      // If the engagement already has one, we reuse it — admin re-predicts
      // shouldn't shift regime mid-deal.
      const pinnedClosedCount =
        eng.closedEngagementCountSnapshot ?? closedCount;
      if (eng.closedEngagementCountSnapshot == null) {
        await db.engagement.update({
          where: { id: engagementId },
          data: { closedEngagementCountSnapshot: closedCount },
        });
      }

      return { config, closedCount: pinnedClosedCount, history };
    });

    // 3. Pure compute.
    const sharedConfig: TenantPricingConfig = {
      loyaltyRules: (ctx.config.loyaltyRules as unknown as LoyaltyRule[]) ?? [],
      manualModifiers: (ctx.config.manualModifiers as unknown as ManualModifier[]) ?? [],
      coldStartUntilNClosed: ctx.config.coldStartUntilNClosed,
      rulesUntilNClosed: ctx.config.rulesUntilNClosed,
      linearUntilNClosed: ctx.config.linearUntilNClosed,
      retrainHourUtc: ctx.config.retrainHourUtc,
    };
    const regime = selectRegime(ctx.closedCount, sharedConfig);

    // Sprint 1 only implements cold_start + rules. Anything beyond is
    // fed back to cold_start with a log line so the system stays usable
    // for tenants whose data passes the threshold before ML ships. The
    // pure kernel would otherwise throw `regime_not_implemented`.
    const effectiveRegime: Regime = regime === 'cold_start' || regime === 'rules'
      ? regime
      : 'rules';
    if (effectiveRegime !== regime) {
      this.logger.log(
        `regime ${regime} not yet implemented; falling back to rules for engagement ${engagementId}`,
      );
    }

    const adjustment = computeAdjustment(base, effectiveRegime, sharedConfig, ctx.history);
    const composed: PredictionResult = composePrediction(base, adjustment);

    // 4. Persist + emit. New row every time (append-only).
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.prediction.create({
        data: {
          tenantId,
          engagementId,
          regime: composed.regime,
          basePriceCents: BigInt(composed.basePriceCents),
          predictedPriceCents: BigInt(composed.predictedPriceCents),
          adjustmentPct: composed.adjustmentPct.toFixed(4),
          bandLowCents: BigInt(composed.bandLowCents),
          bandHighCents: BigInt(composed.bandHighCents),
          drivers: composed.drivers as unknown as object,
          similarPast: [],
          dataQuality: {
            closedUsed: ctx.closedCount,
            regimeRequested: regime,
            lifetimeValueCents: ctx.history.lifetimeValueCents,
          },
        },
      });

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'price_predicted',
        actorType: 'system',
        actorId: 'pricing',
        payload: {
          predictionId: row.id,
          regime: composed.regime,
          basePriceCents: composed.basePriceCents,
          predictedPriceCents: composed.predictedPriceCents,
          adjustmentPct: composed.adjustmentPct,
          driverCount: composed.drivers.length,
        },
      });

      return rowToDomain(row);
    });
  }

  async listForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<PersistedPrediction[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.prediction.findMany({
        where: { engagementId },
        orderBy: { createdAt: 'desc' },
      });
      return rows.map(rowToDomain);
    });
  }

  async latestForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<PersistedPrediction | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.prediction.findFirst({
        where: { engagementId },
        orderBy: { createdAt: 'desc' },
      });
      return row ? rowToDomain(row) : null;
    });
  }

  async findById(
    tenantId: string,
    predictionId: string,
  ): Promise<PersistedPrediction | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.prediction.findUnique({ where: { id: predictionId } });
      return row ? rowToDomain(row) : null;
    });
  }
}

interface DbPrediction {
  id: string;
  engagementId: string;
  regime: string;
  basePriceCents: bigint;
  predictedPriceCents: bigint;
  adjustmentPct: { toString(): string };
  bandLowCents: bigint;
  bandHighCents: bigint;
  drivers: unknown;
  similarPast: unknown;
  dataQuality: unknown;
  createdAt: Date;
}

function rowToDomain(r: DbPrediction): PersistedPrediction {
  return {
    id: r.id,
    engagementId: r.engagementId,
    regime: r.regime as Regime,
    basePriceCents: Number(r.basePriceCents),
    predictedPriceCents: Number(r.predictedPriceCents),
    adjustmentPct: Number(r.adjustmentPct.toString()),
    bandLowCents: Number(r.bandLowCents),
    bandHighCents: Number(r.bandHighCents),
    drivers: (r.drivers as PredictionDriver[]) ?? [],
    similarPast: (r.similarPast as unknown[]) ?? [],
    dataQuality: (r.dataQuality as Record<string, unknown>) ?? {},
    createdAt: r.createdAt.toISOString(),
  };
}
