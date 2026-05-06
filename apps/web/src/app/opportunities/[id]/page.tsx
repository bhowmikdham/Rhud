'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  describeError,
  integrations,
  justification,
  opportunities,
  predictions,
  proposalDraft,
  quotes,
  type ApprovalChoice,
  type BasePriceLine,
  type CurrentProposalDraft,
  type EngagementQuote,
  type EngagementSummary,
  type JustificationResult,
  type OutlookConnectionStatus,
  type Prediction,
  type PredictionDriver,
  type ProposalDraftResult,
  type Regime,
  type ThreadEventRow,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';
import { Portal } from '@/components/portal';
import { RowActions } from '@/components/row-actions';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { useConfirm } from '@/components/confirm';
import { OdooSyncCard } from './odoo-sync-card';

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
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [eng, setEng] = useState<EngagementWithThread | null>(null);
  const [quote, setQuote] = useState<EngagementQuote | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const canDelete = user?.role === 'admin' || user?.role === 'sales_manager';

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
      await refreshAfterDecision();
      // Kick off proposal drafting in the background. Auto providers
      // run server-side; manual provider returns a prompt for the user
      // to ferry — the ProposalDraftCard reads its own state and will
      // surface whichever path the response calls for. We intentionally
      // don't await this so the approve UI stays snappy.
      void proposalDraft.generate(id).catch(() => undefined);
    } catch (e) {
      setErr(describeError(e));
    }
  }

  async function rejectPrediction(reason: string) {
    try {
      await predictions.reject(id, {
        reason,
        ...(prediction ? { predictionId: prediction.id } : {}),
      });
      await refreshAfterDecision();
    } catch (e) {
      setErr(describeError(e));
      throw e; // let the modal know to stay open
    }
  }

  async function revertApproval() {
    try {
      await predictions.revertApproval(id);
      await refreshAfterDecision();
    } catch (e) {
      setErr(describeError(e));
    }
  }

  async function refreshAfterDecision() {
    const [refreshed, latest, q] = await Promise.all([
      opportunities.get(id),
      predictions.latest(id),
      quotes.forEngagement(id).catch(() => null),
    ]);
    setEng(refreshed);
    setPrediction(latest);
    setQuote(q);
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
              <RowActions
                items={[
                  {
                    label: 'Delete opportunity',
                    icon: 'X',
                    danger: true,
                    disabled: !canDelete,
                    title: canDelete ? undefined : 'Manager or admin only',
                    onClick: () => setShowDelete(true),
                  },
                ]}
              />
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
                // "Approved" sticks for the whole post-approval lifecycle —
                // the price decision was made, even if the engagement has
                // since moved on to drafting / draft_ready / sent. Without
                // this the approve buttons reappear once status flips past
                // 'approved', which looks like the decision was lost.
                approved={['approved', 'drafting', 'draft_ready', 'sent', 'closed'].includes(eng.status)}
                rejected={eng.status === 'rejected'}
                approvedPriceCents={quote?.approvedPriceCents ?? null}
                onApprove={approvePrediction}
                onReject={rejectPrediction}
                onRevert={revertApproval}
                onRepredict={runPredict}
                repredicting={predicting}
                rejectionReason={lastRejectionReason(eng.thread)}
                thread={eng.thread}
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
              <div
                className="card"
                style={{
                  padding: 22, fontSize: 13,
                  background: 'var(--warn-tint)', color: 'var(--warn)',
                  borderColor: 'color-mix(in oklch, var(--warn) 22%, transparent)',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--fg)' }}>
                  <Icon.Sparkle size={12} /> No quote — this template has no rate card bound
                </div>
                <p style={{ margin: '0 0 12px', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                  Without a rate card the pricing engine has nothing to compute against. Open the template,
                  pick a published rate card, then click <b>Re-predict</b> below to retry.
                </p>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Link href={`/templates/${eng.templateId}`} className="btn sm">
                    Open template <Icon.ArrowUpRight size={11} />
                  </Link>
                  {user && (user.role === 'admin' || user.role === 'sales_manager' || user.role === 'sales_employee') && (
                    <button className="btn sm ghost" disabled={predicting} onClick={() => void runPredict()}>
                      {predicting ? <><span className="spin" /> Predicting…</> : <><Icon.Sparkle size={11} /> Re-predict</>}
                    </button>
                  )}
                </div>
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

            {quote && <JustificationCard engagementId={eng.id} clientEmail={eng.clientEmail} />}

            {['approved', 'drafting', 'draft_ready', 'sent'].includes(eng.status) && user && (
              <ProposalDraftCard
                engagementId={eng.id}
                clientEmail={eng.clientEmail}
                userRole={user.role}
                onStatusChange={() => { void refreshAfterDecision(); }}
              />
            )}

            {user && <OdooSyncCard engagementId={eng.id} status={eng.status} />}

            <div className="card" style={{ padding: 22, marginTop: 16 }}>
              <div className="section-label" style={{ marginBottom: 10 }}>What happens next</div>
              <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.55 }}>
                {nextStepHint(eng.status)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {showDelete && eng && (
        <DeleteConfirmModal
          title="Delete opportunity"
          subject={eng.name ?? eng.clientEmail}
          description={
            <>
              Removes the opportunity and everything attached to it: all scope answers,
              uploaded files, thread events, the quote, predictions, and the gathering token.
              The client&apos;s gathering link will stop working.
            </>
          }
          confirmPhrase="delete"
          onCancel={() => setShowDelete(false)}
          onConfirm={async () => {
            await opportunities.remove(id);
            router.replace('/opportunities');
          }}
        />
      )}
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
  rejected,
  approvedPriceCents,
  onApprove,
  onReject,
  onRevert,
  onRepredict,
  repredicting,
  rejectionReason,
  thread,
}: {
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
  repredicting: boolean;
  rejectionReason: string | null;
  /** Thread events — used to surface model confidence + comparable
   *  quotes from the most recent `price_predicted` payload. */
  thread: ThreadEventRow[];
}) {
  const canApprove = approverRole === 'admin' || approverRole === 'sales_manager';
  const isAdmin = approverRole === 'admin';
  // Approve/reject are mutually exclusive — once a decision is recorded,
  // hide both action surfaces. Admin gets a "Revert" escape hatch instead.
  const decisionMade = approved || rejected;
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
    <div className="card" style={{ padding: 22 }}>
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
              ? <span className="chip ok"><Icon.Check size={11} sw={2.2} />Approved · {fmt(approvedPriceCents)}</span>
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
        <button
          className="btn sm ghost"
          disabled={repredicting}
          onClick={() => void onRepredict()}
          title="Recompute with the latest rate card + config"
        >
          {repredicting ? <><span className="spin" />Predicting…</> : <><Icon.Sparkle size={11} />Re-predict</>}
        </button>
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
                  body: `The opportunity goes back to "awaiting approval".`,
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
    </div>
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
    <Portal>
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
    >
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
    </div>
    </Portal>
  );
}

