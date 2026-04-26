'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  describeError,
  opportunities,
  predictions,
  quotes,
  type ApprovalChoice,
  type BasePriceLine,
  type EngagementQuote,
  type EngagementSummary,
  type Prediction,
  type PredictionDriver,
  type Regime,
  type ThreadEventRow,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

const EVENT_LABELS: Record<string, string> = {
  link_issued: 'Link issued to client',
  link_opened: 'Client opened the link',
  node_answered: 'Question answered',
  file_uploaded: 'File uploaded',
  scope_submitted: 'Scope submitted',
  price_predicted: 'Price predicted',
  approval_requested: 'Approval requested',
  approval_granted: 'Approved',
  approval_adjusted: 'Approved with adjustment',
  approval_rejected: 'Rejected',
  proposal_draft_requested: 'Drafting proposal',
  proposal_draft_ready: 'Proposal draft ready',
  proposal_sent: 'Proposal sent',
  engagement_synced: 'Synced to Odoo',
  engagement_closed: 'Opportunity closed',
  quote_computed: 'Base quote computed',
  quote_approved: 'Quote approved',
};

const EVENT_ICONS: Partial<Record<string, keyof typeof Icon>> = {
  link_issued: 'Link',
  link_opened: 'Eye',
  node_answered: 'Check',
  file_uploaded: 'Paperclip',
  scope_submitted: 'Send',
  price_predicted: 'Sparkle',
  approval_requested: 'Clock',
  approval_granted: 'Check',
  approval_adjusted: 'Edit',
  approval_rejected: 'X',
  proposal_draft_requested: 'Sparkles',
  proposal_draft_ready: 'FileText',
  proposal_sent: 'Send',
  engagement_synced: 'Globe',
  engagement_closed: 'CheckCircle',
  quote_computed: 'Sparkle',
  quote_approved: 'Check',
};

type EngagementWithThread = EngagementSummary & { thread: ThreadEventRow[] };

