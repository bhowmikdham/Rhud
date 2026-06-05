'use client';

import { useState } from 'react';
import {
  describeError,
  type ApprovalChoice,
  type EngagementQuote,
  type Prediction,
  type PredictionDriver,
  type Regime,
  type ThreadEventRow,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Overlay } from '@/components/overlay';
import { useConfirm } from '@/components/confirm';
import { formatMoney, currencySymbol, pctLabel } from './format';
import { PriceHero, BreakdownRow } from './price-hero';


// ── Adaptive-pricing approval card ──────────────────────────────────────────
//
// Renders three tiers (or a single tier in cold-start), regime pill,
// drivers list, and the four manager actions. Sits at the heart of the
// opportunity page once a prediction exists.

const REGIME_LABEL: Record<Regime, string> = {
  cold_start: 'Cold start',
  rules: 'Rules',
  linear: 'Linear',
  boosted: 'Boosted',
};

const REGIME_BLURB: Record<Regime, string> = {
  cold_start: 'Not enough closed deals yet — quoting at base, no modifier applied.',
  rules: 'Loyalty rules are driving the recommendation.',
  linear: 'Linear regression — early ML model. Watch the band.',
  boosted: 'Gradient-boosted model with full driver attribution.',
};

export function ApprovalCard(props: {
  prediction: Prediction;
  quote: EngagementQuote | null;
  approverRole: string;
  approved: boolean;
  rejected: boolean;
  approvedPriceCents: number | null;
  onApprove(
    choice: ApprovalChoice,
    extras?: { customPriceCents?: number; comment?: string },
  ): Promise<void>;
  onReject(reason: string): Promise<void>;
  onRevert(): Promise<void>;
  onRepredict(): Promise<void>;
  onTechAdjust(adjustedPriceCents: number, note: string): Promise<void>;
  repredicting: boolean;
  rejectionReason: string | null;
  thread: ThreadEventRow[];
  /** Pricing extras (travel/tools/discounts) changed AFTER the deal was
   *  approved, so the frozen approved price no longer reflects them. Re-exposes
   *  the approve actions and shows the discrepancy. */
  pricingStale?: boolean | undefined;
  /** Signed sum of the pricing extras, in cents (discounts negative). */
  extrasTotalCents?: number | undefined;
  /** baseTotalCents + extrasTotalCents — the grand total shown in the editor. */
  grandTotalCents?: number | undefined;
}) {
  // Phase C split: thin orchestrator. <PriceSummary> is the read-only headline
  // (mountable for any role); <ApprovalActions> holds the interactive pricing
  // controls. Composed here in the same single card + order as before, so the
  // rendered output is unchanged — Phase D mounts the two independently per
  // (stage, role).
  return (
    <div className="card" style={{ padding: 22 }}>
      <PriceSummary
        prediction={props.prediction}
        quote={props.quote}
        approved={props.approved}
        rejected={props.rejected}
        approvedPriceCents={props.approvedPriceCents}
        rejectionReason={props.rejectionReason}
        thread={props.thread}
        pricingStale={props.pricingStale}
      />
      <ApprovalActions
        prediction={props.prediction}
        quote={props.quote}
        approverRole={props.approverRole}
        approved={props.approved}
        rejected={props.rejected}
        approvedPriceCents={props.approvedPriceCents}
        onApprove={props.onApprove}
        onReject={props.onReject}
        onRevert={props.onRevert}
        onRepredict={props.onRepredict}
        onTechAdjust={props.onTechAdjust}
        repredicting={props.repredicting}
        pricingStale={props.pricingStale}
        extrasTotalCents={props.extrasTotalCents}
        grandTotalCents={props.grandTotalCents}
      />
    </div>
  );
}

/** Read-only price headline — PriceHero + regime/status chip + rejection note.
 *  Pure display, safe to mount for any role at the pricing/approval stages. */