/** Pull the most recent approval_rejected event's comment from the
 *  thread. Returns null if there's no rejection in history. */
function lastRejectionReason(thread: ThreadEventRow[] | undefined): string | null {
  if (!thread) return null;
  // Thread arrives oldest-first; iterate from the end so re-rejections
  // (after a revert + redo) surface the latest reason.
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i]!;
    if (e.eventType === 'approval_rejected') {
      const p = e.payload as { comment?: unknown } | null;
      if (p && typeof p.comment === 'string' && p.comment.trim()) return p.comment.trim();
      return null;
    }
  }
  return null;
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
function PriceHero({
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

function PricePredictionCard({
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

/**
 * Send-to-client modal — phase 1 (bridge before Outlook OAuth lands).
 *
 * The rep is the human-in-the-loop. They:
 *   1. Edit the subject + body in this modal (we prefill sensible
 *      defaults from the engagement).
 *   2. Click "Open in mail app" — opens their default mail client via
 *      a `mailto:` with the prefilled fields. (`mailto:` can't carry
 *      an attachment, so the modal also surfaces a prominent
 *      "Download PDF" button right above it.)
 *   3. Manually attach the downloaded PDF in their mail client.
 *   4. Send the email from their own account.
 *   5. Click "I've sent it" back here — flips status to `sent`.
 *
 * Phase 2 (Outlook OAuth) will replace steps 2–5 with a single
 * "Send via Outlook" button that composes + attaches + sends server-
 * side via the rep's own connected account. The modal layout stays
 * the same; we just add another action button.
 */
function SendModal({
  engagementId,
  clientEmail,
  source,
  deckUrl,
  text,
  pdfAvailable,
  busy,
  onConfirmSent,
  onClose,
  onOutlookSent,
}: {
  engagementId: string;
  clientEmail: string;
  source: string | null;
  deckUrl: string | null;
  text: string | null;
  pdfAvailable: boolean;
  busy: boolean;
  onConfirmSent(): void;
  onClose(): void;
  /** Called after a successful Send via Outlook — caller flips status
   *  + shows a confirmation banner. Distinct from `onConfirmSent`
   *  which is the manual "I've sent it" path. */
  onOutlookSent(sentFrom: string): void;
}) {
  const isGamma = source === 'gamma' && !!deckUrl;
  const clientName = nameFromEmail(clientEmail);
  // Default subject + body. The body intentionally does NOT inline
  // the full proposal text — keeps mailto: under length limits and
  // makes it clear the PDF is the deliverable.
  const defaultSubject = 'Your proposal';
  const defaultBody =
    `Hi ${clientName},\n\n` +
    `Thanks for the time you spent on the scope. Please find the proposal attached` +
    (isGamma ? ' (PDF) — you can also view it online here:\n' + deckUrl : '') +
    (!isGamma && text ? '. Full text below.\n\n──────────────────\n' + text : '') +
    `\n\nLet me know what you think — happy to jump on a call to walk through it.\n\n` +
    `Best,`;

  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [downloaded, setDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [outlook, setOutlook] = useState<OutlookConnectionStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  // Probe Outlook status on open. The result drives whether the
  // "Send via Outlook" button shows up. We don't block the modal on
  // this — if the API call fails we fall through to the mailto
  // bridge UI as before.
  useEffect(() => {
    integrations.outlook.status().then(setOutlook).catch(() => setOutlook(null));
  }, []);

  const mailtoHref =
    'mailto:' +
    encodeURIComponent(clientEmail) +
    '?subject=' +
    encodeURIComponent(subject) +
    '&body=' +
    encodeURIComponent(body);

  async function sendViaOutlook() {
    if (sending) return;
    setSending(true); setSendErr(null);
    try {
      const res = await proposalDraft.sendViaOutlook(engagementId, { subject, body });
      onOutlookSent(res.sentFrom);
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('outlook_reconnect_required')) {
        setSendErr('Your Outlook session expired. Reconnect Outlook in Settings → Connections, then try again.');
      } else if (msg.includes('outlook_not_connected')) {
        setSendErr('Outlook isn\'t connected for your account. Connect it in Settings → Connections first.');
      } else if (msg.includes('outlook_not_configured')) {
        setSendErr('Outlook isn\'t configured for this workspace. Ask an admin to set up the integration.');
      } else if (msg.includes('outlook_send_failed')) {
        setSendErr(`Outlook returned an error: ${msg.replace(/^outlook_send_failed:\s*/, '')}`);
      } else {
        setSendErr(msg);
      }
    } finally {
      setSending(false);
    }
  }

  const outlookReady = outlook?.connected && outlook.available;
  const outlookUnavailable = outlook && !outlook.available;

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div
          className="card"
          style={{ width: '100%', maxWidth: 620, background: 'var(--bg)', maxHeight: '92vh', overflow: 'auto' }}
        >
          <header style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon.Send size={13} /> Send proposal to client
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
                {outlookReady ? (
                  <>Sends from <b>{outlook?.accountEmail}</b> via your connected Outlook account, with the PDF attached.</>
                ) : outlookUnavailable ? (
                  <>Edit, download the PDF, click <i>Open in mail app</i>, attach manually. (Outlook one-click send isn&apos;t configured on this server.)</>
                ) : (
                  <>Edit, download the PDF, click <i>Open in mail app</i>, attach manually. <a href="/integrations" style={{ color: 'var(--accent)' }}>Connect Outlook</a> to skip the manual attach.</>
                )}
              </div>
            </div>
            <button onClick={onClose} disabled={busy || sending} className="btn sm ghost"><Icon.X size={11} /></button>
          </header>

          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="To">
              <input className="input" value={clientEmail} disabled style={{ height: 32, fontSize: 13, padding: '0 10px' }} />
            </Field>
            <Field label="Subject">
              <input
                className="input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ height: 32, fontSize: 13, padding: '0 10px' }}
              />
            </Field>
            <Field label="Body">
              <textarea
                className="input mono"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                style={{ width: '100%', fontSize: 12.5, lineHeight: 1.55, padding: 10 }}
              />
            </Field>

            {pdfAvailable ? (
              <div style={{
                padding: 12, borderRadius: 8,
                background: 'var(--accent-tint)',
                border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--accent)', color: 'white',
                  display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                  flexShrink: 0,
                }}>PDF</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Proposal.pdf</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                    Download → attach in your mail client.
                    {downloaded && <span style={{ color: 'var(--ok)', marginLeft: 6 }}>✓ Downloaded</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn sm accent"
                  disabled={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    setSendErr(null);
                    const ok = await proposalDraft.downloadPdf(engagementId);
                    setDownloading(false);
                    if (ok) {
                      setDownloaded(true);
                    } else {
                      setSendErr('PDF unavailable — the Gamma export URL may have expired. Regenerate the proposal to refresh.');
                    }
                  }}
                >
                  {downloading ? <span className="spin" /> : <><Icon.Download size={11} /> Download PDF</>}
                </button>
              </div>
            ) : (
              <div style={{
                padding: 10, fontSize: 11.5, color: 'var(--fg-muted)',
                background: 'var(--bg-sunk)', borderRadius: 8, lineHeight: 1.5,
              }}>
                <Icon.FileText size={11} style={{ marginRight: 4 }} />
                {isGamma
                  ? 'PDF link expired (Gamma exports lapse after ~7 days). Regenerate the proposal to refresh, or send the deck link inline.'
                  : 'Text proposals don\'t carry a PDF in this phase — the body above contains the full text.'}
              </div>
            )}
          </div>

          {sendErr && (
            <div style={{
              margin: '0 18px 12px', padding: 10, fontSize: 12.5,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{sendErr}</div>
          )}

          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
          }}>
            <button onClick={onClose} disabled={busy || sending} className="btn sm ghost">Cancel</button>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {outlookReady ? (
                <>
                  {/* Bridge actions stay visible as a fallback in case
                      Outlook fails or the rep wants to send via their
                      desktop client this time. */}
                  <a href={mailtoHref} className="btn sm ghost" onClick={(e) => { if (sending) e.preventDefault(); }}>
                    <Icon.Mail size={11} /> Open in mail app
                  </a>
                  <button onClick={onConfirmSent} disabled={busy || sending} className="btn sm ghost">
                    Mark as sent
                  </button>
                  <button onClick={sendViaOutlook} disabled={sending} className="btn sm accent">
                    {sending ? <span className="spin" /> : <><Icon.Send size={11} /> Send via Outlook</>}
                  </button>
                </>
              ) : (
                <>
                  <a
                    href={mailtoHref}
                    className="btn sm"
                    onClick={(e) => { if (busy) e.preventDefault(); }}
                  >
                    <Icon.Mail size={11} /> Open in mail app
                  </a>
                  <button
                    onClick={onConfirmSent}
                    disabled={busy}
                    className="btn sm accent"
                    title="Click after you've sent the email from your mail client"
                  >
                    {busy ? <span className="spin" /> : <><Icon.Check size={11} /> I&apos;ve sent it</>}
                  </button>
                </>
              )}
            </div>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

/** Local copy of the email→name heuristic the backend uses for the
 *  same purpose. Cheap to duplicate; avoids importing backend code
 *  into the web bundle. */
function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  if (local.length < 2) return email;
  const tokens = local.split(/[._+-]+/).filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  return tokens.length > 0 ? tokens.join(' ') : email;
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
    case 'issued':
      return 'Waiting on the client to open the link and start answering. They get a tokenised URL — no account required.';
    case 'in_progress':
      return 'Client is filling the form. Their progress saves between sessions.';
    case 'submitted':
      return 'Scope received. Pricing + prediction run automatically — if no number appears, the template likely has no rate card bound.';
    case 'rejected':
      return 'A manager rejected this opportunity. Admins can revert from the price card above.';
    case 'predicted':
      return 'Price band ready. Sales manager review next.';
    case 'pending_approval':
      return 'Manager review pending. Approve to start drafting.';
    case 'approved':
      return 'Approved. Drafting starts automatically — Gamma if a template id is set on the template, otherwise AI text.';
    case 'drafting':
      return 'Generating the proposal. Polls every 5s — most decks finish in 2-3 minutes.';
    case 'draft_ready':
      return 'Draft is ready. Click Send to client → review the email + PDF, then Send via Outlook (one click), or fall back to your mail app.';
    case 'sent':
      return 'Proposal delivered to the client. They\'ll reply directly — when they do, mark the opportunity as won or closed below.';
    case 'closed':
      return 'Opportunity closed. Audit chain sealed.';
    default:
      return 'Awaiting the next signal.';
  }
}

// ── Justification card (LLM-driven quote rationale + draft email) ───────────

function JustificationCard({ engagementId, clientEmail }: { engagementId: string; clientEmail: string }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setErr(null); setText(null); setManualPrompt(null);
    try {
      const res: JustificationResult = await justification.generate(engagementId);
      if (res.mode === 'manual') setManualPrompt(res.prompt);
      else setText(res.text);
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured')) {
        setErr('AI isn\'t configured for this workspace yet. An admin needs to set it up in Settings → AI.');
      } else if (msg.includes('ai_provider_error')) {
        // Strip the prefix our backend adds so the user sees the actual
        // upstream message ("Incorrect API key", "model not found", etc.).
        setErr(`Your AI provider returned an error: ${msg.replace(/^ai_provider_error:\s*/, '')}`);
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div className="section-label">Justification &amp; draft email</div>
        {!text && !manualPrompt && (
          <button onClick={generate} disabled={busy} className="btn sm accent">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Generate</>}
          </button>
        )}
      </div>

      {!text && !manualPrompt && !err && (
        <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.55 }}>
          Have an AI write a short business rationale + draft sales email for this quote. You&apos;ll
          be able to copy it straight into your email client.
        </p>
      )}

      {err && (
        <div style={{
          padding: 10, fontSize: 12.5,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}

      {text && (
        <JustificationResultView
          text={text}
          onRegenerate={generate}
          regenBusy={busy}
        />
      )}

      {manualPrompt && (
        <ManualJustificationFlow
          prompt={manualPrompt}
          engagementId={engagementId}
          clientEmail={clientEmail}
          onAccepted={(t) => { setManualPrompt(null); setText(t); }}
          onCancel={() => setManualPrompt(null)}
        />
      )}
    </div>
  );
}

function JustificationResultView({
  text, onRegenerate, regenBusy,
}: { text: string; onRegenerate(): void; regenBusy: boolean }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <pre style={{
        margin: 0, padding: 14, background: 'var(--bg-sunk)', borderRadius: 8,
        fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>{text}</pre>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={copy} className="btn sm">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
        </button>
        <button onClick={onRegenerate} disabled={regenBusy} className="btn sm ghost">
          {regenBusy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
        </button>
      </div>
    </div>
  );
}

function ManualJustificationFlow({
  prompt, engagementId, clientEmail, onAccepted, onCancel,
}: {
  prompt: string;
  engagementId: string;
  clientEmail: string;
  onAccepted(text: string): void;
  onCancel(): void;
}) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  function copyAndOpen(url: string | null) {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (url) window.open(url, '_blank', 'noopener');
  }

  async function accept() {
    if (!pasted.trim()) return;
    setBusy(true);
    try {
      const res = await justification.acceptManual(engagementId, pasted);
      onAccepted(res.text);
    } catch {
      onAccepted(pasted.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        padding: '10px 12px', background: 'var(--accent-tint)',
        borderRadius: 8, fontSize: 12.5, color: 'var(--fg)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          <Icon.Sparkles size={11} /> Manual mode — use any AI you already have
        </div>
        <div style={{ color: 'var(--fg-muted)' }}>
          For <b>{clientEmail}</b>. Click a button below to copy the prompt and open the AI in a new tab.
          Paste the prompt, get the response, then paste it back here.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button onClick={() => copyAndOpen('https://chat.openai.com/')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open ChatGPT <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://claude.ai/new')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Claude <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://gemini.google.com/app')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Gemini <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen(null)} className="btn sm ghost">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy the prompt</>}
        </button>
      </div>

      <details style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Preview the prompt</summary>
        <pre style={{
          marginTop: 6, padding: 12, background: 'var(--bg-sunk)', borderRadius: 8,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
        }}>{prompt}</pre>
      </details>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Paste the AI&apos;s response here
        </span>
        <textarea
          className="input"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste what the AI gave you…"
          rows={6}
          style={{ fontSize: 13, lineHeight: 1.5, padding: 10 }}
        />
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} className="btn sm ghost" disabled={busy}>Cancel</button>
        <button onClick={accept} disabled={busy || !pasted.trim()} className="btn sm accent">
          {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Use this</>}
        </button>
      </div>
    </div>
  );
}

// ── Proposal draft card (full proposal, AI-generated or manually pasted) ────

function ProposalDraftCard({
  engagementId,
  clientEmail,
  userRole,
  onStatusChange,
}: {
  engagementId: string;
  clientEmail: string;
  userRole: string;
  onStatusChange(): void;
}) {
  const confirm = useConfirm();
  const [current, setCurrent] = useState<CurrentProposalDraft | null>(null);
  // Local "we're regenerating" flag — flips on immediately when the
  // user confirms regenerate, off when the new draft + status are in.
  // Keeps the UI from flashing the stale deck or the "Generate draft"
  // CTA between clear() and the new gen id landing on the engagement.
  const [regenerating, setRegenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** Recipient email after a successful send — drives a transient
   *  "Sent to {email}" banner that auto-dismisses after 6s. */
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Sales reps are the human-in-the-loop for sending — they email the
  // client themselves from their own Outlook/Gmail. Manager + admin
  // can also send (for cases where the rep is OOO etc.).
  const canSend =
    userRole === 'admin' || userRole === 'sales_manager' || userRole === 'sales_employee';

  const refresh = useCallback(async () => {
    try {
      const c = await proposalDraft.current(engagementId);
      setCurrent(c);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // While the parent's `approvePrediction` fires-and-forgets a generate
  // call, this card may be polled-into-existence right after. Poll
  // while status is 'drafting' so the user sees the new draft appear
  // without a manual refresh.
  //
  // Cadence is 5s — Gamma's docs explicitly say faster polling does not
  // speed up generation and only burns rate-limit budget. The server
  // proxies through `pollStatus`, which swallows 429s as "still pending"
  // so a hot loop here can't strand the UI.
  useEffect(() => {
    if (current?.status !== 'drafting') return;
    const handle = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(handle);
  }, [current?.status, refresh]);

  // Clear the regenerating flag once the server has caught up: either
  // the new draft is in flight (status=drafting → live phase UI takes
  // over) or it finished synchronously (status=draft_ready → deck
  // renders). Either way the regenerating placeholder has done its
  // job of bridging the gap.
  useEffect(() => {
    if (!regenerating) return;
    if (current?.status === 'drafting' || current?.status === 'draft_ready') {
      setRegenerating(false);
    }
  }, [regenerating, current?.status]);

  async function generate() {
    if (busy) return;
    setBusy(true); setErr(null); setManualPrompt(null);
    try {
      const res: ProposalDraftResult = await proposalDraft.generate(engagementId);
      if (res.mode === 'manual') {
        setManualPrompt(res.prompt);
      } else {
        // 'auto' (LLM text) and 'gamma' (synchronous URL — rare) both
        // resolve here with a finished draft. 'gamma_pending' kicks off
        // the async path: status flips to drafting on the server, the
        // 5s poll loop above hits Gamma's status endpoint until the
        // deck is ready. In all three cases we just refresh + let the
        // card re-render based on the new server state.
        await refresh();
        onStatusChange();
      }
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured')) {
        setErr('AI isn\'t configured. An admin needs to set it up in Settings → AI.');
      } else if (msg.includes('ai_provider_error')) {
        setErr(`Your AI provider returned an error: ${msg.replace(/^ai_provider_error:\s*/, '')}`);
      } else if (msg.includes('gamma_provider_error')) {
        setErr(`Gamma returned an error: ${msg.replace(/^gamma_provider_error:\s*/, '')}`);
      } else if (msg.includes('gamma_config_not_set') || msg.includes('gamma_api_key_missing')) {
        setErr('Gamma is selected as your drafter but isn\'t fully configured. An admin needs to add the API key in Connections.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (busy) return;
    const ok = await confirm({
      title: 'Regenerate proposal draft?',
      body: 'The current text will be replaced. The new draft is generated from scratch using the latest scope + price.',
      tone: 'warn',
      confirmLabel: 'Regenerate',
      icon: 'Sparkles',
    });
    if (!ok) return;
    // Flip the regenerating flag FIRST so the body switches to the
    // "Regenerating…" state immediately — before the clear() round-trip
    // wipes the persisted draft. Otherwise the UI flashes the empty
    // CTA state for a split second.
    setRegenerating(true);
    setBusy(true); setErr(null); setManualPrompt(null);
    try {
      await proposalDraft.clear(engagementId);
      await generate();
      // Don't drop the regenerating flag yet — let the next refresh
      // confirm the new draft is in flight (status=drafting). The
      // useEffect below clears it when it sees the transition.
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
      setRegenerating(false);
    }
  }

  async function markSent() {
    if (busy) return;
    const ok = await confirm({
      title: 'Mark proposal as sent?',
      body: (
        <>
          Use this if you already emailed <b>{clientEmail}</b> the proposal yourself.
          Status moves to &ldquo;sent&rdquo;; we won&apos;t send anything from Rhud.
        </>
      ),
      confirmLabel: 'Mark as sent',
      icon: 'Send',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.markSent(engagementId);
      await refresh();
      onStatusChange();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  // SendModal handles the actual mailto + PDF download orchestration.
  // The Card just opens it and listens for the "I've sent it"
  // confirmation, which calls markSent server-side.
  const [showSend, setShowSend] = useState(false);

  async function confirmSent() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.markSent(engagementId);
      await refresh();
      onStatusChange();
      setSentTo(clientEmail);
      setTimeout(() => setSentTo(null), 6_000);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
      setShowSend(false);
    }
  }

  if (loading) {
    return (
      <div className="card" style={{ padding: 22, marginTop: 16 }}>
        <div className="section-label">Proposal draft</div>
        <div className="empty" style={{ padding: 20 }}><span className="spin" /></div>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div>
          <div className="section-label">Proposal draft</div>
          {current?.draftedAt && (
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
              Drafted {relativeTime(current.draftedAt)}
              {current.source && current.source !== 'manual' && ` · ${current.source}`}
              {current.source === 'manual' && ' · pasted from your AI'}
            </div>
          )}
        </div>
        <ProposalStatusChip status={current?.status ?? 'approved'} hasText={!!current?.text} />
      </div>

      {err && (
        <div style={{
          padding: 10, fontSize: 12.5, marginBottom: 10,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}

      {sentTo && (
        <div style={{
          padding: 10, fontSize: 12.5, marginBottom: 10,
          background: 'var(--ok-tint)', color: 'var(--ok)',
          border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
          borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Icon.Check size={12} />
          <span>Sent to <b>{sentTo}</b>. They&apos;ll get an email with the proposal.</span>
        </div>
      )}

      {/* Body — body keys swap as state transitions (regenerating →
          drafting → ready) so React unmounts old + mounts new. The CSS
          .draft-body-fade class fades the new content in so transitions
          feel smooth instead of snappy. */}
      <DraftBody
        kind={
          regenerating
            ? 'regenerating'
            : manualPrompt
              ? 'manual'
              : current?.status === 'drafting'
                ? 'drafting'
                : current?.text
                  ? 'ready'
                  : 'idle'
        }
      >
        {regenerating ? (
          <RegeneratingState source={current?.source ?? null} />
        ) : manualPrompt ? (
          <ManualDraftFlow
            prompt={manualPrompt}
            engagementId={engagementId}
            clientEmail={clientEmail}
            onAccepted={async () => {
              setManualPrompt(null);
              await refresh();
              onStatusChange();
            }}
            onCancel={() => setManualPrompt(null)}
          />
        ) : current?.status === 'drafting' ? (
          <DraftingState source={current.source} phase={current.gammaPhase} elapsed={current.gammaElapsedSeconds} />
        ) : current?.text ? (
          current.source === 'gamma' && current.gammaDeckUrl ? (
            <GammaDeckRendered
              url={current.gammaDeckUrl}
              status={current.status}
              canSend={canSend}
              busy={busy}
              onRegenerate={regenerate}
              onSend={() => setShowSend(true)}
              onMarkSent={markSent}
            />
          ) : (
            <DraftRendered
              text={current.text}
              status={current.status}
              canSend={canSend}
              busy={busy}
              onRegenerate={regenerate}
              onSend={() => setShowSend(true)}
              onMarkSent={markSent}
            />
          )
        ) : (
          <>
            <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
              Generate a client-ready proposal draft from this engagement&apos;s scope + approved price.
              For manual AI mode you&apos;ll get a prompt to paste into ChatGPT / Claude / Gemini.
            </p>
            <button onClick={generate} disabled={busy} className="btn accent">
              {busy ? <span className="spin" /> : <><Icon.Sparkles size={12} /> Generate draft</>}
            </button>
          </>
        )}
      </DraftBody>

      {showSend && current && (
        <SendModal
          engagementId={engagementId}
          clientEmail={clientEmail}
          source={current.source}
          deckUrl={current.gammaDeckUrl}
          text={current.text}
          pdfAvailable={current.proposalPdfAvailable}
          busy={busy}
          onConfirmSent={confirmSent}
          onClose={() => setShowSend(false)}
          onOutlookSent={async (sentFrom) => {
            // Outlook send already flipped status on the server. Mirror
            // the post-success bookkeeping markSent does here so the
            // UI lands in the same state without re-calling the API.
            await refresh();
            onStatusChange();
            setSentTo(`${clientEmail} (from ${sentFrom})`);
            setTimeout(() => setSentTo(null), 6_000);
            setShowSend(false);
          }}
        />
      )}
    </div>
  );
}

/** Wraps the card body and replays a fade-in animation each time the
 *  `kind` prop changes. The keyed wrapper forces React to remount, so
 *  the @keyframes fires fresh — no manual transition juggling. */
function DraftBody({ kind, children }: { kind: string; children: React.ReactNode }) {
  return (
    <div
      key={kind}
      style={{
        animation: 'draftBodyFade .35s cubic-bezier(.22,.8,.3,1) both',
      }}
    >
      {children}
    </div>
  );
}

function RegeneratingState({ source }: { source: string | null }) {
  return (
    <div style={{
      padding: 18, borderRadius: 8,
      background: 'var(--accent-tint)',
      display: 'flex', alignItems: 'center', gap: 14,
      border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
    }}>
      <span style={{
        display: 'inline-flex',
        animation: 'spin 1s linear infinite',
        color: 'var(--accent)',
      }}>
        <Icon.Sparkles size={18} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)' }}>
          Regenerating proposal…
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
          {source === 'gamma'
            ? 'Telling Gamma to draft a fresh deck. This usually takes 30-90 seconds.'
            : 'Replacing the previous draft with a fresh one.'}
        </div>
      </div>
    </div>
  );
}

function DraftingState({
  source,
  phase,
  elapsed,
}: {
  source: string | null;
  phase: string | null;
  elapsed: number | null;
}) {
  return (
    <div style={{
      padding: 18, borderRadius: 8,
      background: 'var(--bg-sunk)',
      display: 'flex', alignItems: 'center', gap: 14,
    }}>
      <span style={{
        display: 'inline-flex',
        animation: 'spin 1.2s linear infinite',
        color: 'var(--accent)',
      }}>
        <Icon.Sparkles size={18} />
      </span>
      <div style={{ minWidth: 0, fontSize: 13, color: 'var(--fg-muted)' }}>
        {source === 'gamma' ? (
          <>
            <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>
              {phase ? <>Gamma is {gammaPhaseLabel(phase)}…</> : <>Gamma is generating the deck…</>}
            </div>
            {elapsed != null && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                {formatElapsed(elapsed)} elapsed · usually 30-90s
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>AI is drafting the proposal…</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>Usually 10-30 seconds.</div>
          </>
        )}
      </div>
    </div>
  );
}

function ProposalStatusChip({ status, hasText }: { status: string; hasText: boolean }) {
  if (status === 'sent') return <span className="chip ok"><Icon.Check size={11} sw={2.2} /> Sent</span>;
  if (status === 'draft_ready' || hasText) return <span className="chip accent"><Icon.Sparkles size={10} /> Draft ready</span>;
  if (status === 'drafting') {
    // Real loading state — spin the clock while we wait for the LLM/Gamma.
    return (
      <span className="chip warn">
        <span style={{ display: 'inline-flex', animation: 'spin 1.2s linear infinite' }}>
          <Icon.Clock size={10} />
        </span>
        Drafting
      </span>
    );
  }
  // Idle state — gentle pulse on the sparkle so the chip feels alive
  // without screaming for attention (the user is the one who has to act).
  return (
    <span className="chip outline">
      <span style={{ display: 'inline-flex', animation: 'pulse 1.8s ease-in-out infinite' }}>
        <Icon.Sparkle size={10} />
      </span>
      Awaiting draft
    </span>
  );
}

function DraftRendered({
  text, status, canSend, busy, onRegenerate, onSend, onMarkSent,
}: {
  text: string;
  status: string;
  canSend: boolean;
  busy: boolean;
  onRegenerate(): void;
  onSend(): void;
  onMarkSent(): void;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <pre style={{
        margin: 0, padding: 14, background: 'var(--bg-sunk)', borderRadius: 8,
        fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        maxHeight: 480, overflow: 'auto',
      }}>{text}</pre>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={copy} className="btn sm">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy proposal</>}
        </button>
        {status !== 'sent' && (
          <button onClick={onRegenerate} disabled={busy} className="btn sm ghost">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
          </button>
        )}
        {status !== 'sent' && canSend && (
          <>
            <button onClick={onSend} disabled={busy} className="btn sm accent" style={{ marginLeft: 'auto' }}>
              <Icon.Send size={11} /> Send to client
            </button>
            <button
              onClick={onMarkSent}
              disabled={busy}
              className="btn sm ghost"
              title="Already emailed it yourself? Just flip the status."
            >
              Mark as sent
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Convert a Gamma viewer URL into an iframe-safe embed URL.
 *
 * Gamma sends `X-Frame-Options: DENY` on the canonical viewer URL
 * (`gamma.app/docs/Some-Title-abc123`) — embedding it directly shows
 * the browser's "refused to connect" page. The platform exposes a
 * separate, framing-safe variant at `gamma.app/embed/{slug}` where
 * the slug is the trailing identifier from the viewer URL (after the
 * last hyphen, which Gamma uses to separate human-readable title
 * words from the file id).
 *
 * Edge cases handled:
 *   - Already an embed URL → returned as-is.
 *   - Hostname isn't gamma.app → returned as-is (let the iframe try).
 *   - Pathname has no hyphen → use the whole last segment as slug.
 *   - Bad URL string → returned as-is so the caller's link UX still works.
 *
 * Note: even with the embed URL, Gamma still requires the deck to be
 * publicly viewable. We default `sharingOptions.externalAccess: 'view'`
 * on every generation so newly-created decks frame fine. Older decks
 * (made before that change) may render as Gamma's own access-denied
 * page inside the frame — the "Open in Gamma" button below stays as
 * the escape hatch.
 */
function gammaEmbedUrl(viewerUrl: string): string {
  try {
    const u = new URL(viewerUrl);
    if (u.hostname !== 'gamma.app') return viewerUrl;
    if (u.pathname.startsWith('/embed/')) return viewerUrl;
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!last) return viewerUrl;
    const slug = last.includes('-') ? last.split('-').pop()! : last;
    return `https://gamma.app/embed/${slug}`;
  } catch {
    return viewerUrl;
  }
}

function GammaDeckRendered({
  url, status, canSend, busy, onRegenerate, onSend, onMarkSent,
}: {
  url: string;
  status: string;
  canSend: boolean;
  busy: boolean;
  onRegenerate(): void;
  onSend(): void;
  onMarkSent(): void;
}) {
  const [copied, setCopied] = useState(false);
  const embedUrl = gammaEmbedUrl(url);
  function copyLink() {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        position: 'relative',
        background: 'var(--bg-sunk)',
        borderRadius: 8,
        border: '1px solid var(--divider)',
        overflow: 'hidden',
        // 16:9 — matches Gamma's default presentation aspect.
        aspectRatio: '16 / 9',
      }}>
        <iframe
          src={embedUrl}
          title="Proposal deck preview"
          loading="lazy"
          allow="fullscreen"
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            border: 0,
            background: 'var(--bg-sunk)',
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn sm">
          <Icon.ArrowUpRight size={11} /> Open in Gamma
        </a>
        <button onClick={copyLink} className="btn sm ghost">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy link</>}
        </button>
        {status !== 'sent' && (
          <button onClick={onRegenerate} disabled={busy} className="btn sm ghost">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
          </button>
        )}
        {status !== 'sent' && canSend && (
          <>
            <button onClick={onSend} disabled={busy} className="btn sm accent" style={{ marginLeft: 'auto' }}>
              <Icon.Send size={11} /> Send to client
            </button>
            <button
              onClick={onMarkSent}
              disabled={busy}
              className="btn sm ghost"
              title="Already emailed it yourself? Just flip the status."
            >
              Mark as sent
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Human-readable label for Gamma's terse status enum. */
function gammaPhaseLabel(phase: string): string {
  switch (phase.toLowerCase()) {
    case 'queued':       return 'queued';
    case 'pending':      return 'queued';
    case 'processing':   return 'generating cards';
    case 'in_progress':  return 'generating cards';
    case 'completed':    return 'finishing up';
    case 'failed':       return 'failed';
    default:             return phase;
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function ManualDraftFlow({
  prompt, engagementId, clientEmail, onAccepted, onCancel,
}: {
  prompt: string;
  engagementId: string;
  clientEmail: string;
  onAccepted(): Promise<void>;
  onCancel(): void;
}) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function copyAndOpen(url: string | null) {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (url) window.open(url, '_blank', 'noopener');
  }

  async function accept() {
    if (!pasted.trim()) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.acceptManual(engagementId, pasted);
      await onAccepted();
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{
        padding: '10px 12px', background: 'var(--accent-tint)',
        borderRadius: 8, fontSize: 12.5,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          <Icon.Sparkles size={11} /> Manual mode — proposal for <b>{clientEmail}</b>
        </div>
        <div style={{ color: 'var(--fg-muted)' }}>
          Copy the prompt to your AI of choice, paste back the response below. We&apos;ll persist it as the proposal draft.
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <button onClick={() => copyAndOpen('https://chat.openai.com/')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open ChatGPT <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://claude.ai/new')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Claude <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://gemini.google.com/app')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Gemini <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen(null)} className="btn sm ghost">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy</>}
        </button>
      </div>
      <details style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
        <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Preview the prompt</summary>
        <pre style={{
          marginTop: 6, padding: 10, background: 'var(--bg-sunk)', borderRadius: 6,
          fontFamily: 'inherit', fontSize: 11.5, lineHeight: 1.45,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
        }}>{prompt}</pre>
      </details>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Paste the AI&apos;s proposal here
        </span>
        <textarea
          className="input"
          rows={10}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste the full proposal markdown the AI gave you…"
          style={{ fontSize: 12.5, lineHeight: 1.5, padding: 10 }}
          disabled={busy}
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
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
        <button onClick={accept} disabled={busy || !pasted.trim()} className="btn sm accent">
          {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save as draft</>}
        </button>
      </div>
    </div>
  );
}