export default function OpportunityDetailPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [eng, setEng] = useState<EngagementWithThread | null>(null);
  const [quote, setQuote] = useState<EngagementQuote | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);

  useEffect(() => {
    if (!user) return;
    opportunities.get(id).then(setEng).catch((e) => setErr(String(e)));
    quotes.forEngagement(id).then(setQuote).catch(() => setQuote(null));
    predictions.latest(id).then(setPrediction).catch(() => setPrediction(null));
  }, [id, user]);

  async function runPredict() {
    setErr(null);
    setPredicting(true);
    try {
      const fresh = await predictions.predict(id);
      setPrediction(fresh);
      const refreshed = await opportunities.get(id);
      setEng(refreshed);
      const q = await quotes.forEngagement(id).catch(() => null);
      setQuote(q);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setPredicting(false);
    }
  }

  async function approvePrediction(
    choice: ApprovalChoice,
    extras: { customPriceCents?: number; comment?: string } = {},
  ) {
    if (!prediction) return;
    try {
      await predictions.approve(id, {
        predictionId: prediction.id,
        choice,
        ...(extras.customPriceCents != null ? { customPriceCents: extras.customPriceCents } : {}),
        ...(extras.comment ? (choice === 'custom' ? { comment: extras.comment } : { optionalComment: extras.comment }) : {}),
      });
      const [refreshed, latest, q] = await Promise.all([
        opportunities.get(id),
        predictions.latest(id),
        quotes.forEngagement(id).catch(() => null),
      ]);
      setEng(refreshed);
      setPrediction(latest);
      setQuote(q);
    } catch (e) {
      setErr(describeError(e));
    }
  }

  if (err) {
    return (
      <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'Not found' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22, color: 'var(--danger)' }}>{err}</div>
        </div>
      </AppShell>
    );
  }
  if (!eng) {
    return (
      <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }]}>
        <div className="page-inner empty"><span className="spin" /></div>
      </AppShell>
    );
  }

  const headerTitle = eng.name ?? eng.clientEmail;

  return (
    <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: headerTitle }]}>
      <div className="thread-split">
        <div className="thread-pane">
          <div className="thread-head">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div className="thread-title">{headerTitle}</div>
                <div className="thread-meta">
                  <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{eng.id.slice(0, 8)}</span>
                  <span className="dot">·</span>
                  <span>{eng.templateName}</span>
                  {eng.name && (<>
                    <span className="dot">·</span>
                    <span>{eng.clientEmail}</span>
                  </>)}
                </div>
              </div>
              <button className="btn sm ghost" title="More">
                <Icon.More size={13} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              <StageChip stage={eng.status} />
              <span className="chip"><Icon.Mail size={10} />{eng.clientEmail}</span>
              <span className="chip"><Icon.Calendar size={10} />{new Date(eng.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          <div className="thread-body">
            {eng.thread.length === 0 ? (
              <div className="empty">No thread events yet.</div>
            ) : eng.thread.map((ev) => {
              const IconComp = Icon[EVENT_ICONS[ev.eventType] ?? 'Dot' as keyof typeof Icon];
              return (
                <div key={ev.id} className="thread-event done">
                  <div className="node">{IconComp && <IconComp size={8} />}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span className="actor">{actorLabel(ev)}</span>
                    <span className="when mono">{relativeTime(ev.createdAt)}</span>
                    {ev.actorType === 'client' && <span className="pill"><Icon.User size={8} />client</span>}
                    {ev.actorType === 'system' && <span className="pill"><Icon.Sparkle size={8} />system</span>}
                  </div>
                  <div className="msg">
                    <b>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</b>
                    {payloadHint(ev)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="artifact-pane">
          <div className="artifact-head">
            <div>
              <div className="artifact-title">Opportunity state</div>
              <div className="artifact-sub">
                Status: <span className="mono">{eng.status}</span>
              </div>
            </div>
            <Link href="/opportunities" className="btn sm"><Icon.ChevronLeft size={12} />All opportunities</Link>
          </div>
          <div className="artifact-body">
            {prediction && user && (
              <ApprovalCard
                prediction={prediction}
                quote={quote}
                approverRole={user.role}
                approved={eng.status === 'approved'}
                approvedPriceCents={
                  quote?.approvedPriceCents ?? null
                }
                onApprove={approvePrediction}
                onRepredict={runPredict}
                repredicting={predicting}
              />
            )}

            {!prediction && quote && user && (
              <NoPredictionCta
                quote={quote}
                onRun={runPredict}
                running={predicting}
                canPredict={
                  user.role === 'admin' || user.role === 'sales_manager' || user.role === 'sales_employee'
                }
              />
            )}

            {!prediction && !quote && eng.status === 'submitted' && (
              <div className="card" style={{ padding: 22, fontSize: 13, color: 'var(--fg-muted)' }}>
                <Icon.Sparkle size={12} /> No quote yet — bind a rate card to this template
                and re-submit to see a price recommendation.
              </div>
            )}

            {eng.predictedPriceCents != null && !prediction && !quote && (
              <PricePredictionCard
                pred={eng.predictedPriceCents}
                lo={eng.priceLowCents}
                hi={eng.priceHighCents}
                thread={eng.thread}
              />
            )}

            <div
              className="card"
              style={{ padding: 22, marginTop: (quote || eng.predictedPriceCents != null) ? 16 : 0 }}
            >
              <div className="section-label" style={{ marginBottom: 10 }}>Opportunity</div>
              {eng.name && <Row k="Name" v={eng.name} />}
              <Row k="Client email" v={eng.clientEmail} />
              <Row k="Template" v={eng.templateName} />
              <Row k="Created" v={new Date(eng.createdAt).toLocaleString()} />
              {eng.submittedAt && <Row k="Submitted" v={new Date(eng.submittedAt).toLocaleString()} />}
              <Row k="Opportunity id" v={<span className="mono">{eng.id}</span>} />
            </div>

            <div className="card" style={{ padding: 22, marginTop: 16 }}>
              <div className="section-label" style={{ marginBottom: 10 }}>What happens next</div>
              <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.55 }}>
                {nextStepHint(eng.status)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

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

function ApprovalCard({
  prediction,
  quote,
  approverRole,
  approved,
  approvedPriceCents,
  onApprove,
  onRepredict,
  repredicting,
}: {
  prediction: Prediction;
  quote: EngagementQuote | null;
  approverRole: string;
  approved: boolean;
  approvedPriceCents: number | null;
  onApprove(
    choice: ApprovalChoice,
    extras?: { customPriceCents?: number; comment?: string },
  ): Promise<void>;
  onRepredict(): Promise<void>;
  repredicting: boolean;
}) {
  const canApprove = approverRole === 'admin' || approverRole === 'sales_manager';
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
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div>
          <div className="section-label">Price recommendation</div>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
            Computed {relativeTime(prediction.createdAt)}
            {quote ? ` · rate card v${quote.rateCardVersion} · ${quote.currency}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <RegimePill regime={prediction.regime} dataQuality={prediction.dataQuality} />
          {approved && approvedPriceCents != null
            ? <span className="chip ok"><Icon.Check size={11} sw={2.2} />Approved · {fmt(approvedPriceCents)}</span>
            : <span className="chip warn"><Icon.Clock size={10} />Awaiting approval</span>}
        </div>
      </div>

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
            {canApprove && !approved && (
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

      {prediction.regime === 'cold_start' && (
        <div style={{
          padding: 10, marginTop: 10, fontSize: 11.5, color: 'var(--fg-muted)',
          background: 'var(--bg-sunk)', borderRadius: 6,
        }}>
          <Icon.Sparkle size={11} style={{ marginRight: 4 }} />
          {REGIME_BLURB.cold_start}
        </div>
      )}

      {prediction.drivers.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="section-label" style={{ marginBottom: 6 }}>What moved this number?</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {prediction.drivers.map((d) => <DriverRow key={d.feature} driver={d} />)}
          </div>
        </div>
      )}

      {/* Custom override */}
      {canApprove && !approved && (
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
        <button
          className="btn sm ghost"
          disabled={repredicting}
          onClick={() => void onRepredict()}
          title="Recompute with the latest rate card + config"
        >
          {repredicting ? <><span className="spin" />Predicting…</> : <><Icon.Sparkle size={11} />Re-predict</>}
        </button>
      </div>
    </div>
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

function NoPredictionCta({
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
      <div className="section-label">Base price ready</div>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '6px 0 12px' }}>
        Stage-2 base computed at{' '}
        <b style={{ color: 'var(--fg)' }}>{formatMoney(quote.baseTotalCents, quote.currency)}</b>.
        Run a prediction to see the regime + recommended price.
      </p>
      <button className="btn accent" disabled={running || !canPredict} onClick={() => void onRun()}>
        {running ? <><span className="spin" />Predicting…</> : <><Icon.Sparkle size={12} />Run prediction</>}
      </button>
    </div>
  );
}

function pctLabel(adj: number): string {
  if (adj === 0) return 'No adjustment';
  const pct = (adj * 100).toFixed(1);
  return adj < 0 ? `${pct}% (discount applied)` : `+${pct}% (premium applied)`;
}

function QuoteCard({
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

function BreakdownRow({ line, currency }: { line: BasePriceLine; currency: string }) {
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

function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

function currencySymbol(currency: string): string {
  // Single-character symbol for the input prefix; falls back to the
  // currency code when there's no symbol Intl knows about.
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--divider)' }}>
      <div style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{k}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
    </div>
  );
}

function PricePredictionCard({
  pred, lo, hi, thread,
}: {
  pred: number;
  lo: number | null;
  hi: number | null;
  thread: ThreadEventRow[];
}) {
  // Pull confidence + cold_start + topK from the most recent price_predicted event.
  const ev = [...thread].reverse().find((e) => e.eventType === 'price_predicted');
  const payload = (ev?.payload ?? {}) as {
    confidence?: number;
    coldStart?: boolean;
    modelVersion?: number;
    topK?: Array<{ score: number; priceCents: number; scopeSummary: string }>;
  };
  const confidence = payload.confidence ?? 0;
  const coldStart = !!payload.coldStart;
  const modelVersion = payload.modelVersion;
  const topK = payload.topK ?? [];

  const fmt = (cents: number) => `$${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const band = lo != null && hi != null ? Math.round(((hi - lo) / 2 / pred) * 100) : null;

  return (
    <div className="ml-hero" style={{ marginBottom: 16 }}>
      <div className="ml-label">
        {coldStart ? <span className="pulse" /> : <Icon.Sparkle size={10} />}
        {coldStart ? 'Indicative price · cold-start' : 'Predicted price'}
        {modelVersion != null && <span style={{ color: 'var(--fg-muted)', fontWeight: 500 }}>· model v{modelVersion}</span>}
      </div>

      <div className="ml-price">
        <span className="currency">USD</span>
        <span>{fmt(pred)}</span>
        {band != null && <span className="band">± {band}%</span>}
      </div>

      <div className="ml-meta">
        <span><b>{Math.round(confidence * 100)}%</b> confidence</span>
        {lo != null && hi != null && (
          <>
            <span>·</span>
            <span>Band <b className="num">{fmt(lo)} – {fmt(hi)}</b></span>
          </>
        )}
        {topK.length > 0 && (
          <>
            <span>·</span>
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

function actorLabel(ev: ThreadEventRow): string {
  if (ev.actorType === 'client') return 'Client';
  if (ev.actorType === 'system') return 'rhud';
  if (ev.actorType === 'integration') return 'Integration';
  return 'Sales';
}

function payloadHint(ev: ThreadEventRow): React.ReactNode {
  const p = ev.payload as Record<string, unknown> | null;
  if (!p) return null;
  if (ev.eventType === 'file_uploaded' && typeof p.filename === 'string') {
    return <> · {p.filename}</>;
  }
  if (ev.eventType === 'link_issued' && typeof p.expiresAt === 'string') {
    return <> · expires {new Date(p.expiresAt).toLocaleDateString()}</>;
  }
  return null;
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function nextStepHint(status: string): string {
  switch (status) {
    case 'issued': return 'Waiting on the client to open the link and start answering. They get a tokenised URL — no account required.';
    case 'in_progress': return 'Client is filling the form. Their progress saves between sessions.';
    case 'submitted': return 'Scope received. Sprint 5 will trigger ML price prediction here.';
    case 'predicted': return 'Price band ready. Sales manager review next.';
    case 'pending_approval': return 'Manager review pending. Approve to start drafting.';
    case 'approved': return 'Approved. Gamma drafting kicks off automatically (sprint 7).';
    case 'drafting': return 'Gamma is generating the proposal.';
    case 'draft_ready': return 'Draft is in the portal — review before sending.';
    case 'sent': return 'Proposal delivered. The opportunity auto-closes after 14 days unless the client responds.';
    case 'closed': return 'Opportunity closed. Audit chain sealed.';
    default: return 'Awaiting the next signal.';
  }
}