export function PriceSummary({
  prediction,
  quote,
  approved,
  rejected,
  approvedPriceCents,
  rejectionReason,
  thread,
  pricingStale,
}: {
  prediction: Prediction;
  quote: EngagementQuote | null;
  approved: boolean;
  rejected: boolean;
  approvedPriceCents: number | null;
  rejectionReason: string | null;
  thread: ThreadEventRow[];
  pricingStale?: boolean | undefined;
}) {
  const currency = quote?.currency ?? 'INR';
  const fmt = (cents: number) => formatMoney(cents, currency);
  // Pull confidence + topK + modelVersion from the most-recent
  // price_predicted event so the hero can surface them. Old-pipeline
  // engagements may not have these fields — render the hero with
  // whatever we've got; the visual still works.
  const pricePredictedEv = [...thread]
    .reverse()
    .find((e) => e.eventType === 'price_predicted');
  const predictedPayload = (pricePredictedEv?.payload ?? {}) as {
    confidence?: number;
    modelVersion?: number;
    topK?: Array<{ score: number; priceCents: number; scopeSummary: string }>;
  };

  return (
    <>
      <PriceHero
        currency={currency}
        predictedCents={prediction.predictedPriceCents}
        bandLowCents={prediction.bandLowCents}
        bandHighCents={prediction.bandHighCents}
        confidence={predictedPayload.confidence ?? null}
        modelVersion={predictedPayload.modelVersion ?? null}
        coldStart={prediction.regime === 'cold_start'}
        topK={predictedPayload.topK ?? []}
        computedAt={prediction.createdAt}
        rateCardVersion={quote?.rateCardVersion ?? null}
        rightSlot={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <RegimePill regime={prediction.regime} dataQuality={prediction.dataQuality} />
            {approved && approvedPriceCents != null
              ? <>
                  <span className="chip ok"><Icon.Check size={11} sw={2.2} />Approved · {fmt(approvedPriceCents)}</span>
                  {pricingStale && <span className="chip warn"><Icon.Clock size={10} />Pricing changed</span>}
                </>
              : rejected
                ? <span className="chip danger"><Icon.X size={10} />Rejected</span>
                : <span className="chip warn"><Icon.Clock size={10} />Awaiting approval</span>}
          </div>
        }
      />

      {rejected && rejectionReason && (
        <div
          style={{
            marginTop: 12, padding: 12,
            background: 'var(--danger-tint)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
            borderRadius: 8, fontSize: 12.5, lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            <Icon.X size={11} /> Rejection note
          </div>
          {rejectionReason}
        </div>
      )}
    </>
  );
}

/** Interactive pricing controls — tier grid, drivers, tech-adjust, custom
 *  override, re-predict, and the reject/revert decision controls. Mounts for
 *  action-owning roles; self-gates the individual buttons by role + status. */
export function ApprovalActions({
  prediction,
  quote,
  approverRole,
  approved,
  rejected,
  approvedPriceCents,
  onApprove,
  onReject,
  onRevert,
  onRepredict,
  onTechAdjust,
  repredicting,
  pricingStale,
  extrasTotalCents,
  grandTotalCents,
}: {
  prediction: Prediction;
  quote: EngagementQuote | null;
  approverRole: string;
  approved: boolean;
  rejected: boolean;
  approvedPriceCents?: number | null;
  onApprove(
    choice: ApprovalChoice,
    extras?: { customPriceCents?: number; comment?: string },
  ): Promise<void>;
  onReject(reason: string): Promise<void>;
  onRevert(): Promise<void>;
  onRepredict(): Promise<void>;
  onTechAdjust(adjustedPriceCents: number, note: string): Promise<void>;
  repredicting: boolean;
  pricingStale?: boolean | undefined;
  extrasTotalCents?: number | undefined;
  grandTotalCents?: number | undefined;
}) {
  const canApprove = approverRole === 'admin' || approverRole === 'sales_manager';
  const isAdmin = approverRole === 'admin';
  const isTechTeam = approverRole === 'tech_team';
  // Tech adjustment is only meaningful when bound to the CURRENT prediction.
  // After a re-predict, the prior adjustment is stale and we hide it.
  const techAdjustedFresh =
    quote?.techAdjustedPriceCents != null
    && quote.techAdjustedPredictionId === prediction.id;
  // Pricing extras changed after approval → the frozen approved price is stale.
  // Re-expose the approve actions so a manager can fold the extras in (which
  // re-runs the VP/CEO threshold gate); the "Approved · X / Pricing changed"
  // chips up top keep the prior decision visible meanwhile.
  const reapproveNeeded = approved && !!pricingStale;
  // Approve/reject are mutually exclusive — once a decision is recorded, hide
  // both action surfaces. Admin gets a "Revert" escape hatch instead. A stale
  // approval is treated as not-yet-decided so the tiers come back.
  const decisionMade = (approved || rejected) && !reapproveNeeded;
  // Signed sum of the pricing extras (discounts negative). The base/recommended/
  // aggressive tiers fold these in on approval (custom/tech-adjusted are verbatim
  // manual totals), so we preview the with-extras result only on those tiers.
  const extras = extrasTotalCents ?? 0;
  const foldsExtras = (c: ApprovalChoice) =>
    c === 'base' || c === 'recommended' || c === 'aggressive';
  const [showReject, setShowReject] = useState(false);
  const [reverting, setReverting] = useState(false);
  const confirm = useConfirm();
  const currency = quote?.currency ?? 'INR';
  const fmt = (cents: number) => formatMoney(cents, currency);

  // Cold-start: collapse to single base tier. Other regimes: three tiers.
  const offers: Array<{
    label: string;
    cents: number;
    sub?: string;
    tone?: 'accent' | 'ok' | 'muted';
    choice: ApprovalChoice;
  }> = [];
  offers.push({
    label: 'Quote at base',
    cents: prediction.basePriceCents,
    sub: prediction.regime === 'cold_start' ? 'Single tier — cold start' : 'No modifier applied',
    tone: 'muted',
    choice: 'base',
  });
  if (prediction.regime !== 'cold_start') {
    if (prediction.predictedPriceCents !== prediction.basePriceCents) {
      offers.push({
        label: 'Recommended',
        cents: prediction.predictedPriceCents,
        sub: pctLabel(prediction.adjustmentPct),
        tone: 'accent',
        choice: 'recommended',
      });
    }
    if (prediction.bandLowCents !== prediction.predictedPriceCents) {
      offers.push({
        label: 'Aggressive',
        cents: prediction.bandLowCents,
        sub: 'Band low — highest win likelihood',
        tone: 'ok',
        choice: 'aggressive',
      });
    }
  }
  if (techAdjustedFresh && quote?.techAdjustedPriceCents != null) {
    offers.push({
      label: 'Tech team',
      cents: quote.techAdjustedPriceCents,
      sub: quote.techAdjustmentNote
        ? `Note: ${quote.techAdjustmentNote}`
        : 'Lodged by tech team',
      tone: 'accent',
      choice: 'tech_adjusted',
    });
  }

  const [override, setOverride] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  async function approve(choice: ApprovalChoice, customCents?: number) {
    setBusy(true);
    try {
      await onApprove(choice, {
        ...(customCents != null ? { customPriceCents: customCents } : {}),
        ...(comment ? { comment } : {}),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {reapproveNeeded && (
        <div
          role="status"
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginTop: 14, padding: '10px 12px', borderRadius: 'var(--radius)',
            background: 'var(--warn-tint)',
            border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
          }}
        >
          <Icon.Clock size={14} aria-hidden style={{ color: 'var(--warn)', flexShrink: 0 }} />
          <span style={{ fontSize: 12.5, color: 'var(--fg)', lineHeight: 1.5 }}>
            <strong style={{ fontWeight: 600 }}>Pricing changed since approval</strong>
            <span style={{ color: 'var(--fg-muted)' }}>
              {' '}—{' '}
              {approvedPriceCents != null ? `approved at ${fmt(approvedPriceCents)}, ` : ''}
              but the current grand total is{' '}
              <b style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                {grandTotalCents != null ? fmt(grandTotalCents) : '—'}
              </b>
              . Re-approve below to fold the extras into the quote &amp; proposal.
            </span>
          </span>
        </div>
      )}
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
            {/* When extras exist, the foldable tiers approve at tier + extras —
                preview that so the manager sees the real number they're locking. */}
            {extras !== 0 && foldsExtras(o.choice) && (
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                with extras →{' '}
                <b style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
                  {fmt(Math.max(0, o.cents + extras))}
                </b>
              </div>
            )}
            {o.sub && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{o.sub}</div>}
            {canApprove && !decisionMade && (
              <button
                className="btn sm accent"
                style={{ marginTop: 8, width: '100%' }}
                disabled={busy}
                onClick={() => void approve(o.choice)}
              >
                {busy ? <span className="spin" /> : <>Approve at this</>}
              </button>
            )}
          </div>
        ))}
      </div>

      {prediction.drivers.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>What moved this number?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {prediction.drivers.map((d) => <DriverRow key={d.feature} driver={d} />)}
          </div>
        </div>
      )}

      {/* Tech team adjustment panel */}
      {isTechTeam && !decisionMade && (
        <TechAdjustPanel
          currency={currency}
          predictedCents={prediction.predictedPriceCents}
          existingAdjustedCents={
            techAdjustedFresh ? quote?.techAdjustedPriceCents ?? null : null
          }
          existingNote={
            techAdjustedFresh ? quote?.techAdjustmentNote ?? null : null
          }
          onSubmit={onTechAdjust}
        />
      )}

      {/* Lodged-adjustment summary visible to managers + the tech team itself.
          When approved, the existing approved chip at the top is enough. */}
      {techAdjustedFresh && !decisionMade && !isTechTeam && quote?.techAdjustedPriceCents != null && (
        <div
          style={{
            marginTop: 12, padding: 10,
            background: 'var(--accent-tint)',
            border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
            borderRadius: 8, fontSize: 12, lineHeight: 1.5,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            <Icon.Edit size={11} /> Tech team lodged {fmt(quote.techAdjustedPriceCents)}
          </div>
          {quote.techAdjustmentNote && (
            <div style={{ color: 'var(--fg-muted)' }}>“{quote.techAdjustmentNote}”</div>
          )}
        </div>
      )}

      {/* Custom override */}
      {canApprove && !decisionMade && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--divider)' }}>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 6 }}>
            Or adjust to a custom price (requires comment):
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ position: 'relative', width: 180 }}>
              <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--fg-subtle)' }}>
                {currencySymbol(currency)}
              </span>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                placeholder="Amount"
                style={{ paddingLeft: 22, fontVariantNumeric: 'tabular-nums' }}
                value={override ?? ''}
                onChange={(e) => setOverride(e.target.value === '' ? null : Number(e.target.value))}
              />
            </div>
            <input
              className="input"
              placeholder="Why this price?"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              style={{ flex: 1, fontSize: 12 }}
            />
            <button
              className="btn sm"
              disabled={
                busy
                || override == null
                || !Number.isFinite(override)
                || override < 0
                || comment.trim().length === 0
              }
              onClick={() => override != null && void approve('custom', Math.round(override * 100))}
            >
              {busy ? <span className="spin" /> : 'Approve override'}
            </button>
          </div>
        </div>
      )}

      {/* Re-predict + breakdown */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 8 }}>
        <details style={{ flex: 1 }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)', userSelect: 'none' }}>
            Why this number?
            {quote && <span style={{ color: 'var(--fg-subtle)' }}> · {quote.baseBreakdown.length} line item(s)</span>}
          </summary>
          {quote && (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {quote.baseBreakdown.map((line, i) => (
                <BreakdownRow key={`${line.entityId}-${i}`} line={line} currency={quote.currency} />
              ))}
              <div style={{ display: 'flex', justifyContent: 'space-between', borderTop: '1px solid var(--divider)', paddingTop: 6, marginTop: 4, fontWeight: 600 }}>
                <span>Base total</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>{fmt(prediction.basePriceCents)}</span>
              </div>
            </div>
          )}
        </details>
        {!isTechTeam && (
          <button
            className="btn sm ghost"
            disabled={repredicting}
            onClick={() => void onRepredict()}
            title="Recompute with the latest rate card + config"
          >
            {repredicting ? <><span className="spin" />Predicting…</> : <><Icon.Sparkle size={11} />Re-predict</>}
          </button>
        )}
      </div>

      {/* Decision controls — reject before any decision; revert after one. */}
      {(canApprove && !decisionMade) || (decisionMade && isAdmin) ? (
        <div style={{
          marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--divider)',
          display: 'flex', justifyContent: 'flex-end', gap: 8,
        }}>
          {canApprove && !decisionMade && (
            <button className="btn sm danger" onClick={() => setShowReject(true)}>
              <Icon.X size={11} /> Reject
            </button>
          )}
          {decisionMade && isAdmin && (
            <button
              className="btn sm ghost"
              disabled={reverting}
              onClick={async () => {
                const ok = await confirm({
                  title: `Revert ${approved ? 'approval' : 'rejection'}?`,
                  body: `The opportunity goes back to "awaiting approval", where you can adjust scope or price before re-approving. Any proposal draft already generated is cleared and rebuilt on re-approval.`,
                  tone: 'warn',
                  confirmLabel: `Revert ${approved ? 'approval' : 'rejection'}`,
                });
                if (!ok) return;
                setReverting(true);
                try { await onRevert(); } finally { setReverting(false); }
              }}
              title="Admin-only — restore to awaiting-approval state"
            >
              {reverting ? <span className="spin" /> : <><Icon.ChevronLeft size={11} /> Revert {approved ? 'approval' : 'rejection'}</>}
            </button>
          )}
        </div>
      ) : null}

      {showReject && (
        <RejectModal
          onCancel={() => setShowReject(false)}
          onConfirm={async (reason) => {
            await onReject(reason);
            setShowReject(false);
          }}
        />
      )}
    </>
  );
}
function RejectModal({
  onCancel,
  onConfirm,
}: {
  onCancel(): void;
  onConfirm(reason: string): Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) return;
    setBusy(true); setErr(null);
    try {
      await onConfirm(reason.trim());
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Overlay onClose={onCancel} busy={busy} label="Reject this opportunity">
      <div className="card" style={{ width: '100%', maxWidth: 460, background: 'var(--bg)' }}>
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Reject this opportunity</div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
            The sales rep gets your note. The engagement&apos;s status moves to <span className="mono">rejected</span>.
          </div>
        </header>
        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Reason (required)</span>
            <textarea
              className="input"
              rows={4}
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Scope is too thin to price — ask the client to clarify the API surface count."
              style={{ fontSize: 13, lineHeight: 1.5, padding: 10 }}
            />
          </label>
          {err && (
            <div style={{
              padding: 10, fontSize: 12.5,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{err}</div>
          )}
        </div>
        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
          <button onClick={submit} disabled={busy || !reason.trim()} className="btn sm danger">
            {busy ? <span className="spin" /> : <><Icon.X size={11} /> Reject</>}
          </button>
        </footer>
      </div>
    </Overlay>
  );
}


function RegimePill({
  regime,
  dataQuality,
}: {
  regime: Regime;
  dataQuality: Record<string, unknown>;
}) {
  const closed = typeof dataQuality.closedUsed === 'number' ? dataQuality.closedUsed : null;
  const tone =
    regime === 'cold_start' ? 'warn'
    : regime === 'rules'    ? 'accent'
    : 'ok';
  return (
    <span
      className={`chip ${tone}`}
      title={REGIME_BLURB[regime]}
      style={{ fontSize: 11 }}
    >
      <Icon.Sparkle size={10} />
      {REGIME_LABEL[regime]}
      {closed != null && ` · ${closed} closed`}
    </span>
  );
}

function DriverRow({ driver }: { driver: PredictionDriver }) {
  const sign = driver.weight === 0 ? '0' : (driver.weight * 100).toFixed(1) + '%';
  const tone =
    driver.direction === 'discount' ? 'var(--ok)'
    : driver.direction === 'premium' ? 'var(--warn)'
    : 'var(--fg-muted)';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', fontSize: 12 }}>
      <span>{driver.label ?? driver.feature}</span>
      <span style={{ color: tone, fontVariantNumeric: 'tabular-nums' }}>
        {driver.weight > 0 ? '+' : ''}{sign}
      </span>
    </div>
  );
}

export function NoPredictionCta({
  quote,
  onRun,
  running,
  canPredict,
}: {
  quote: EngagementQuote;
  onRun: () => Promise<void>;
  running: boolean;
  canPredict: boolean;
}) {
  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="section-label">Base price ready · prediction missing</div>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '6px 0 12px', lineHeight: 1.55 }}>
        Stage-2 base computed at{' '}
        <b style={{ color: 'var(--fg)' }}>{formatMoney(quote.baseTotalCents, quote.currency)}</b>.
        ML prediction either didn&apos;t run or failed silently — the ML service runs fire-and-forget after
        scope submission. <b>Run prediction</b> retries it.
      </p>
      <button className="btn accent" disabled={running || !canPredict} onClick={() => void onRun()}>
        {running ? <><span className="spin" />Predicting…</> : <><Icon.Sparkle size={12} />Run prediction</>}
      </button>
    </div>
  );
}

