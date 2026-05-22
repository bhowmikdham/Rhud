'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describeError,
  extraction,
  justification,
  opportunities,
  predictions,
  proposalDraft,
  quotes,
  siteEnumeration,
  type ApprovalChoice,
  type BasePriceLine,
  type EngagementQuote,
  type EngagementSummary,
  type ExtractedPoint,
  type FileExtraction,
  type GatheringLinkInfo,
  type InferredEntity,
  type PointCategory,
  type JustificationResult,
  type ParsedDocument,
  type Prediction,
  type PredictionDriver,
  type Regime,
  type DiscoveredPageRow,
  type SiteEnumerationCategorySummary,
  type SiteEnumerationStateView,
  type SiteUrlCategory,
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
import { LeadHud } from './lead-hud';
import { LeadSummaryInline } from './lead-summary-inline';
import {
  AssumptionsExclusionsCard,
  QuoteLineItemsCard,
  ReviewerHoldActions,
} from './reviewer-panels';

const EVENT_LABELS: Record<string, string> = {
  link_issued: 'Link issued to client',
  link_opened: 'Client opened the link',
  node_answered: 'Question answered',
  file_uploaded: 'File uploaded',
  scope_submitted: 'Scope submitted',
  price_predicted: 'Price predicted',
  price_tech_adjusted: 'Tech team adjusted price',
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
  site_enumerated: 'Site scope crawled',
  site_enumeration_failed: 'Site scope crawl failed',
  mapper_fallback_heuristic: 'Mapper fell back to heuristic',
  loop_iteration_removed: 'Iteration removed',
};

const EVENT_ICONS: Partial<Record<string, keyof typeof Icon>> = {
  link_issued: 'Link',
  link_opened: 'Eye',
  node_answered: 'Check',
  file_uploaded: 'Paperclip',
  scope_submitted: 'Send',
  price_predicted: 'Sparkle',
  price_tech_adjusted: 'Edit',
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
  site_enumerated: 'Globe',
  site_enumeration_failed: 'X',
  mapper_fallback_heuristic: 'Sparkle',
  loop_iteration_removed: 'X',
};

