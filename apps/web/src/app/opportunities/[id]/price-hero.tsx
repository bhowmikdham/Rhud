'use client';

import { Icon } from '@/components/icon';
import type { BasePriceLine, ThreadEventRow } from '@/lib/api';
import { formatMoney, relativeTime } from './format';

export function BreakdownRow({ line, currency }: { line: BasePriceLine; currency: string }) {
  const fmt = (cents: number) => formatMoney(cents, currency);
  const flag = line.manualQuoteRequired
    ? <span className="chip warn" style={{ fontSize: 10 }}><Icon.Clock size={9} /> manual</span>
    : line.unmatched
      ? <span className="chip" style={{ fontSize: 10, color: 'var(--danger)' }}><Icon.X size={9} /> unmatched</span>
      : null;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6, fontSize: 12 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {line.serviceLineName} {flag}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>
          {line.tierLabel ?? '—'}
          {line.scopeValue > 0 && ` · ${line.scopeValue} ${line.scopeUnit}`}
          {line.methodology && ` · ${line.methodology}`}
          {line.customerType && ` · ${line.customerType}`}
        </div>
      </div>
      <div style={{ fontVariantNumeric: 'tabular-nums', alignSelf: 'center' }}>
        {line.manualQuoteRequired ? '—' : fmt(line.priceCents)}
      </div>
    </div>
  );
}

/**
 * Polished price hero — the visual top of any price-bearing card.
 * Keeps a single source of truth for how the predicted-price headline,
 * confidence, band, and comparable quotes look. Currency-aware: pass
 * the actual currency, not a hardcoded "USD".
 *
 * Used by:
 *   - ApprovalCard (live workflow with approve/reject controls)
 *   - PricePredictionCard (legacy fallback when no Prediction record)
 */
export function PriceHero({
  currency,
  predictedCents,
  bandLowCents,
  bandHighCents,
  confidence,
  modelVersion,
  coldStart,
  topK,
  computedAt,
  rateCardVersion,
  rightSlot,
}: {
  currency: string;
  predictedCents: number;
  bandLowCents: number | null;
  bandHighCents: number | null;
  confidence: number | null;
  modelVersion: number | null;
  coldStart: boolean;
  topK: Array<{ score: number; priceCents: number; scopeSummary: string }>;
  /** ISO date — surfaces a small "Computed Xh ago" subline when set. */
  computedAt?: string | null;
  /** When set, included in the subline as "rate card vN". */
  rateCardVersion?: number | null;
  /** Top-right slot — typically status / regime chips. */
  rightSlot?: React.ReactNode;
}) {
  const fmt = (cents: number) => formatMoney(cents, currency);
  const band =
    bandLowCents != null && bandHighCents != null && predictedCents > 0
      ? Math.round(((bandHighCents - bandLowCents) / 2 / predictedCents) * 100)
      : null;

  return (
    <div className="ml-hero">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div className="ml-label">
            {coldStart ? <span className="pulse" /> : <Icon.Sparkle size={10} />}
            {coldStart ? 'Indicative price · cold-start' : 'Predicted price'}
            {modelVersion != null && (
              <span style={{ color: 'var(--fg-muted)', fontWeight: 500 }}>· model v{modelVersion}</span>
            )}
          </div>
          {computedAt && (
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
              Computed {relativeTime(computedAt)}
              {rateCardVersion != null ? ` · rate card v${rateCardVersion} · ${currency}` : ` · ${currency}`}
            </div>
          )}
        </div>
        {rightSlot}
      </div>

      <div className="ml-price">
        <span className="currency">{currency}</span>
        <span>{fmt(predictedCents)}</span>
        {band != null && <span className="band">± {band}%</span>}
      </div>

      <div className="ml-meta">
        {confidence != null && <span><b>{Math.round(confidence * 100)}%</b> confidence</span>}
        {bandLowCents != null && bandHighCents != null && (
          <>
            {confidence != null && <span>·</span>}
            <span>Band <b className="num">{fmt(bandLowCents)} – {fmt(bandHighCents)}</b></span>
          </>
        )}
        {topK.length > 0 && (
          <>
            {(confidence != null || (bandLowCents != null && bandHighCents != null)) && <span>·</span>}
            <span><b>{topK.length}</b> comparable</span>
          </>
        )}
      </div>

      {coldStart && (
        <div style={{
          marginTop: 14,
          padding: '8px 12px', borderRadius: 8,
          background: 'var(--warn-tint)',
          border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
          fontSize: 12, color: 'var(--fg-muted)',
        }}>
          Cold-start fallback — fewer than 20 historical quotes have been imported.
          Train the model with more data for a tighter band.
        </div>
      )}

      {topK.length > 0 && (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div className="section-label" style={{ marginBottom: 2 }}>Top comparable quotes</div>
          {topK.slice(0, 3).map((t, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 12,
              padding: '8px 0',
              borderBottom: '1px solid var(--divider)',
              fontSize: 12.5, alignItems: 'center',
            }}>
              <div className="cell-muted" style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t.scopeSummary}
              </div>
              <div className="num" style={{ fontWeight: 500 }}>{fmt(t.priceCents)}</div>
              <div className="hist-match" style={{
                fontFamily: 'var(--font-mono)', fontSize: 11,
                color: 'var(--accent)', background: 'var(--accent-tint)',
                padding: '2px 6px', borderRadius: 4,
              }}>
                {Math.round(t.score * 100)}%
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PricePredictionCard({
  pred, lo, hi, thread, currency = 'USD',
}: {
  pred: number;
  lo: number | null;
  hi: number | null;
  thread: ThreadEventRow[];
  currency?: string;
}) {
  // Legacy fallback path — used when an engagement has a stored
  // predictedPriceCents but no Prediction record (older data, before
  // the prediction pipeline landed). Pulls the same metadata shape
  // ApprovalCard does so the hero looks identical in both code paths.
  const ev = [...thread].reverse().find((e) => e.eventType === 'price_predicted');
  const payload = (ev?.payload ?? {}) as {
    confidence?: number;
    coldStart?: boolean;
    modelVersion?: number;
    topK?: Array<{ score: number; priceCents: number; scopeSummary: string }>;
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <PriceHero
        currency={currency}
        predictedCents={pred}
        bandLowCents={lo}
        bandHighCents={hi}
        confidence={payload.confidence ?? null}
        modelVersion={payload.modelVersion ?? null}
        coldStart={!!payload.coldStart}
        topK={payload.topK ?? []}
      />
    </div>
  );
}