function TechAdjustPanel({
  currency,
  predictedCents,
  existingAdjustedCents,
  existingNote,
  onSubmit,
}: {
  currency: string;
  predictedCents: number;
  existingAdjustedCents: number | null;
  existingNote: string | null;
  onSubmit(adjustedPriceCents: number, note: string): Promise<void>;
}) {
  const start = existingAdjustedCents ?? predictedCents;
  const [amount, setAmount] = useState<number | ''>(start / 100);
  const [note, setNote] = useState(existingNote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const numeric = typeof amount === 'number' && Number.isFinite(amount) ? amount : null;
  const cents = numeric == null ? null : Math.round(numeric * 100);
  const dirty = cents != null && cents !== existingAdjustedCents;
  const valid = cents != null && cents >= 0 && dirty;

  async function submit() {
    if (!valid || cents == null) return;
    setBusy(true); setErr(null);
    try {
      await onSubmit(cents, note);
      setSavedAt(Date.now());
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--divider)',
      }}
    >
      <div className="section-label" style={{ marginBottom: 6 }}>
        <Icon.Edit size={11} /> Adjust the predicted price
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 10px', lineHeight: 1.55 }}>
        Lodge an adjusted price and the sales manager will review it for approval. This is the
        only action your role has — you can&apos;t approve, reject, or send.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', width: 200 }}>
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--fg-subtle)' }}>
            {currencySymbol(currency)}
          </span>
          <input
            className="input"
            type="number"
            min={0}
            step={1}
            placeholder="Adjusted price"
            style={{ paddingLeft: 22, fontVariantNumeric: 'tabular-nums' }}
            value={amount}
            onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </div>
        <input
          className="input"
          placeholder="Optional note for the manager"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          style={{ flex: 1, minWidth: 180, fontSize: 12 }}
        />
        <button
          className="btn sm accent"
          disabled={busy || !valid}
          onClick={() => void submit()}
        >
          {busy
            ? <span className="spin" />
            : <>{existingAdjustedCents != null ? 'Update lodged price' : 'Lodge adjustment'}</>}
        </button>
      </div>
      {err && (
        <div style={{
          marginTop: 10, padding: 10, fontSize: 12.5,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}
      {savedAt != null && !dirty && !err && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ok)' }}>
          <Icon.Check size={11} sw={2.2} /> Lodged — the sales manager will see your adjustment.
        </div>
      )}
    </div>
  );
}
