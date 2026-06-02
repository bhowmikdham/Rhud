'use client';

import { useState } from 'react';
import { Icon } from '@/components/icon';
import type { EngagementQuote } from '@/lib/api';
import { formatMoney, currencySymbol, relativeTime } from './format';
import { BreakdownRow } from './price-hero';

export function QuoteCard({
  quote,
  onApprove,
  approverRole,
}: {
  quote: EngagementQuote;
  onApprove(amountCents: number): Promise<void>;
  approverRole: string;
}) {
  const canApprove = approverRole === 'admin' || approverRole === 'sales_manager';
  const fmt = (cents: number) => formatMoney(cents, quote.currency);
  const baseTotal = quote.baseTotalCents;
  const predicted = quote.predictedPriceCents;
  const bandLow = quote.predictedBandLowCents;
  const bandHigh = quote.predictedBandHighCents;
  const win = quote.winProbability;
  const approved = quote.approvedPriceCents;

  // Three-tier view per PDF §4.1: base / recommended / band low.
  const recommended = predicted ?? baseTotal;
  const offers: Array<{ label: string; cents: number; sub?: string; tone?: 'accent' | 'ok' | 'muted' }> = [
    { label: 'Quote at base',  cents: baseTotal, sub: 'No discount applied', tone: 'muted' },
  ];
  if (predicted != null && predicted !== baseTotal) {
    offers.push({
      label: 'Recommended',
      cents: recommended,
      ...(win != null ? { sub: `${Math.round(win * 100)}% win likelihood` } : {}),
      tone: 'accent',
    });
  }
  if (bandLow != null && bandLow !== recommended) {
    offers.push({ label: 'Band low (aggressive)', cents: bandLow, sub: 'Highest win likelihood', tone: 'ok' });
  }

  const [override, setOverride] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function approve(cents: number) {
    setBusy(true);
    try {
      await onApprove(cents);
    } finally {
      setBusy(false);
    }
  }

  const hasManualLines = quote.baseBreakdown.some((l) => l.manualQuoteRequired);
  const hasUnmatched = quote.baseBreakdown.some((l) => l.unmatched);

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="section-label">Quote</div>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
            Rate card v{quote.rateCardVersion} · {quote.currency} · computed {relativeTime(quote.computedAt)}
          </div>
        </div>
        {approved != null ? (
          <span className="chip ok"><Icon.Check size={11} sw={2.2} /> Approved · {fmt(approved)}</span>
        ) : (
          <span className="chip warn"><Icon.Clock size={10} /> Awaiting approval</span>
        )}
      </div>

      {/* Three-tier view */}
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${offers.length}, 1fr)`, gap: 8, marginTop: 14 }}>
        {offers.map((o) => (
          <div
            key={o.label}
            style={{
              padding: 12,
              borderRadius: 'var(--radius)',
              border: '1px solid var(--divider)',
              background:
                o.tone === 'accent' ? 'var(--accent-tint)'
                : o.tone === 'ok'   ? 'var(--ok-tint)'
                : 'var(--bg-sunk)',
            }}
          >
            <div style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {o.label}
            </div>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4, letterSpacing: '-0.01em' }}>
              {fmt(o.cents)}
            </div>
            {o.sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{o.sub}</div>}
            {canApprove && approved == null && (
              <button
                className="btn sm accent"
                style={{ marginTop: 8, width: '100%' }}
                disabled={busy}
                onClick={() => void approve(o.cents)}
              >
                {busy ? <span className="spin" /> : <>Approve at this</>}
              </button>
            )}
          </div>
        ))}
      </div>

      {predicted == null && (
        <div style={{
          padding: 10, marginTop: 10, fontSize: 11.5, color: 'var(--fg-muted)',
          background: 'var(--bg-sunk)', borderRadius: 6,
        }}>
          <Icon.Sparkle size={11} style={{ marginRight: 4 }} />
          Modifier model not yet activated for this tenant. Quote shown is the deterministic base.
          Per design: import at least 12 months of closed quotes with win/loss labels to enable the recommended view.
        </div>
      )}

      {/* Override input */}
      {canApprove && approved == null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Or override:</span>
          <div style={{ position: 'relative', flex: 1 }}>
            <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--fg-subtle)' }}>
              {currencySymbol(quote.currency)}
            </span>
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              placeholder="Enter approved amount"
              style={{ paddingLeft: 22, fontVariantNumeric: 'tabular-nums' }}
              value={override ?? ''}
              onChange={(e) => setOverride(e.target.value === '' ? null : Number(e.target.value))}
            />
          </div>
          <button
            className="btn sm"
            disabled={busy || override == null || !Number.isFinite(override) || override < 0}
            onClick={() => override != null && void approve(Math.round(override * 100))}
          >
            {busy ? <span className="spin" /> : 'Approve override'}
          </button>
        </div>
      )}

      {/* Line-item breakdown */}
      <details style={{ marginTop: 14 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)', userSelect: 'none' }}>
          Why this number? <span style={{ color: 'var(--fg-subtle)' }}>· {quote.baseBreakdown.length} line item(s)</span>
        </summary>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {quote.baseBreakdown.map((line, i) => (
            <BreakdownRow key={`${line.entityId}-${i}`} line={line} currency={quote.currency} />
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--divider)', paddingTop: 6, marginTop: 4, fontWeight: 600 }}>
            <span>Base total</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(baseTotal)}</span>
          </div>
          {(hasManualLines || hasUnmatched) && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--warn-tint)', borderRadius: 6, fontSize: 11.5, color: 'var(--fg-muted)' }}>
              {hasManualLines && <div><Icon.Clock size={10} /> Some line items require manual quoting (no published rate).</div>}
              {hasUnmatched && <div style={{ marginTop: hasManualLines ? 4 : 0 }}><Icon.X size={10} /> Some scope didn&apos;t match any tier — review before approving.</div>}
            </div>
          )}
        </div>
      </details>

      {bandLow != null && bandHigh != null && (
        <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-subtle)' }}>
          Predicted band: {fmt(bandLow)} – {fmt(bandHigh)}
        </div>
      )}
    </div>
  );
}
