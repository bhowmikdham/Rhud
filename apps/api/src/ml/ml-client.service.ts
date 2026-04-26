import { Injectable, Logger } from '@nestjs/common';

/**
 * Client for the FastAPI ML service. Lives in `apps/ml`, talks plain JSON.
 *
 * Posture: best-effort + non-blocking. The Engagements/Gathering flows must
 * never fail because the ML service is down — a missed prediction is fixable
 * by re-submitting; a 500 on submit is not. So `predict()` returns null on
 * any failure, the caller logs the metric, and life goes on.
 */
export interface MlPredictResult {
  predictedPriceCents: number;
  priceLowCents: number;
  priceHighCents: number;
  confidence: number;
  topKSimilar: Array<{ score: number; priceCents: number; scopeSummary: string }>;
  modelVersion: number;
  coldStart: boolean;
  /** Modifier-mode: ratio - 1 (e.g. -0.08 for an 8% discount). null otherwise. */
  adjustmentPct: number | null;
  mode: 'modifier' | 'absolute';
}

export interface MlTrainRecord {
  scopeFields: Record<string, unknown>;
  finalPrice: number; // dollars
  /** Required for the modifier model; optional otherwise. */
  basePrice?: number; // dollars
  serviceLine?: string;
  closedAt?: string;
  wonLost?: boolean;
}

export interface MlTrainResult {
  sequence: number;
  nTrain: number;
  active: boolean;
  coldStart: boolean;
  maeCents: number | null;
  rmseCents: number | null;
  medianPriceCents: number;
}

export interface MlModelMeta {
  sequence: number;
  trainedAt: string;
  nTrain: number;
  mae: number | null;
  rmse: number | null;
  active: boolean;
}

export interface MlStatus {
  activeSequence: number | null;
  activeMeta: MlModelMeta | null;
  history: MlModelMeta[];
}

@Injectable()
export class MlClient {
  private readonly logger = new Logger(MlClient.name);
  private readonly baseUrl = process.env.ML_SERVICE_URL ?? 'http://localhost:8001';

  async predict(args: {
    tenantId: string;
    engagementId: string;
    scope: Record<string, unknown>;
    /**
     * Stage-2 deterministic base price. Required for modifier-mode
     * models (Pricing PDF §3.4); ignored by absolute-mode models.
     */
    basePriceCents?: number;
  }): Promise<MlPredictResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/predict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: args.tenantId,
          engagement_id: args.engagementId,
          scope: args.scope,
          ...(args.basePriceCents !== undefined ? { base_price_cents: args.basePriceCents } : {}),
        }),
      });
      if (!res.ok) {
        // 409 = no_active_model — common before any tenant has trained.
        // Logged at info, not error, so it doesn't cry wolf in dashboards.
        if (res.status === 409) {
          this.logger.log(`predict skipped: no model for tenant ${args.tenantId}`);
        } else {
          const body = await res.text().catch(() => '');
          this.logger.warn(`ml predict ${res.status}: ${body.slice(0, 200)}`);
        }
        return null;
      }
      const j = (await res.json()) as Record<string, unknown>;
      return {
        predictedPriceCents: Number(j['predicted_price_cents']),
        priceLowCents: Number(j['price_low_cents']),
        priceHighCents: Number(j['price_high_cents']),
        confidence: Number(j['confidence']),
        topKSimilar: ((j['top_k_similar'] ?? []) as Array<Record<string, unknown>>).map((t) => ({
          score: Number(t['score']),
          priceCents: Number(t['price_cents']),
          scopeSummary: String(t['scope_summary']),
        })),
        modelVersion: Number(j['model_version']),
        coldStart: Boolean(j['cold_start']),
        adjustmentPct: j['adjustment_pct'] === null || j['adjustment_pct'] === undefined
          ? null : Number(j['adjustment_pct']),
        mode: typeof j['mode'] === 'string' ? (j['mode'] as 'modifier' | 'absolute') : 'absolute',
      };
    } catch (err) {
      this.logger.warn(`ml predict failed: ${(err as Error).message}`);
      return null;
    }
  }

  async train(args: {
    tenantId: string;
    records: MlTrainRecord[];
  }): Promise<MlTrainResult | null> {
    try {
      const res = await fetch(`${this.baseUrl}/train`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tenant_id: args.tenantId,
          records: args.records.map((r) => ({
            scope_fields: r.scopeFields,
            final_price: r.finalPrice,
            ...(r.basePrice !== undefined ? { base_price: r.basePrice } : {}),
            service_line: r.serviceLine,
            closed_at: r.closedAt,
            won_lost: r.wonLost,
          })),
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(`ml train ${res.status}: ${body.slice(0, 300)}`);
        return null;
      }
      const j = (await res.json()) as Record<string, unknown>;
      return {
        sequence: Number(j['sequence']),
        nTrain: Number(j['n_train']),
        active: Boolean(j['active']),
        coldStart: Boolean(j['cold_start']),
        maeCents: j['mae_cents'] == null ? null : Number(j['mae_cents']),
        rmseCents: j['rmse_cents'] == null ? null : Number(j['rmse_cents']),
        medianPriceCents: Number(j['median_price_cents']),
      };
    } catch (err) {
      this.logger.warn(`ml train failed: ${(err as Error).message}`);
      return null;
    }
  }

  async status(tenantId: string): Promise<MlStatus | null> {
    try {
      const res = await fetch(
        `${this.baseUrl}/tenants/${encodeURIComponent(tenantId)}/models`,
      );
      if (!res.ok) {
        this.logger.warn(`ml status ${res.status}`);
        return null;
      }
      const j = (await res.json()) as {
        active_sequence: number | null;
        active_meta: Record<string, unknown> | null;
        history: Array<Record<string, unknown>>;
      };
      const toMeta = (m: Record<string, unknown>): MlModelMeta => ({
        sequence: Number(m['sequence']),
        trainedAt: String(m['trained_at']),
        nTrain: Number(m['n_train']),
        mae: m['mae'] == null ? null : Number(m['mae']),
        rmse: m['rmse'] == null ? null : Number(m['rmse']),
        active: Boolean(m['active']),
      });
      return {
        activeSequence: j.active_sequence,
        activeMeta: j.active_meta ? toMeta(j.active_meta) : null,
        history: (j.history ?? []).map(toMeta),
      };
    } catch (err) {
      this.logger.warn(`ml status failed: ${(err as Error).message}`);
      return null;
    }
  }
}