type EngagementWithThread = EngagementSummary & {
  thread: ThreadEventRow[];
  gatheringLink: GatheringLinkInfo | null;
};

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
  /** Scroll target — the prediction/quote surface at the top of the
   *  artifact body. SiteScopeCard's "Compute quote" smooth-scrolls
   *  here after the conventional flow updates the QuoteCard. */
  const predictionSectionRef = useRef<HTMLDivElement | null>(null);

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

  /** Used by SiteScopeCard. The site-enum's "Compute quote" button
   *  needs to flow into the same UI as the regular predict/quote path
   *  — that's the QuoteCard / ApprovalCard / NoPredictionCta surface
   *  at the top of the page. We refresh those cards via runPredict()
   *  (the backend now reads SiteEnumeration.inferredEntities so the
   *  persisted EngagementQuote includes the site-enum line items),
   *  then smooth-scroll the user up so they see the result land.
   *
   *  The smooth-scroll is intentional: the rep typically clicks
   *  "Compute quote" while looking at the SiteScopeCard mid-page,
   *  and the QuoteCard is far enough up that without animation it's
   *  jarring to discover. */
  async function runPredictFromSiteScope() {
    await runPredict();
    // Defer the scroll one tick so React has flushed the render that
    // mounts the QuoteCard / ApprovalCard.
    requestAnimationFrame(() => {
      predictionSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
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
      // to ferry — the proposal workspace (/opportunities/[id]/proposal)
      // reads its own state and will surface whichever path the response
      // calls for. We intentionally don't await this so the approve UI
      // stays snappy.
      void proposalDraft.generate(id).catch(() => undefined);
    } catch (e) {
      setErr(describeError(e));
    }
  }

  async function techAdjustPrediction(adjustedPriceCents: number, note: string) {
    if (!prediction) return;
    try {
      await predictions.techAdjust(id, {
        predictionId: prediction.id,
        adjustedPriceCents,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      await refreshAfterDecision();
    } catch (e) {
      setErr(describeError(e));
      throw e;
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
          {user && (
            <LeadHud engagementId={eng.id} status={eng.status} userRole={user.role} />
          )}
          <div className="artifact-body">
            {user && (
              <div style={{ marginBottom: 16 }}>
                <LeadSummaryInline engagementId={eng.id} />
              </div>
            )}
            <div ref={predictionSectionRef} style={{ scrollMarginTop: 80 }}>
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
                onTechAdjust={techAdjustPrediction}
                repredicting={predicting}
                rejectionReason={lastRejectionReason(eng.thread)}
                thread={eng.thread}
              />
            )}

            {user && (eng.status === 'submitted' || eng.status === 'pending_approval' || eng.status === 'predicted') && (
              <div style={{
                margin: '12px 0',
                padding: '10px 14px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 8,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 10,
              }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Need to pause before approving?
                </span>
                <ReviewerHoldActions
                  engagementId={eng.id}
                  userRole={user.role}
                  status={eng.status}
                  onStatusChange={() => { void refreshAfterDecision(); }}
                />
              </div>
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
            </div>

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

            {eng.gatheringLink && (
              <GatheringLinkCard link={eng.gatheringLink} />
            )}

            <SiteScopeCard
              engagementId={eng.id}
              onAfterCompute={runPredictFromSiteScope}
              parentBusy={predicting}
            />

            <ExtractedPointsCard engagementId={eng.id} />

            {user && (
              <AssumptionsExclusionsCard
                engagementId={eng.id}
                userRole={user.role}
                initial={{
                  assumptions: eng.assumptions ?? null,
                  exclusions: eng.exclusions ?? null,
                  deliveryTimelineOverride: eng.deliveryTimelineOverride ?? null,
                }}
                onSaved={() => { void refreshAfterDecision(); }}
              />
            )}

            {quote && user && (
              <QuoteLineItemsCard
                engagementId={eng.id}
                userRole={user.role}
                currency={quote.currency}
              />
            )}

            {quote && <JustificationCard engagementId={eng.id} clientEmail={eng.clientEmail} />}

            {['approved', 'drafting', 'draft_ready', 'sent'].includes(eng.status) && (
              <ProposalSummaryCard
                engagementId={eng.id}
                status={eng.status}
              />
            )}

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
  onTechAdjust,
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
  onTechAdjust(adjustedPriceCents: number, note: string): Promise<void>;
  repredicting: boolean;
  rejectionReason: string | null;
  /** Thread events — used to surface model confidence + comparable
   *  quotes from the most recent `price_predicted` payload. */
  thread: ThreadEventRow[];
}) {
  const canApprove = approverRole === 'admin' || approverRole === 'sales_manager';
  const isAdmin = approverRole === 'admin';
  const isTechTeam = approverRole === 'tech_team';
  // Tech adjustment is only meaningful when bound to the CURRENT prediction.
  // After a re-predict, the prior adjustment is stale and we hide it.
  const techAdjustedFresh =
    quote?.techAdjustedPriceCents != null
    && quote.techAdjustedPredictionId === prediction.id;
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

/** Live gathering link card — surfaces the URL the rep generated when
 *  the opportunity was issued. Lets them copy it back into chat after
 *  leaving the new-opportunity wizard. Renders revoked / expired states
 *  inline so they aren't tempted to share a dead link. */
function GatheringLinkCard({ link }: { link: GatheringLinkInfo }) {
  const [copied, setCopied] = useState(false);
  const dead = link.isRevoked || link.isExpired;
  const expDate = new Date(link.expiresAt);
  return (
    <div
      className="card"
      style={{
        padding: 22, marginTop: 16,
        background: dead ? 'var(--bg-sunk)' : 'var(--bg-elev)',
        opacity: dead ? 0.85 : 1,
      }}
    >
      <div className="section-label" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon.Link size={11} /> Gathering link
        {link.isRevoked && <span style={{ color: 'var(--danger)', fontSize: 10.5, fontWeight: 600 }}>· REVOKED</span>}
        {!link.isRevoked && link.isExpired && <span style={{ color: 'var(--warn)', fontSize: 10.5, fontWeight: 600 }}>· EXPIRED</span>}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px',
        background: 'var(--bg-sunk)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--fg-muted)',
        wordBreak: 'break-all',
      }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {link.url}
        </span>
        <button
          className="btn sm ghost"
          onClick={() => {
            void navigator.clipboard.writeText(link.url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          title="Copy link to clipboard"
        >
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
        </button>
      </div>

      <div style={{
        marginTop: 10,
        display: 'flex', flexWrap: 'wrap', gap: 14,
        fontSize: 11.5, color: 'var(--fg-subtle)',
      }}>
        <span><Icon.Clock size={10} /> Expires {expDate.toLocaleString()}</span>
        <span>·</span>
        <span>{link.accessCount} {link.accessCount === 1 ? 'access' : 'accesses'}</span>
      </div>

      {dead && (
        <p style={{ margin: '10px 0 0', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {link.isRevoked
            ? 'This link was revoked. Issue a new opportunity to send a fresh one.'
            : 'This link has expired. Issue a new opportunity to send a fresh one.'}
        </p>
      )}
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
      return 'Scope received. Any uploaded documents are being read for pricing-relevant data points; prediction fires once extraction settles.';
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

// ── Site scope (crawl prospect site → categorised scope → quote) ────────

/** Compact URL display for the site-scope card.
 *  - Same-host pages (the SPA's own routes) show the path only.
 *  - Cross-host URLs (APIs, integrations like supabase.co / razorpay)
 *    show host + path so the rep can tell the destinations apart. */
function siteHost(siteUrl: string): string | undefined {
  try { return new URL(siteUrl).host; } catch { return undefined; }
}

/** Group API-category URLs by what they actually are so the tech-side
 *  view shows the hierarchy (Supabase tables, RPCs, REST paths, XHR).
 *  Pure URL-pattern detection — keeps the categorisation decoupled
 *  from the crawler. */
type ApiSubGroup = 'supabase_table' | 'supabase_rpc' | 'rest_path' | 'xhr_call';
const API_SUBGROUP_LABEL: Record<ApiSubGroup, string> = {
  supabase_table: 'Supabase tables',
  supabase_rpc: 'Supabase RPC functions',
  rest_path: 'REST endpoints',
  xhr_call: 'Other XHR / fetch calls',
};
function classifyApiUrl(url: string): { sub: ApiSubGroup; name: string } {
  try {
    const u = new URL(url);
    if (/\.supabase\.(co|com)$/.test(u.host)) {
      const m = u.pathname.match(/^\/rest\/v\d+\/rpc\/([^/]+)/);
      if (m) return { sub: 'supabase_rpc', name: m[1]! };
      const t = u.pathname.match(/^\/rest\/v\d+\/([^/?]+)/);
      if (t) return { sub: 'supabase_table', name: t[1]! };
    }
    if (/^\/(api|rest|graphql|functions|v[1-9])\//.test(u.pathname)) {
      return { sub: 'rest_path', name: u.host + u.pathname };
    }
    return { sub: 'xhr_call', name: u.host + u.pathname };
  } catch {
    return { sub: 'xhr_call', name: url };
  }
}

function urlPath(url: string, sameHost?: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    if (sameHost && u.host === sameHost) return path;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

const CATEGORY_LABEL: Record<SiteUrlCategory, string> = {
  product: 'Product / catalog pages',
  ecommerce: 'Ecommerce (cart / checkout)',
  blog: 'Blog / news posts',
  cms: 'CMS pages (about / contact / static)',
  form: 'Forms (contact / lead capture)',
  knowledge_base: 'Knowledge base / docs',
  attachment: 'Attachments (PDF / DOCX / …)',
  members: 'Members area / portal',
  media: 'Media (images / video)',
  module: 'App modules (CRM / inventory / …)',
  api: 'API endpoints',
  integration: 'Third-party integrations',
  other: 'Other / unclassified',
};

const STATUS_LABEL: Record<SiteEnumerationStateView['status'], string> = {
  pending: 'Queued',
  crawling: 'Crawling site…',
  classifying: 'Classifying URLs…',
  ready: 'Ready',
  failed: 'Failed',
  retry_queued: 'Retry scheduled',
};

interface SiteEnumQuotePreview {
  rateCardId: string;
  totalCents: number;
  currency: string;
  lines: BasePriceLine[];
  hasManualQuoteRequired: boolean;
  hasUnmatched: boolean;
}

/**
 * Site scope crawler card. Three modes:
 *  - empty: show the input + "Crawl site" button
 *  - in flight (pending / crawling / classifying / retry_queued):
 *      show progress + spinner; poll every 3s
 *  - ready / failed: show categories + actions
 */
function SiteScopeCard({
  engagementId,
  onAfterCompute,
  parentBusy,
}: {
  engagementId: string;
  /** Hook to flow into the conventional predict/quote path. Called
   *  after Site Scope's quote endpoint refreshes the per-rate-card
   *  inferred-entities cache; the parent then re-runs the prediction
   *  (which now picks up the cached entities via the engagement quote)
   *  and smooth-scrolls the user up to see the result. */
  onAfterCompute?: () => Promise<void>;
  /** True while the parent's runPredict is in flight. Disables our
   *  Compute button so we can't queue duplicate work. */
  parentBusy?: boolean;
}) {
  const [state, setState] = useState<SiteEnumerationStateView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quotePreview, setQuotePreview] = useState<SiteEnumQuotePreview | null>(null);
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await siteEnumeration.get(engagementId);
      setState(s);
      setLoaded(true);
    } catch (e) {
      setErr(describeError(e));
      setLoaded(true);
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll every 3s while a crawl is in flight. Slightly slower than the
  // extraction poll (5s would feel sluggish for a UI the user is
  // actively waiting on).
  useEffect(() => {
    if (!state) return;
    const inFlight = state.status === 'pending' || state.status === 'crawling' ||
                     state.status === 'classifying' || state.status === 'retry_queued';
    if (!inFlight) return;
    const handle = setInterval(() => { void refresh(); }, 3_000);
    return () => clearInterval(handle);
  }, [state, refresh]);

  async function kickoff() {
    if (!siteUrl.trim()) return;
    setBusy(true); setErr(null);
    try {
      await siteEnumeration.kickoff(engagementId, { siteUrl: siteUrl.trim() });
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reCrawl(opts?: { useJsRendering?: boolean }) {
    if (!state) return;
    setBusy(true); setErr(null);
    setQuotePreview(null);
    try {
      await siteEnumeration.kickoff(engagementId, {
        siteUrl: state.siteUrl,
        ...(opts?.useJsRendering ? { options: { useJsRendering: true } } : {}),
      });
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!state) return;
    setBusy(true); setErr(null);
    try {
      await siteEnumeration.retry(state.id);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function computeQuote() {
    setBusy(true); setErr(null);
    try {
      // Step 1: refresh the per-rate-card cache of inferred entities
      // (mapToRateCard) AND get the inline-breakdown preview for the
      // tech-detail panel below the card. The parent's runPredict
      // call (next step) reads the refreshed cache from the
      // SiteEnumeration row when it persists the EngagementQuote.
      const res = await siteEnumeration.quote(engagementId);
      setQuotePreview({
        rateCardId: res.rateCardId,
        totalCents: res.quote.totalCents,
        currency: res.quote.currency,
        lines: res.quote.lines,
        hasManualQuoteRequired: res.quote.hasManualQuoteRequired,
        hasUnmatched: res.quote.hasUnmatched,
      });
      // Step 2: flow into the conventional predict/quote path so the
      // QuoteCard / ApprovalCard at the top of the page reflect the
      // site-enum-driven scope. Parent also smooth-scrolls there.
      if (onAfterCompute) {
        await onAfterCompute();
      }
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Trigger a browser download of the CSV. We can't use a plain
   *  `<a download href="...">` because the API expects the bearer
   *  token in an Authorization header, which `<a>` can't attach.
   *  Instead: fetch the body into a Blob, mint a blob: URL, click a
   *  hidden anchor, then revoke the URL. */
  async function downloadCsv() {
    setBusy(true); setErr(null);
    try {
      const csv = await siteEnumeration.fetchCsv(engagementId);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `site-scope-${engagementId.slice(0, 8)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null; // first paint quiet until the GET resolves

  // No enumeration yet — show empty-state input.
  const headerSummary = (() => {
    if (!state) return 'Paste a prospect URL to crawl their site and quote on it.';
    if (state.status === 'ready') {
      return `${state.totalUrls} URL${state.totalUrls === 1 ? '' : 's'} crawled · ${state.categories.length} categor${state.categories.length === 1 ? 'y' : 'ies'}`;
    }
    if (state.status === 'failed') return 'Crawl failed — see details below.';
    if (state.status === 'retry_queued') {
      const ra = state.retryAt ? new Date(state.retryAt) : null;
      return ra ? `Retry queued — next attempt around ${ra.toLocaleTimeString()}` : 'Retry queued';
    }
    return `${STATUS_LABEL[state.status]} — ${state.totalUrls} URL${state.totalUrls === 1 ? '' : 's'} so far`;
  })();

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          all: 'unset', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, width: '100%', marginBottom: open ? 12 : 0,
        }}
        aria-expanded={open}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 18, height: 18, display: 'grid', placeItems: 'center',
            color: 'var(--fg-muted)', flexShrink: 0,
          }}>
            {open ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon.Globe size={11} /> Site scope
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              {headerSummary}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <>
          {err && (
            <div style={{
              padding: '8px 10px', marginBottom: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              borderRadius: 6, fontSize: 12,
            }}>{err}</div>
          )}

          {!state && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="https://prospect.example.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                disabled={busy}
                style={{
                  flex: 1, padding: '8px 10px',
                  background: 'var(--bg-sunk)',
                  border: '1px solid var(--divider)',
                  borderRadius: 6, fontSize: 13,
                }}
              />
              <button
                className="btn sm"
                disabled={busy || !siteUrl.trim()}
                onClick={() => void kickoff()}
              >
                {busy ? <><span className="spin" /> Starting…</> : <><Icon.Search size={11} /> Crawl site</>}
              </button>
            </div>
          )}

          {state && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                padding: '10px 12px', background: 'var(--bg-sunk)',
                borderRadius: 6, marginBottom: 12, fontSize: 12.5,
              }}>
                <span className="mono" style={{ color: 'var(--fg-muted)' }}>{state.siteUrl}</span>
                <span className="dot">·</span>
                <span><b>{state.totalUrls}</b> total</span>
                <span className="dot">·</span>
                <span><b>{state.classifiedUrls}</b> classified</span>
                <span className="dot">·</span>
                <span style={{
                  color:
                    state.status === 'ready' ? 'var(--ok)'
                    : state.status === 'failed' ? 'var(--danger)'
                    : 'var(--accent)',
                  fontWeight: 600,
                }}>{STATUS_LABEL[state.status]}</span>
              </div>

              {(state.status === 'pending' || state.status === 'crawling' || state.status === 'classifying' || state.status === 'retry_queued') && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px', fontSize: 12.5, color: 'var(--fg-muted)',
                }}>
                  <span className="spin" />
                  <span>
                    {state.status === 'crawling' && (state.options?.useJsRendering
                      ? `Rendering pages with headless Chromium (capped at ${state.options?.maxPages ?? 50} pages — slower than static).`
                      : `Walking same-origin links (capped at ${state.options?.maxPages ?? 500} pages).`)}
                    {state.status === 'classifying' && `Categorising ${state.totalUrls} URLs.`}
                    {state.status === 'pending' && 'Queued — starting shortly.'}
                    {state.status === 'retry_queued' && state.retryAt && `Retry around ${new Date(state.retryAt).toLocaleTimeString()} (attempt ${state.attempts + 1}).`}
                  </span>
                </div>
              )}

              {state.status === 'failed' && (
                <div style={{
                  padding: 12, marginBottom: 10,
                  background: 'var(--danger-tint)', color: 'var(--danger)',
                  borderRadius: 6, fontSize: 12.5,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Crawl failed after {state.attempts} attempt{state.attempts === 1 ? '' : 's'}</div>
                  <div style={{ color: 'var(--fg-muted)', wordBreak: 'break-word' }}>{state.error ?? 'Unknown error'}</div>
                </div>
              )}

              {state.status === 'ready' && state.spaCatchAll && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--warn-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--warn)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>SPA catch-all detected — only 1 distinct page found by static crawl</div>
                  <div style={{ color: 'var(--fg-muted)', marginBottom: 8 }}>
                    The server returns the same HTML for every URL. All routing is client-side JavaScript,
                    which the static crawler can&apos;t see. <b>Re-crawl with JavaScript rendering</b> to spin up a real
                    headless Chromium that executes the SPA and walks its rendered link graph.
                  </div>
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void reCrawl({ useJsRendering: true })}
                  >
                    {busy ? <><span className="spin" /> Starting…</> : <><Icon.Sparkle size={11} /> Re-crawl with JavaScript rendering</>}
                  </button>
                </div>
              )}

              {state.status === 'ready' && state.looksLikeSpa && !state.spaCatchAll && !state.options?.useJsRendering && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--warn-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--warn)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>This site looks like a JavaScript SPA</div>
                  <div style={{ color: 'var(--fg-muted)', marginBottom: 8 }}>
                    The static HTML has no anchor links, so the crawler walked common routes (<span className="mono">/about</span>, <span className="mono">/pricing</span>, <span className="mono">/blog</span>, …) instead.
                    Coverage is inherently incomplete — distinct pages found below are real, but the SPA likely has more routes that only render after JS executes.
                    Re-crawl with JavaScript rendering for full coverage.
                  </div>
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void reCrawl({ useJsRendering: true })}
                  >
                    {busy ? <><span className="spin" /> Starting…</> : <><Icon.Sparkle size={11} /> Re-crawl with JavaScript rendering</>}
                  </button>
                </div>
              )}

              {state.status === 'ready' && state.options?.useJsRendering && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--ok-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--ok)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>JavaScript rendering complete</div>
                  <div style={{ color: 'var(--fg-muted)' }}>
                    Rendered with headless Chromium — captured {state.totalUrls} distinct items including
                    rendered routes, backend API calls, and third-party integrations declared by the app.
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.techFingerprint && state.techFingerprint.platform !== 'unknown' && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--bg-elev)',
                  borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--divider)',
                }}>
                  <div style={{ marginBottom: state.techFingerprint.signals.length > 0 ? 4 : 0 }}>
                    <span style={{ color: 'var(--fg-muted)' }}>Detected platform </span>
                    <b className="mono">{state.techFingerprint.platform}</b>
                    {state.techFingerprint.generator && (
                      <span style={{ color: 'var(--fg-subtle)' }}>
                        {' '}· generator: <span className="mono">{state.techFingerprint.generator}</span>
                      </span>
                    )}
                  </div>
                  {state.techFingerprint.signals.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      Signals: {state.techFingerprint.signals.join(' · ')}
                    </div>
                  )}
                  {state.specsFound.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 4 }}>
                      ✓ Specs fetched: {state.specsFound.map((s) => <span key={s} className="mono" style={{ marginRight: 8 }}>{s}</span>)}
                    </div>
                  )}
                  {state.serviceWorkersFound.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>
                      ✓ Service workers harvested: {state.serviceWorkersFound.length}
                    </div>
                  )}
                  {state.manifest && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                      ✓ PWA manifest: {state.manifest.name ?? '(unnamed)'}
                      {state.manifest.shortcuts.length > 0 && ` · ${state.manifest.shortcuts.length} shortcuts`}
                    </div>
                  )}
                </div>
              )}

              {state.status === 'ready' && (state.totalFormFields > 0 || state.jsBundleCount > 0 || state.cssFileCount > 0) && (
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 14,
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--bg-elev)',
                  borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--divider)',
                }}>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>Form input fields </span>
                    <b className="mono">{state.totalFormFields}</b>
                    <span style={{ color: 'var(--fg-subtle)' }}> · injection points across all rendered pages</span>
                  </div>
                  <div style={{ color: 'var(--fg-subtle)' }}>·</div>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>JS bundles </span>
                    <b className="mono">{state.jsBundleCount}</b>
                  </div>
                  <div style={{ color: 'var(--fg-subtle)' }}>·</div>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>CSS files </span>
                    <b className="mono">{state.cssFileCount}</b>
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.categories.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>Category breakdown</div>
                  <div style={{ border: '1px solid var(--divider)', borderRadius: 6, overflow: 'hidden' }}>
                    {state.categories.map((c, idx) => (
                      <CategoryRow
                        key={c.category}
                        category={c}
                        sameHost={siteHost(state.siteUrl)}
                        isLast={idx === state.categories.length - 1}
                      />
                    ))}
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.categories.length === 0 && (
                <div style={{ padding: 12, fontSize: 12.5, color: 'var(--fg-muted)' }}>
                  Crawl finished but no URLs were discovered.
                </div>
              )}

              {quotePreview && (
                <QuoteBreakdownCard preview={quotePreview} />
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {state.status === 'ready' && (
                  <button className="btn sm" disabled={busy || parentBusy} onClick={() => void computeQuote()}>
                    {busy || parentBusy
                      ? <><span className="spin" /> Computing…</>
                      : <><Icon.Sparkle size={11} /> Compute quote</>}
                  </button>
                )}
                {state.status === 'ready' && state.totalUrls > 0 && (
                  <>
                    <button className="btn sm ghost" disabled={busy} onClick={() => setShowAll(true)}>
                      <Icon.Eye size={11} /> View all {state.totalUrls} items
                    </button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => void downloadCsv()}>
                      <Icon.Download size={11} /> Download CSV
                    </button>
                  </>
                )}
                {(state.status === 'ready' || state.status === 'failed') && (
                  <button className="btn sm ghost" disabled={busy} onClick={() => void reCrawl()}>
                    <Icon.Search size={11} /> Re-crawl
                  </button>
                )}
                {state.status === 'failed' && (
                  <button className="btn sm" disabled={busy} onClick={() => void retry()}>
                    <Icon.Sparkle size={11} /> Retry
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {showAll && state && (
        <DiscoveredPagesModal
          engagementId={engagementId}
          siteUrl={state.siteUrl}
          onClose={() => setShowAll(false)}
        />
      )}
    </div>
  );
}

/** A single category row. Expandable when the breakdown is meaningful
 *  (lots of items, OR API category with sub-groups worth showing). */
function CategoryRow({
  category,
  sameHost,
  isLast,
}: {
  category: SiteEnumerationCategorySummary;
  sameHost: string | undefined;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = category.examples.length > 3 || category.category === 'api';

  // For the API category, group examples by URL pattern so the tech
  // person sees Supabase tables / RPCs / REST paths separately.
  const apiSubgroups = category.category === 'api'
    ? groupApiExamples(category.examples)
    : null;

  return (
    <div
      style={{
        padding: '10px 12px',
        borderBottom: isLast ? 'none' : '1px solid var(--divider)',
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'grid', gridTemplateColumns: '1fr auto',
          alignItems: 'baseline', cursor: expandable ? 'pointer' : 'default',
        }}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {expandable && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
              {open ? <Icon.ChevronDown size={11} /> : <Icon.ChevronRight size={11} />}
            </span>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{CATEGORY_LABEL[category.category] ?? category.category}</div>
            {!open && apiSubgroups && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                {apiSubgroups.map((g) => `${API_SUBGROUP_LABEL[g.sub]}: ${g.items.length}`).join('  ·  ')}
              </div>
            )}
            {!open && !apiSubgroups && category.examples[0] && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                {category.examples.slice(0, 3).map((ex, i) => (
                  <div key={ex.url + i} className="mono" style={{ wordBreak: 'break-all' }}>
                    {urlPath(ex.url, sameHost)}
                  </div>
                ))}
                {category.examples.length > 3 && (
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                    + {category.examples.length - 3} more — click to expand
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mono" style={{ fontWeight: 600, paddingLeft: 12 }}>{category.count}</div>
      </div>

      {open && apiSubgroups && (
        <div style={{ marginTop: 10, paddingLeft: 16 }}>
          {apiSubgroups.map((g) => (
            <div key={g.sub} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {API_SUBGROUP_LABEL[g.sub]} <span style={{ color: 'var(--fg-muted)' }}>({g.items.length})</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 4, fontSize: 11.5, color: 'var(--fg-muted)',
              }}>
                {g.items.map((name, i) => (
                  <div key={name + i} className="mono" style={{ wordBreak: 'break-all' }}>{name}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && !apiSubgroups && category.examples.length > 3 && (
        <div style={{ marginTop: 10, paddingLeft: 16, fontSize: 11.5, color: 'var(--fg-muted)' }}>
          {category.examples.map((ex, i) => (
            <div key={ex.url + i} className="mono" style={{ wordBreak: 'break-all' }}>
              {urlPath(ex.url, sameHost)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupApiExamples(examples: SiteEnumerationCategorySummary['examples']) {
  const groups = new Map<ApiSubGroup, string[]>();
  for (const ex of examples) {
    const { sub, name } = classifyApiUrl(ex.url);
    const list = groups.get(sub) ?? [];
    if (!list.includes(name)) list.push(name);
    groups.set(sub, list);
  }
  // Stable order: tables, RPCs, REST paths, XHR.
  const order: ApiSubGroup[] = ['supabase_table', 'supabase_rpc', 'rest_path', 'xhr_call'];
  return order
    .filter((s) => groups.has(s))
    .map((s) => ({ sub: s, items: (groups.get(s) ?? []).sort() }));
}

/** Quote breakdown — every line item from the rate card walk, with
 *  the matched service line, scope (unit + value), tier, and price.
 *  Each row is expandable to show: where the scope value came from,
 *  the math (qty × unit-price), and the methodology rationale. */
function QuoteBreakdownCard({ preview }: { preview: SiteEnumQuotePreview }) {
  const fmt = (cents: number) => formatMoney(cents, preview.currency);
  const sortedLines = [...preview.lines].sort((a, b) => b.priceCents - a.priceCents);
  const totalDiscovered = sortedLines.reduce((n, l) => n + (l.unmatched || l.manualQuoteRequired ? 0 : l.priceCents), 0);
  const flaggedCount = sortedLines.filter((l) => l.unmatched || l.manualQuoteRequired).length;
  return (
    <div style={{
      padding: '14px 16px', marginBottom: 12,
      background: 'var(--bg-elev)', borderRadius: 6,
      border: '1px solid var(--divider)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Approximate base quote
        </span>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{fmt(preview.totalCents)}</span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 10 }}>
        Walked rate card <span className="mono">{preview.rateCardId.slice(0, 8)}</span>
        {' '}— {preview.lines.length} line item{preview.lines.length === 1 ? '' : 's'}, click any row for the math.
        {flaggedCount > 0 && ` ${flaggedCount} row${flaggedCount === 1 ? '' : 's'} flagged.`}
      </div>

      <div style={{ border: '1px solid var(--divider)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '6px 10px', background: 'var(--bg-sunk)',
          fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          <div>Service line</div>
          <div>Scope</div>
          <div>Tier matched</div>
          <div style={{ textAlign: 'right' }}>Price</div>
        </div>
        {sortedLines.map((line) => (
          <QuoteLineRow key={line.entityId + line.serviceLineSlug} line={line} fmt={fmt} />
        ))}
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '8px 10px',
          borderTop: '2px solid var(--divider)',
          background: 'var(--bg-sunk)',
          fontSize: 12, fontWeight: 700,
        }}>
          <div>Total <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: 11 }}>(priced lines only)</span></div>
          <div></div>
          <div></div>
          <div className="mono" style={{ textAlign: 'right' }}>{fmt(totalDiscovered)}</div>
        </div>
      </div>

      <EstimationMethodologyPanel preview={preview} />
    </div>
  );
}

/** A single quote line that opens to show the math + provenance. */
function QuoteLineRow({ line, fmt }: { line: BasePriceLine; fmt: (cents: number) => string }) {
  const [open, setOpen] = useState(false);
  const failed = !!line.unmatched;
  const manual = !!line.manualQuoteRequired;
  const provenance = describeProvenance(line);
  const math = describeMath(line, fmt);
  const methodologyNote = describeMethodology(line);

  return (
    <>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '8px 10px', fontSize: 12,
          borderTop: '1px solid var(--divider)',
          alignItems: 'baseline', cursor: 'pointer',
          background: failed ? 'var(--danger-tint)' : manual ? 'var(--warn-tint)' : 'transparent',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
            {open ? <Icon.ChevronDown size={11} /> : <Icon.ChevronRight size={11} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>
              {line.serviceLineName || line.serviceLineSlug}
              {line.entityId.endsWith(':estimated') && (
                <span style={{
                  marginLeft: 6, padding: '1px 6px', borderRadius: 3,
                  background: 'var(--warn-tint)', color: 'var(--warn)',
                  fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3,
                }}>
                  estimated
                </span>
              )}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 1 }}>
              {line.entityId}
            </div>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11.5 }}>
          {line.scopeValue} {line.scopeUnit}
        </div>
        <div style={{ fontSize: 11.5, color: failed ? 'var(--danger)' : 'var(--fg-muted)' }}>
          {failed
            ? `Unmatched: ${line.unmatched?.reason ?? 'no tier'}`
            : manual
              ? 'Open-priced — manual quote'
              : (line.tierLabel || 'auto-matched')}
        </div>
        <div className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
          {failed || manual ? '—' : fmt(line.priceCents)}
        </div>
      </div>
      {open && (
        <div style={{
          padding: '10px 14px 12px 32px', fontSize: 11.5,
          background: 'var(--bg-sunk)',
          borderTop: '1px solid var(--divider)',
          color: 'var(--fg-muted)', lineHeight: 1.6,
        }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Where this came from: </span>
            {provenance}
          </div>
          {math && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Math: </span>
              <span className="mono">{math}</span>
            </div>
          )}
          {methodologyNote && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Methodology: </span>
              {methodologyNote}
            </div>
          )}
          {failed && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--danger-tint)', borderRadius: 4, color: 'var(--fg)' }}>
              <b style={{ color: 'var(--danger)' }}>Action:</b> add a service line whose slug contains
              {' '}<span className="mono">{slugHintFor(line.entityId)}</span>{' '}to the rate card so this scope can be priced.
            </div>
          )}
          {manual && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--warn-tint)', borderRadius: 4, color: 'var(--fg)' }}>
              This service is open-priced — quote manually with the client.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Map the ScopedEntity's entityId back to a human description of
 *  what the crawler actually saw. The mapper writes these IDs in a
 *  predictable shape — `site-enum:<category>` or
 *  `site-enum:<derived>:[estimated]`. */
function describeProvenance(line: BasePriceLine): string {
  const id = line.entityId;
  if (id === 'site-enum:cms') {
    return 'Distinct routes the crawler navigated to and rendered (excluding login / form / API pages classified separately).';
  }
  if (id === 'site-enum:product') return 'Routes whose path tokens match product/catalog patterns.';
  if (id === 'site-enum:ecommerce') return 'Routes matching cart / checkout / store patterns.';
  if (id === 'site-enum:blog') return 'Routes matching blog / news / article patterns.';
  if (id === 'site-enum:knowledge_base') return 'Routes matching docs / KB / help patterns.';
  if (id === 'site-enum:form') return 'Pages with prominent form elements (contact / lead / survey).';
  if (id === 'site-enum:members') return 'Auth / portal / dashboard / login routes — anything behind authentication.';
  if (id === 'site-enum:api') {
    return 'Backend HTTP endpoints — captured via XHR/fetch during JS render plus Supabase tables / RPC calls / REST path strings parsed out of the loaded JS bundles.';
  }
  if (id === 'site-enum:integration') {
    return 'Third-party services declared via preconnect / dns-prefetch tags or detected through cross-origin XHR (Razorpay, Google OAuth, Supabase, etc.).';
  }
  if (id === 'site-enum:web_input_fields') {
    return 'Sum of <input>, <textarea>, <select> elements counted directly from the rendered DOM of every crawled page.';
  }
  if (id === 'site-enum:api_input_fields:estimated') {
    return 'Estimated from the discovered API endpoint count × 1.5 input fields per endpoint (conservative — typical REST endpoint takes 1-3 input fields). Not measured directly without OpenAPI spec / authentication.';
  }
  if (id.startsWith('site-enum:')) return `Items classified as "${id.replace('site-enum:', '')}" by the crawler.`;
  return 'Discovered during site enumeration.';
}

/** Render the per-line math depending on pricing model. */
function describeMath(line: BasePriceLine, fmt: (cents: number) => string): string | null {
  if (line.unmatched || line.manualQuoteRequired) return null;
  if (line.pricingModel === 'per_unit' && line.unitPriceCents != null) {
    return `${line.scopeValue} ${line.scopeUnit} × ${fmt(line.unitPriceCents)}/unit  =  ${fmt(line.priceCents)}`;
  }
  // tier_lookup / flat — the tier price IS the line price.
  return `Flat tier price: ${fmt(line.priceCents)} (matched bracket "${line.tierLabel ?? '—'}")`;
}

/** Brief note explaining why a particular methodology was chosen. */
function describeMethodology(line: BasePriceLine): string | null {
  if (line.unmatched || line.manualQuoteRequired) return null;
  if (line.methodology === 'grey_box') {
    return `grey_box — this service line only has tiers for grey-box testing (requires test credentials).`;
  }
  if (line.methodology === 'black_box') {
    return `black_box — default for external customers (no credentials supplied).`;
  }
  if (line.methodology === 'white_box') {
    return `white_box — full source-code access required.`;
  }
  return null;
}

/** Suggest a slug substring for unmatched lines so the rep knows what
 *  to add to the rate card. */
function slugHintFor(entityId: string): string {
  if (entityId === 'site-enum:integration') return 'third_party_integration';
  if (entityId === 'site-enum:attachment') return 'document_attachment';
  if (entityId === 'site-enum:media') return 'media_asset';
  if (entityId === 'site-enum:module') return 'app_module';
  return 'matching slug';
}

/** Full-screen overlay listing every discovered page. Searchable +
 *  filterable by category. Backs the "View all N items" button on
 *  the SiteScopeCard. */
function DiscoveredPagesModal({
  engagementId,
  siteUrl,
  onClose,
}: {
  engagementId: string;
  siteUrl: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DiscoveredPageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  useEffect(() => {
    siteEnumeration.listPages(engagementId)
      .then(setRows)
      .catch((e) => setErr(describeError(e)));
  }, [engagementId]);

  // Close on Escape — common modal affordance.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = rows
    ? [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))].sort()
    : [];
  const filtered = (rows ?? []).filter((r) => {
    if (categoryFilter && r.category !== categoryFilter) return false;
    if (!filter) return true;
    const f = filter.toLowerCase();
    return (
      r.url.toLowerCase().includes(f) ||
      (r.title ?? '').toLowerCase().includes(f) ||
      (r.category ?? '').toLowerCase().includes(f)
    );
  });
  const sameHost = siteHost(siteUrl);

  return (
    <Portal>
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            background: 'var(--bg)', borderRadius: 8,
            width: 'min(1200px, 95vw)', maxHeight: '90vh',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>All discovered items</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                {siteUrl}
              </div>
            </div>
            <button className="btn sm ghost" onClick={onClose}>
              <Icon.X size={11} /> Close
            </button>
          </div>

          <div style={{
            padding: '10px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <input
              type="text"
              placeholder="Filter URL / title / category…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                flex: 1, minWidth: 200, padding: '6px 10px',
                background: 'var(--bg-sunk)', borderRadius: 4,
                border: '1px solid var(--divider)', fontSize: 12,
              }}
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                background: 'var(--bg-sunk)', borderRadius: 4,
                border: '1px solid var(--divider)', fontSize: 12,
              }}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c as SiteUrlCategory] ?? c}</option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              Showing <b>{filtered.length}</b> of <b>{rows?.length ?? '…'}</b> items
            </span>
          </div>

          <div style={{ overflow: 'auto', flex: 1 }}>
            {err && (
              <div style={{ padding: 14, color: 'var(--danger)', fontSize: 12 }}>{err}</div>
            )}
            {!rows && !err && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-muted)' }}>
                <span className="spin" /> Loading…
              </div>
            )}
            {rows && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-sunk)', position: 'sticky', top: 0 }}>
                    <th style={th()}>Category</th>
                    <th style={th()}>URL</th>
                    <th style={th()}>Title</th>
                    <th style={th()}>HTTP</th>
                    <th style={th()}>Source</th>
                    <th style={th()}>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr key={r.url + i} style={{ borderBottom: '1px solid var(--divider)' }}>
                      <td style={td()}>
                        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                          {r.category ? (CATEGORY_LABEL[r.category as SiteUrlCategory] ?? r.category) : '—'}
                        </span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                          {urlPath(r.url, sameHost)}
                        </span>
                      </td>
                      <td style={td()}>
                        <span style={{ fontSize: 11.5 }}>{r.title ?? '—'}</span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11 }}>{r.httpStatus ?? '—'}</span>
                      </td>
                      <td style={td()}>
                        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                          {r.classifierSource ?? '—'}
                        </span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11 }}>
                          {r.classifierConfidence != null ? r.classifierConfidence.toFixed(2) : '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

function th(): React.CSSProperties {
  return {
    textAlign: 'left', padding: '8px 12px',
    fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
    textTransform: 'uppercase', letterSpacing: 0.4,
    borderBottom: '1px solid var(--divider)',
  };
}
function td(): React.CSSProperties {
  return { padding: '6px 12px', verticalAlign: 'top' };
}

/** Quick-reference card: every estimation rule + assumption used to
 *  produce derived line items. Surfaces what's measured vs what's
 *  inferred so the rep can defend the quote to the client. */
function EstimationMethodologyPanel({ preview }: { preview: SiteEnumQuotePreview }) {
  const hasEstimated = preview.lines.some((l) => l.entityId.endsWith(':estimated'));
  const hasUnmatched = preview.hasUnmatched;
  const hasManual = preview.hasManualQuoteRequired;
  if (!hasEstimated && !hasUnmatched && !hasManual) return null;
  return (
    <div style={{
      padding: '12px 14px', marginTop: 8, marginBottom: 12,
      background: 'var(--bg-sunk)', borderRadius: 6,
      border: '1px solid var(--divider)', fontSize: 11.5,
      color: 'var(--fg-muted)', lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
        How the quote was derived
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>
          <b>Pages</b> — counted from distinct same-origin URLs the JS-rendering crawler
          successfully fetched. SPAs flip from <span className="mono">static_pages</span> to
          {' '}<span className="mono">dynamic_pages</span> (higher per-unit price).
        </li>
        <li>
          <b>API endpoints</b> — measured: cross-origin XHR/fetch captured during render
          plus Supabase tables / RPC names / literal REST paths grep&apos;d out of every
          loaded JS bundle (recursive chunk discovery).
        </li>
        <li>
          <b>Web app input fields</b> — measured: live DOM count of
          {' '}<span className="mono">&lt;input&gt;</span>,
          {' '}<span className="mono">&lt;textarea&gt;</span>,
          {' '}<span className="mono">&lt;select&gt;</span> per rendered page, summed.
        </li>
        <li>
          <b>API input fields <span style={{ color: 'var(--warn)' }}>(estimated)</span></b> —
          derived as <span className="mono">round(API endpoints × 1.5)</span>. Conservative —
          typical REST endpoint takes 1-3 input fields. Not directly measurable without
          OpenAPI spec or authenticated probing.
        </li>
        <li>
          <b>Methodology</b> — auto-picked per service line. <span className="mono">black_box</span>
          {' '}for external customers by default; service lines that only have
          {' '}<span className="mono">grey_box</span> tiers (login modules, etc.) flip
          automatically since black_box would never match.
        </li>
        <li>
          <b>Tier matched</b> — pricing engine picks the first tier whose range contains the
          scope value, filtered by methodology + customer type. Per-unit lines multiply by
          the scope value; tier-lookup lines are flat per bracket.
        </li>
        {hasUnmatched && (
          <li style={{ color: 'var(--danger)' }}>
            <b>Unmatched rows</b> — categories the rate card has no slug for. Add the slug
            (suggested below each row) and re-quote to capture them.
          </li>
        )}
        {hasManual && (
          <li style={{ color: 'var(--warn)' }}>
            <b>Open-priced rows</b> — service lines marked manual-quote on the rate card.
            Negotiate with the client and enter the price by hand.
          </li>
        )}
      </ul>
    </div>
  );
}

// ── Extracted points (client-uploaded documents) ─────────────────────────

/**
 * Renders every file the client attached + the structured points the
 * extraction pipeline pulled out. Polls every 5s while any file is
 * still in `pending` / `processing` so the user sees points appear
 * as the LLM finishes each document. Hides itself entirely when the
 * engagement has zero files (the common case for templates without
 * an `allowFiles` question).
 */
function ExtractedPointsCard({ engagementId }: { engagementId: string }) {
  const [files, setFiles] = useState<FileExtraction[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openText, setOpenText] = useState<Set<string>>(new Set());
  void openText; // reserved for future per-file raw-text preview toggle
  // Per-file "Parsed structure" panel state. Map: fileId → loading/loaded
  // ParsedDocument or null when expanded but the row has no Document.
  const [parsedDocs, setParsedDocs] = useState<Record<string, ParsedDocument | null | 'loading'>>({});
  // Top-level collapse: by default the whole "Extracted from client documents"
  // card is closed once everything is ready, so it doesn't dwarf the rest of
  // the page. We auto-open while files are in flight (so the rep sees points
  // appear in real time), and stay open if the user manually expanded.
  const [cardOpen, setCardOpen] = useState<boolean>(true);
  const [userToggled, setUserToggled] = useState(false);
  // Per-file: the long list of extracted points (scope rows + every "other"
  // identity/contact field) collapses by default. Inferred-for-pricing stays
  // visible since it's the actionable bit.
  const [openPoints, setOpenPoints] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const list = await extraction.list(engagementId);
      setFiles(list);
    } catch (e) {
      setErr(describeError(e));
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while any file is in flight. 5s matches our other Gamma /
  // status loops — fast enough that the UI feels live, slow enough
  // we don't hammer the API for engagements with 5+ documents.
  useEffect(() => {
    if (!files) return;
    // Keep polling for retry_queued too — the cron flips them back to
    // processing on its own, and the rep needs to see that transition.
    const inFlight = files.some(
      (f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued',
    );
    if (!inFlight) return;
    const handle = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(handle);
  }, [files, refresh]);

  // Auto-collapse rule: when nothing is in flight any more, fold the card
  // shut so the page stays compact. Skip if the user manually toggled —
  // we don't want to override an explicit "show me everything" intent.
  useEffect(() => {
    if (!files || userToggled) return;
    const inFlight = files.some(
      (f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued',
    );
    setCardOpen(inFlight);
  }, [files, userToggled]);

  async function reExtract(fileId: string) {
    setBusyId(fileId); setErr(null);
    try {
      await extraction.reExtract(engagementId, fileId);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Re-run only Layer-3 mapping (no full re-extract). Cheap path: skips
   * S3 fetch + text extraction, reuses the cached extracted_points to
   * call the LLM mapper again. Use after a 429 rate-limit or to pick up
   * tweaked rate-card hints / new enrichment without paying for a full
   * pass.
   */
  async function rerunMapping(fileId: string) {
    setBusyId(fileId); setErr(null);
    try {
      await extraction.rerunInference(engagementId, fileId);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Toggle the "Parsed structure" panel for a file. First open lazy-
   * loads the canonical RhudDocument; subsequent toggles reuse the
   * cached state. Setting `undefined` collapses the panel entirely.
   */
  async function toggleParsedDoc(fileId: string) {
    setParsedDocs((prev) => {
      // Already loaded or loading → collapse by removing the key.
      if (fileId in prev) {
        const next = { ...prev };
        delete next[fileId];
        return next;
      }
      // Mark loading immediately so the UI shows a spinner.
      return { ...prev, [fileId]: 'loading' };
    });
    if (fileId in parsedDocs) return; // collapsing — nothing to fetch
    try {
      const out = await extraction.parsedDocument(engagementId, fileId);
      setParsedDocs((prev) => ({ ...prev, [fileId]: out.document }));
    } catch (e) {
      setErr(describeError(e));
      setParsedDocs((prev) => {
        const next = { ...prev };
        delete next[fileId]; // collapse on error so the user can retry
        return next;
      });
    }
  }

  // Don't render the card at all when there are no files — adds noise
  // for templates that don't ask for attachments.
  if (files === null) return null;
  if (files.length === 0) return null;

  const anyInFlight = files.some(
    (f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued',
  );
  const totalPoints = files.reduce((s, f) => s + f.points.length, 0);
  const totalInferred = files.reduce((s, f) => s + f.inferredEntities.length, 0);

  function toggleCard() {
    setUserToggled(true);
    setCardOpen((v) => !v);
  }
  function togglePoints(fileId: string) {
    setOpenPoints((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      {/* Click-anywhere header that toggles the whole card */}
      <button
        type="button"
        onClick={toggleCard}
        style={{
          all: 'unset',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          width: '100%',
          marginBottom: cardOpen ? 12 : 0,
        }}
        aria-expanded={cardOpen}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 18, height: 18, display: 'grid', placeItems: 'center',
            color: 'var(--fg-muted)', flexShrink: 0,
          }}>
            {cardOpen ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="section-label">Extracted from client documents</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              {anyInFlight
                ? 'Processing documents — pricing waits until everything is read.'
                : (
                  <>
                    <b>{files.length}</b> file{files.length === 1 ? '' : 's'}
                    <span style={{ color: 'var(--fg-subtle)' }}> · </span>
                    <b>{totalPoints}</b> data point{totalPoints === 1 ? '' : 's'}
                    {totalInferred > 0 && (
                      <>
                        <span style={{ color: 'var(--fg-subtle)' }}> · </span>
                        <b>{totalInferred}</b> inferred for pricing
                      </>
                    )}
                  </>
                )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {anyInFlight && (
            <span className="chip warn"><Icon.Clock size={10} /> Processing</span>
          )}
          {!anyInFlight && totalInferred > 0 && (
            <span className="chip ok" style={{ fontSize: 10.5 }}>
              <Icon.Check size={10} /> Ready
            </span>
          )}
        </div>
      </button>

      {cardOpen && (
        <>
          {err && (
            <div style={{
              padding: 10, fontSize: 12.5, marginBottom: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{err}</div>
          )}

          {!anyInFlight && files[0]?.diagnostics && (
            <PipelineDiagnostic d={files[0].diagnostics} totalExtracted={totalPoints} />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {files.map((f) => {
              const pointsOpen = openPoints.has(f.id);
              return (
                <div key={f.id} style={{
                  padding: 12, borderRadius: 8,
                  background: 'var(--bg-sunk)',
                  border: '1px solid var(--divider)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: fileColor(f.contentType), color: '#fff',
                      display: 'grid', placeItems: 'center',
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                      flexShrink: 0,
                    }}>{fileGlyph(f.contentType, f.filename)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.filename}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                        <ExtractionStatusChip
                          status={f.status}
                          pointCount={f.points.length}
                          retryAt={f.retryAt}
                          attempts={f.attempts}
                        />
                        {f.error && f.status !== 'ready' && (
                          <span style={{ marginLeft: 8, color: 'var(--fg-subtle)' }} title={f.error}>
                            · {humaniseExtractionError(f.error)}
                          </span>
                        )}
                      </div>
                    </div>
                    {/*
                      Parsed structure: shows the canonical RhudDocument
                      (every cell / page / heading) the parser captured
                      BEFORE any LLM step ran. Lets the rep diagnose
                      "did the parser miss something?" separately from
                      "did the LLM mapper choose poorly?". Lazy-loaded
                      on first open.
                    */}
                    {f.status === 'ready' && (
                      <button
                        className="btn sm ghost"
                        onClick={() => void toggleParsedDoc(f.id)}
                        title="Show the structured representation we captured from this file before any LLM step ran"
                      >
                        {parsedDocs[f.id] === 'loading'
                          ? <span className="spin" />
                          : <><Icon.Sparkle size={11} /> {f.id in parsedDocs ? 'Hide' : 'Show'} parsed structure</>}
                      </button>
                    )}
                    {/*
                      Re-run mapping: cheap path that re-classifies cached
                      extracted_points without paying for a full S3 fetch
                      + text-extraction round trip. Only available when
                      points are present (status='ready' AND the file
                      actually produced points). Best after a 429 fallback
                      or after rate-card hints are retuned.
                    */}
                    {f.status === 'ready' && f.points.length > 0 && (
                      <button
                        className="btn sm ghost"
                        disabled={busyId === f.id}
                        onClick={() => void rerunMapping(f.id)}
                        title="Re-classify the existing extracted points without re-fetching the file (use after a rate-limit fallback or rate-card retune)"
                      >
                        {busyId === f.id ? <span className="spin" /> : <><Icon.Sparkle size={11} /> Re-run mapping</>}
                      </button>
                    )}
                    {(f.status === 'ready' || f.status === 'failed' || f.status === 'skipped' || f.status === 'retry_queued' || f.status == null) && (
                      <button
                        className="btn sm ghost"
                        disabled={busyId === f.id}
                        onClick={() => void reExtract(f.id)}
                        title="Re-run extraction on this file"
                      >
                        {busyId === f.id ? <span className="spin" /> : <><Icon.Sparkle size={11} /> Re-extract</>}
                      </button>
                    )}
                  </div>

                  <SheetBreakdown points={f.points} />

                  {/*
                    Parsed-structure panel — renders the canonical
                    RhudDocument captured at parse time, BEFORE any LLM
                    step. Lazy-loaded; "Hide" collapses without losing
                    the cached state.
                  */}
                  {f.id in parsedDocs && parsedDocs[f.id] !== 'loading' && (
                    <ParsedDocumentPanel doc={parsedDocs[f.id] as ParsedDocument | null} />
                  )}

                  {f.inferredEntities.length > 0 && (
                    <InferredEntitiesSection
                      engagementId={engagementId}
                      fileId={f.id}
                      entities={f.inferredEntities}
                      onChange={() => void refresh()}
                    />
                  )}

                  {f.points.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => togglePoints(f.id)}
                        style={{
                          fontSize: 11.5,
                          color: 'var(--fg-muted)',
                          padding: '4px 8px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        {pointsOpen ? <Icon.ChevronDown size={12} /> : <Icon.ChevronRight size={12} />}
                        {pointsOpen ? 'Hide' : 'Show'} all {f.points.length} extracted point{f.points.length === 1 ? '' : 's'}
                      </button>
                      {pointsOpen && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                          {f.points.map((p, i) => (
                            <div key={`${f.id}-${i}`} style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(120px, 200px) 1fr',
                              gap: 12,
                              padding: '6px 8px',
                              borderRadius: 6,
                              background: 'var(--bg)',
                              fontSize: 12.5,
                              alignItems: 'baseline',
                            }}>
                              <div style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.category && <CategoryChip category={p.category} />}
                                {p.key}
                                {p.sheet && (
                                  <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--fg-subtle)' }}>
                                    · {p.sheet}
                                  </span>
                                )}
                                {p.relatedQuestion && (
                                  <span className="chip outline" style={{ fontSize: 10, marginLeft: 6, padding: '0 5px' }}>
                                    {p.relatedQuestion}
                                  </span>
                                )}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ wordBreak: 'break-word' }}>{p.value}</div>
                                {p.sourceQuote && (
                                  <div style={{
                                    marginTop: 2, fontSize: 11, color: 'var(--fg-subtle)', fontStyle: 'italic',
                                    borderLeft: '2px solid var(--divider)', paddingLeft: 6,
                                  }}>
                                    “{p.sourceQuote}”
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {f.emptyResult && (
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontStyle: 'italic', marginTop: 4 }}>
                      Extracted, but nothing pricing-relevant found in this file.
                    </div>
                  )}

                  {(f.status === 'processing' || f.status === 'pending') && (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span className="spin" /> Reading the file…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Pipeline-of-counters strip: shows where the chain breaks when the
 * predicted price comes back at INR 0. Reads as five steps:
 *
 *   {extracted}  →  {matched}  →  {answered}  →  {priced}  →  rate-card status
 *
 * Examples:
 *   47 extracted → 0 matched     → fuzzy match too tight, lower threshold or rephrase template Qs
 *   47 extracted → 12 matched    → 12 answered → 0 priced → template Qs lack rate-card bindings
 *   47 → 12 → 12 → 5 priced      → working, base reflects the 5 line items
 *
 * Each step is a chip with the counter and a tooltip explaining what
 * "no progress past here" would imply.
 */
function PipelineDiagnostic({
  d, totalExtracted,
}: {
  d: FileExtraction['diagnostics'];
  totalExtracted: number;
}) {
  const steps: Array<{
    label: string;
    value: number | string;
    tone: 'ok' | 'warn' | 'danger' | 'muted';
    title: string;
  }> = [
    {
      label: 'extracted',
      value: totalExtracted,
      tone: totalExtracted > 0 ? 'ok' : 'danger',
      title: 'Total data points the structured parser pulled from all uploaded files.',
    },
    {
      label: 'matched',
      value: d.matchedToQuestion,
      tone: d.matchedToQuestion > 0 ? 'ok' : 'warn',
      title: d.matchedToQuestion > 0
        ? 'Layer 2: points that matched a template question (will auto-promote to answers).'
        : 'No points matched any template question. The Layer-3 inferred path can still produce a price.',
    },
    {
      label: 'inferred',
      value: d.inferredHighConfidence,
      tone: d.inferredHighConfidence > 0 ? 'ok' : 'warn',
      title: d.inferredHighConfidence > 0
        ? 'Layer 3: service-line entities the field mapper inferred (LLM-first, ≥0.6 confidence).'
        : 'Layer 3 produced no high-confidence entities. The LLM didn\'t see explicit evidence of any service line, or fell back to heuristics that found no domain keywords.',
    },
    {
      label: 'mapped',
      value: d.mappedToRateCard,
      tone: d.mappedToRateCard > 0 ? 'ok' : 'warn',
      title: d.mappedToRateCard > 0
        ? 'Layer 4-5: inferred entities that survived to the priced quote (rate-card tier match).'
        : 'No service lines made it to the priced quote. Either inference returned nothing or every entity hit `unmatched` in tier lookup.',
    },
    {
      label: 'answered',
      value: d.answeredQuestions,
      tone: d.answeredQuestions > 0 ? 'ok' : 'warn',
      title: 'Engagement-wide answer count (form answers + auto-promoted from extraction).',
    },
    {
      label: 'priced',
      value: d.quoteLineItems,
      tone: d.quoteLineItems > 0 ? 'ok' : 'danger',
      title: d.quoteLineItems > 0
        ? 'Answers that produced bookable line items via the rate card.'
        : 'No answer produced a priced line item. Either the template questions lack rate-card bindings, or the rate card has no tier matching the values.',
    },
    {
      label: 'rate card',
      value: d.rateCardBound ? '✓' : '✗',
      tone: d.rateCardBound ? 'ok' : 'danger',
      title: d.rateCardBound
        ? 'Template has a rate card bound — pricing will run.'
        : 'Template has no rate card bound. Open the template and pick one before re-predicting.',
    },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      padding: '8px 10px', marginBottom: 10,
      background: 'var(--bg-sunk)', borderRadius: 8,
      fontSize: 11.5,
    }}>
      <span style={{ color: 'var(--fg-muted)', marginRight: 4 }}>Pipeline:</span>
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            className={`chip ${s.tone === 'ok' ? 'ok' : s.tone === 'danger' ? 'danger' : s.tone === 'warn' ? 'warn' : 'outline'}`}
            title={s.title}
            style={{ fontSize: 10.5 }}
          >
            <b style={{ marginRight: 4 }}>{s.value}</b>{s.label}
          </span>
          {i < steps.length - 1 && (
            <span style={{ color: 'var(--fg-subtle)' }}>→</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Parsed-structure debug panel — renders the canonical RhudDocument
 * the parser captured. Shows sheets as cell grids and text blocks as
 * heading-bounded sections. The point is to answer "what did the
 * parser actually see from this file?" separately from "what did the
 * LLM mapper do with it?"
 *
 * Empty/null doc → tiny note ("no structured representation captured").
 * Legacy rows + plain-text formats hit this branch.
 */
function ParsedDocumentPanel({ doc }: { doc: ParsedDocument | null }) {
  if (!doc) {
    return (
      <div style={{
        marginTop: 10, padding: 10, fontSize: 11.5,
        color: 'var(--fg-subtle)',
        background: 'var(--bg-sunk)',
        border: '1px dashed var(--divider)',
        borderRadius: 6,
      }}>
        No structured representation was captured for this file. (Legacy
        row, plain text, or the parser fell through to the LLM-only path.)
      </div>
    );
  }
  return (
    <div style={{
      marginTop: 10,
      padding: '12px 14px',
      background: 'var(--bg-sunk)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Icon.Sparkle size={11} />
        <span style={{ fontWeight: 600 }}>Parsed structure</span>
        <span style={{ color: 'var(--fg-subtle)' }}>
          · {doc.sheets.length} sheet{doc.sheets.length === 1 ? '' : 's'}
          {doc.textBlocks.length > 0 && ` · ${doc.textBlocks.length} text block${doc.textBlocks.length === 1 ? '' : 's'}`}
          {doc.warnings.length > 0 && ` · ${doc.warnings.length} warning${doc.warnings.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {doc.warnings.length > 0 && (
        <div style={{
          marginBottom: 8, padding: 8,
          background: 'color-mix(in oklch, var(--warn, #c97a06) 6%, transparent)',
          border: '1px dashed color-mix(in oklch, var(--warn, #c97a06) 35%, transparent)',
          borderRadius: 6,
          fontSize: 11.5,
        }}>
          <div style={{ fontWeight: 600, color: 'var(--warn, #c97a06)' }}>Parser warnings</div>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {doc.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {doc.sheets.map((sheet) => (
        <div key={sheet.name + ':' + sheet.index} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Sheet: {sheet.name}
            <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
              · {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'} × {sheet.columnCount} col{sheet.columnCount === 1 ? '' : 's'}
              {sheet.detectedShape && ` · detected: ${sheet.detectedShape}`}
            </span>
          </div>
          <div style={{
            maxHeight: 320, overflow: 'auto',
            border: '1px solid var(--divider)',
            borderRadius: 6,
            background: 'var(--bg)',
          }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)', fontSize: 11.5,
            }}>
              <tbody>
                {sheet.rows.map((row) => {
                  // Reconstruct the column-major view including blanks
                  // so the user sees the source layout, not a packed list.
                  const cellsByCol = new Map(row.cells.map((c) => [c.column, c]));
                  const maxCol = Math.max(0, ...row.cells.map((c) => c.column));
                  const cols: Array<typeof row.cells[number] | null> = [];
                  for (let c = 0; c <= maxCol; c++) {
                    cols.push(cellsByCol.get(c) ?? null);
                  }
                  return (
                    <tr key={row.index}>
                      <td style={{
                        padding: '3px 6px',
                        color: 'var(--fg-subtle)',
                        borderRight: '1px solid var(--divider)',
                        textAlign: 'right',
                        userSelect: 'none',
                        width: 36,
                      }}>{row.index + 1}</td>
                      {cols.map((cell, i) => (
                        <td key={i} style={{
                          padding: '3px 6px',
                          borderRight: '1px solid var(--divider)',
                          background: cell?.mergeAnchor
                            ? 'color-mix(in oklch, var(--accent) 8%, transparent)'
                            : cell?.mergedFromAnchor
                              ? 'color-mix(in oklch, var(--accent) 4%, transparent)'
                              : 'transparent',
                          color: cell?.mergedFromAnchor ? 'var(--fg-muted)' : 'var(--fg)',
                          fontStyle: cell?.mergedFromAnchor ? 'italic' : 'normal',
                          whiteSpace: 'pre',
                          maxWidth: 280,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {cell?.value ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {doc.textBlocks.map((block, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {block.heading ?? <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>(unheaded section)</span>}
            {block.page != null && (
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
                · page {block.page}
              </span>
            )}
            {block.headingDepth != null && (
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
                · depth {block.headingDepth}
              </span>
            )}
          </div>
          <div style={{
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--divider)',
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            fontSize: 11.5,
            maxHeight: 240,
            overflow: 'auto',
          }}>
            {block.body || <span style={{ color: 'var(--fg-subtle)' }}>(empty)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * "Inferred for pricing" section — one row per Layer-3 entity the
 * rate-card field mapper produced. Shows the LLM/heuristic's
 * reasoning + sourceQuote so the rep can see WHY each line is
 * priced, and offers an inline edit affordance for the most common
 * correction (LLM was conservative on scope value, e.g. picked
 * `1 apis` from `api_usage: Yes` when the doc actually has 23).
 *
 * Confidence < 0.6 entities are shown but visually de-emphasised —
 * they don't reach the priced quote until the rep raises confidence
 * by editing (overrides force confidence to 1.0).
 */
function InferredEntitiesSection({
  engagementId,
  fileId,
  entities,
  onChange,
}: {
  engagementId: string;
  fileId: string;
  entities: InferredEntity[];
  onChange(): void;
}) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Sort: high-confidence first (the priced ones), low-confidence at the
  // bottom (rep needs to bump them to make them count). Stable within
  // each bucket so the list doesn't jitter on every refresh.
  const sorted = [...entities].sort((a, b) => {
    const aHi = a.confidence >= 0.6 ? 1 : 0;
    const bHi = b.confidence >= 0.6 ? 1 : 0;
    if (aHi !== bHi) return bHi - aHi;
    return b.confidence - a.confidence;
  });
  const high = sorted.filter((e) => e.confidence >= 0.6).length;

  return (
    <div style={{
      marginTop: 10, marginBottom: 8, padding: 12,
      background: 'var(--bg-elev, var(--bg))',
      border: '1px solid var(--divider)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon.Sparkles size={12} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Inferred for pricing
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {high} of {entities.length} will price
        </span>
      </div>

      {err && (
        <div style={{
          padding: 8, fontSize: 12, marginBottom: 8,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 6,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((e) => (
          <InferredEntityRow
            key={e.serviceLineSlug}
            entity={e}
            editing={editingSlug === e.serviceLineSlug}
            busy={busySlug === e.serviceLineSlug}
            onEdit={() => setEditingSlug(e.serviceLineSlug)}
            onCancel={() => setEditingSlug(null)}
            onSave={async (patch) => {
              setBusySlug(e.serviceLineSlug);
              setErr(null);
              try {
                await extraction.overrideEntity(engagementId, fileId, e.serviceLineSlug, patch);
                setEditingSlug(null);
                onChange();
              } catch (caught) {
                setErr(describeError(caught));
              } finally {
                setBusySlug(null);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function InferredEntityRow({
  entity, editing, busy, onEdit, onCancel, onSave,
}: {
  entity: InferredEntity;
  editing: boolean;
  busy: boolean;
  onEdit(): void;
  onCancel(): void;
  onSave(patch: { scopeValue?: number; methodology?: string | null; customerType?: 'internal' | 'external' }): void;
}) {
  const [scope, setScope] = useState(String(entity.scopeValue));
  const [methodology, setMethodology] = useState(entity.methodology ?? '');
  const [customerType, setCustomerType] = useState<'internal' | 'external'>(entity.customerType);

  // Reset local state when entering edit mode so we always start
  // from the latest server state, not whatever was typed before.
  useEffect(() => {
    if (editing) {
      setScope(String(entity.scopeValue));
      setMethodology(entity.methodology ?? '');
      setCustomerType(entity.customerType);
    }
  }, [editing, entity.scopeValue, entity.methodology, entity.customerType]);

  const lowConfidence = entity.confidence < 0.6;
  const sourceLabel =
    entity.source === 'llm' ? 'LLM'
    : entity.source === 'heuristic' ? 'Heuristic'
    : 'Manual';
  const sourceTone =
    entity.source === 'manual' ? 'ok'
    : entity.source === 'llm' ? 'outline'
    : 'outline';

  return (
    <div style={{
      padding: 12,
      borderRadius: 8,
      background: lowConfidence ? 'var(--bg-sunk)' : 'var(--bg)',
      border: lowConfidence
        ? '1px dashed var(--divider)'
        : '1px solid var(--divider)',
      opacity: lowConfidence ? 0.78 : 1,
    }}>
      {!editing ? (
        <>
          {/* Top row: prominent scope number on the left, slug + meta on the
              right, edit button anchored to the right edge. The number is
              the bit the rep is most likely to override (LLM was conservative,
              real count is in the doc) so it gets the visual weight. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              minWidth: 56,
              padding: '6px 10px',
              borderRadius: 8,
              background: lowConfidence ? 'var(--bg)' : 'var(--accent-tint, var(--bg-sunk))',
              border: '1px solid var(--divider)',
              textAlign: 'center',
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: 22, fontWeight: 700, lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                color: lowConfidence ? 'var(--fg-muted)' : 'var(--fg)',
              }}>
                {entity.scopeValue}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--fg-muted)', marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                scope
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                <code style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {entity.serviceLineSlug}
                </code>
                <span className={lowConfidence ? 'chip warn' : 'chip ok'} style={{ fontSize: 10 }}>
                  {Math.round(entity.confidence * 100)}%
                </span>
                <span className={`chip ${sourceTone}`} style={{ fontSize: 10 }} title={`Source: ${sourceLabel}`}>
                  {sourceLabel}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>methodology: <b style={{ color: 'var(--fg)' }}>{entity.methodology ?? '—'}</b></span>
                <span>customer: <b style={{ color: 'var(--fg)' }}>{entity.customerType}</b></span>
              </div>
            </div>

            <button onClick={onEdit} className="btn sm ghost" disabled={busy} style={{ flexShrink: 0 }}>
              <Icon.Edit size={11} /> Edit
            </button>
          </div>

          {lowConfidence && (
            <div style={{
              marginTop: 8, padding: '6px 8px', fontSize: 11,
              color: 'var(--warn, var(--fg-subtle))', fontStyle: 'italic',
              background: 'var(--warn-tint, var(--bg-sunk))', borderRadius: 6,
            }}>
              Below threshold — won&apos;t reach the priced quote unless you click Edit and raise it.
            </div>
          )}

          {(entity.reasoning || entity.sourceQuote) && (
            <details style={{ marginTop: 8 }}>
              <summary style={{
                cursor: 'pointer',
                fontSize: 11, color: 'var(--fg-muted)',
                userSelect: 'none', listStyle: 'none',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon.ChevronRight size={10} /> Why this value?
              </summary>
              {entity.reasoning && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 6, lineHeight: 1.5 }}>
                  {entity.reasoning}
                </div>
              )}
              {entity.sourceQuote && (
                <div style={{
                  marginTop: 6, padding: '4px 8px', fontSize: 11, color: 'var(--fg-subtle)', fontStyle: 'italic',
                  borderLeft: '2px solid var(--divider)', background: 'var(--bg-sunk)', borderRadius: '0 4px 4px 0',
                }}>
                  “{entity.sourceQuote}”
                </div>
              )}
            </details>
          )}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <label style={{ color: 'var(--fg-muted)' }}>scope value</label>
          <input
            className="input"
            type="number"
            min={0}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ height: 28, fontSize: 13, padding: '0 8px' }}
            disabled={busy}
            autoFocus
          />
          <label style={{ color: 'var(--fg-muted)' }}>methodology</label>
          <input
            className="input"
            value={methodology}
            onChange={(e) => setMethodology(e.target.value)}
            placeholder="leave blank for wildcard match"
            style={{ height: 28, fontSize: 13, padding: '0 8px', fontFamily: 'var(--font-mono)' }}
            disabled={busy}
          />
          <label style={{ color: 'var(--fg-muted)' }}>customer type</label>
          <select
            className="input"
            value={customerType}
            onChange={(e) => setCustomerType(e.target.value as 'internal' | 'external')}
            style={{ height: 28, fontSize: 13, padding: '0 8px' }}
            disabled={busy}
          >
            <option value="external">external</option>
            <option value="internal">internal</option>
          </select>
          <span />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              onClick={() => {
                const n = Number(scope);
                onSave({
                  ...(Number.isFinite(n) && n > 0 && n !== entity.scopeValue && { scopeValue: n }),
                  ...(methodology !== (entity.methodology ?? '') && { methodology: methodology.trim() || null }),
                  ...(customerType !== entity.customerType && { customerType }),
                });
              }}
              disabled={busy}
              className="btn sm accent"
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save + re-price</>}
            </button>
            <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny inline chip showing the Layer-2 semantic category of a
 *  point. Colour-coded so the rep can scan the list and immediately
 *  spot misclassifications (e.g. an identity field flagged as
 *  scope). Categories are mutually exclusive — see backend
 *  `categorisePoint` for the rules. */
function CategoryChip({ category }: { category: PointCategory }) {
  const meta: Record<PointCategory, { bg: string; fg: string; label: string }> = {
    scope:        { bg: 'oklch(0.92 0.05 145)', fg: 'oklch(0.32 0.12 145)', label: 'scope' },
    methodology:  { bg: 'oklch(0.93 0.04 280)', fg: 'oklch(0.34 0.12 280)', label: 'method' },
    service_type: { bg: 'oklch(0.92 0.05 240)', fg: 'oklch(0.32 0.12 240)', label: 'service' },
    identity:     { bg: 'oklch(0.93 0.04 60)',  fg: 'oklch(0.36 0.12 60)',  label: 'identity' },
    environment:  { bg: 'oklch(0.93 0.04 200)', fg: 'oklch(0.34 0.12 200)', label: 'env' },
    compliance:   { bg: 'oklch(0.93 0.04 25)',  fg: 'oklch(0.4 0.15 25)',   label: 'compliance' },
    other:        { bg: 'var(--bg-sunk)',       fg: 'var(--fg-subtle)',     label: 'other' },
  };
  const m = meta[category];
  return (
    <span
      style={{
        display: 'inline-block',
        marginRight: 6,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'var(--font-sans)',
        fontWeight: 500,
        background: m.bg,
        color: m.fg,
        verticalAlign: 1,
      }}
      title={`Layer 2 categorisation: ${category}`}
    >
      {m.label}
    </span>
  );
}

/** Per-sheet count strip — visible proof that the structured parser
 *  walked every worksheet rather than stopping at sheet 1 or 2. Rolls
 *  up the points array into `[sheetName, count]` pairs and renders
 *  them as small chips. Hidden when no point carries a `sheet` field
 *  (PDFs / single-sheet xlsx / LLM-extracted). */
function SheetBreakdown({ points }: { points: ExtractedPoint[] }) {
  const counts = new Map<string, number>();
  for (const p of points) {
    if (!p.sheet) continue;
    counts.set(p.sheet, (counts.get(p.sheet) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 8,
      paddingBottom: 8, borderBottom: '1px solid var(--divider)',
    }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', alignSelf: 'center' }}>
        {counts.size} sheet{counts.size === 1 ? '' : 's'}:
      </span>
      {rows.map(([name, count]) => (
        <span
          key={name}
          className="chip outline"
          style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}
          title={`${count} point${count === 1 ? '' : 's'} from ${name}`}
        >
          {name} <b style={{ marginLeft: 4 }}>{count}</b>
        </span>
      ))}
    </div>
  );
}

function ExtractionStatusChip({ status, pointCount, retryAt, attempts }: {
  status: FileExtraction['status'];
  pointCount: number;
  retryAt: string | null;
  attempts: number;
}) {
  if (status === 'ready') {
    return <span className="chip ok"><Icon.Check size={10} /> {pointCount} extracted</span>;
  }
  if (status === 'processing') return <span className="chip warn"><Icon.Clock size={10} /> Processing…</span>;
  if (status === 'pending')    return <span className="chip warn"><Icon.Clock size={10} /> Queued</span>;
  if (status === 'retry_queued') return <RetryCountdownChip retryAt={retryAt} attempts={attempts} />;
  if (status === 'failed')     return <span className="chip danger"><Icon.X size={10} /> Failed</span>;
  if (status === 'skipped')    return <span className="chip outline"><Icon.Dot size={10} /> Skipped</span>;
  return <span className="chip outline">—</span>;
}

/** Live "retrying in 1m 23s…" chip. Updates every second; tells the
 *  rep the cron will pick this up so they don't have to baby-sit. */
function RetryCountdownChip({ retryAt, attempts }: { retryAt: string | null; attempts: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, []);
  const remainingMs = retryAt ? new Date(retryAt).getTime() - now : 0;
  const label = remainingMs <= 0
    ? 'Retrying any moment…'
    : `Retrying in ${formatCountdown(remainingMs)}`;
  return (
    <span className="chip warn" title={`Attempt ${attempts}/5 · auto-retry`}>
      <Icon.Clock size={10} /> {label}
    </span>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function fileColor(contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'oklch(0.55 0.18 25)';     // PDF: red-orange
  if (ct.includes('sheet') || ct.includes('excel')) return 'oklch(0.5 0.15 145)'; // xlsx: green
  if (ct.startsWith('text/') || ct.includes('csv')) return 'oklch(0.5 0.1 240)'; // text: blue
  return 'oklch(0.5 0.05 280)'; // unknown
}

/** Map the backend's short error codes to scannable inline text. The
 *  raw upstream provider error stays accessible via the row's title
 *  attribute; this is the at-a-glance summary. */
function humaniseExtractionError(raw: string): string {
  if (raw.startsWith('rate_limited')) return 'Rate-limited by AI — try gemini-1.5-flash or wait 60s';
  if (raw.startsWith('bad_model_name')) return 'Bad model name — fix in Settings → AI';
  if (raw.startsWith('auth_failed')) return 'AI auth failed — check API key';
  if (raw.startsWith('timeout')) return 'AI timed out — try Re-extract';
  if (raw.startsWith('unsupported_content_type')) return 'File type not supported (yet)';
  if (raw === 'manual_provider_unsupported') return 'Manual AI mode can\'t auto-extract';
  // Otherwise show the first 80 chars of whatever upstream said.
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
}

function fileGlyph(contentType: string, filename: string): string {
  const lower = `${contentType} ${filename}`.toLowerCase();
  if (lower.includes('pdf')) return 'PDF';
  if (lower.includes('xlsx') || lower.includes('sheet') || lower.includes('excel')) return 'XLSX';
  if (lower.includes('csv')) return 'CSV';
  if (lower.includes('text') || lower.endsWith('.txt') || lower.endsWith('.md')) return 'TXT';
  return 'DOC';
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


// ── Proposal summary card (links to the dedicated proposal workspace) ───────
//
// The full draft preview, regenerate flow, send modal, and manual-paste UX
// all live on the dedicated /opportunities/[id]/proposal route now. This
// card is just the at-a-glance summary in the artifact pane — status chip
// + a CTA into the workspace where the user has room to actually work.

function ProposalSummaryCard({
  engagementId,
  status,
}: {
  engagementId: string;
  status: string;
}) {
  const isReady = status === 'draft_ready';
  const isDrafting = status === 'drafting';
  const isSent = status === 'sent';

  const chip = isSent ? (
    <span className="chip ok"><Icon.Check size={10} /> Sent</span>
  ) : isReady ? (
    <span className="chip accent"><Icon.Sparkles size={10} /> Draft ready</span>
  ) : isDrafting ? (
    <span className="chip warn">
      <span style={{ display: 'inline-flex', animation: 'spin 1.2s linear infinite' }}>
        <Icon.Clock size={10} />
      </span>
      Drafting
    </span>
  ) : (
    <span className="chip outline">
      <span style={{ display: 'inline-flex', animation: 'pulse 1.8s ease-in-out infinite' }}>
        <Icon.Sparkle size={10} />
      </span>
      Awaiting draft
    </span>
  );

  const ctaLabel = isSent
    ? 'View proposal'
    : isReady
      ? 'Open proposal'
      : isDrafting
        ? 'View progress'
        : 'Open workspace';

  const description = isSent
    ? 'Proposal has been sent to the client. Open the workspace to review what went out.'
    : isReady
      ? 'Draft is ready — open the workspace to review, regenerate, or send to the client.'
      : isDrafting
        ? 'Generation in progress. Open the workspace to follow along — usually 30-90s for Gamma decks.'
        : 'Generate a client-ready proposal from the approved scope + price in the dedicated workspace.';

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div className="section-label">Proposal</div>
        </div>
        {chip}
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
        {description}
      </p>
      <Link
        href={`/opportunities/${engagementId}/proposal`}
        className={'btn sm ' + (isReady || isSent ? 'accent' : '')}
      >
        {ctaLabel} <Icon.ArrowUpRight size={11} />
      </Link>
    </div>
  );
}
