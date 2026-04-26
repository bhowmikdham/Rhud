import { Injectable, Logger } from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { MlClient, type MlTrainRecord } from './ml-client.service.js';

/**
 * Orchestration around the FastAPI ML service.
 *
 * Two flows:
 *
 * 1. `predictForEngagement` — called from the gathering layer when scope is
 *    submitted. Reads the engagement's answers, ships them to /predict,
 *    persists the band on the engagement row, emits a `price_predicted`
 *    thread event. Tolerates ML downtime: if /predict returns null we just
 *    log and return — the engagement stays in `submitted` and an admin can
 *    re-trigger later.
 *
 * 2. `train` — admin pushes historical quotes (via API), we call /train,
 *    return the result so the UI can show MAE / cold-start status.
 */
@Injectable()
export class MlService {
  private readonly logger = new Logger(MlService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly ml: MlClient,
  ) {}

  async predictForEngagement(tenantId: string, engagementId: string): Promise<void> {
    const ctx = await this.tenantDb.run(tenantId, async (db) => {
      const ans = await db.engagementAnswer.findMany({
        where: { engagementId },
        select: { nodeId: true, answer: true },
      });
      const dict: Record<string, unknown> = {};
      for (const a of ans) dict[a.nodeId] = a.answer;
      // Pull the base price from the persisted Stage-2 quote so the
      // modifier model lands on a deterministic anchor. Falls back to
      // null when there's no rate card bound (quote skipped).
      const quote = await db.engagementQuote.findUnique({
        where: { engagementId },
        select: { baseTotalCents: true },
      });
      return {
        scope: dict,
        basePriceCents: quote ? Number(quote.baseTotalCents) : null,
      };
    });

    if (Object.keys(ctx.scope).length === 0) {
      this.logger.log(`predict skipped: engagement ${engagementId} has no answers yet`);
      return;
    }

    const result = await this.ml.predict({
      tenantId,
      engagementId,
      scope: ctx.scope,
      ...(ctx.basePriceCents !== null ? { basePriceCents: ctx.basePriceCents } : {}),
    });
    if (!result) return; // logged inside the client

    // Persist the band onto the engagement (legacy fields the existing
    // UI reads) AND onto the engagement_quotes row (where the new manager
    // approval card reads from). Both paths converge here.
    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagement.update({
        where: { id: engagementId },
        data: {
          predictedPriceCents: BigInt(result.predictedPriceCents),
          priceLowCents: BigInt(result.priceLowCents),
          priceHighCents: BigInt(result.priceHighCents),
          status: 'predicted',
        },
      });
      await db.engagementQuote.updateMany({
        where: { engagementId },
        data: {
          predictedPriceCents: BigInt(result.predictedPriceCents),
          predictedBandLowCents: BigInt(result.priceLowCents),
          predictedBandHighCents: BigInt(result.priceHighCents),
          predictedAdjustmentPct: result.adjustmentPct ?? null,
          winProbability: result.confidence,
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'price_predicted',
        actorType: 'system',
        actorId: 'ml',
        payload: {
          predictedPriceCents: result.predictedPriceCents,
          priceLowCents: result.priceLowCents,
          priceHighCents: result.priceHighCents,
          confidence: result.confidence,
          modelVersion: result.modelVersion,
          coldStart: result.coldStart,
          topK: result.topKSimilar.slice(0, 3),
        },
      });
    });

    void this.thread.dispatchAfterCommit(tenantId, {
      engagementId,
      eventType: 'price_predicted',
      actorType: 'system',
      actorId: 'ml',
      payload: {
        predictedPriceCents: result.predictedPriceCents,
        priceLowCents: result.priceLowCents,
        priceHighCents: result.priceHighCents,
        confidence: result.confidence,
      },
    });
  }

  /**
   * Train this tenant's model from a list of historical quote records.
   * Records come from the admin's CSV upload (or, in v1.1, an Odoo pull).
   */
  async train(tenantId: string, records: MlTrainRecord[]) {
    return this.ml.train({ tenantId, records });
  }

  async status(tenantId: string) {
    return this.ml.status(tenantId);
  }
}
