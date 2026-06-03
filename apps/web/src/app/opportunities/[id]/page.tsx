'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  describeError,
  opportunities,
  predictions,
  proposalDraft,
  quotes,
  type ApprovalChoice,
  type EngagementQuote,
  type EngagementSummary,
  type GatheringLinkInfo,
  type Prediction,
  type ThreadEventRow,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';
import { SourceChip } from '@/components/source-chip';
import { RowActions } from '@/components/row-actions';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { IssueLinkModal } from '@/components/issue-link-modal';
import { LeadHud } from './lead-hud';
import { LeadSummaryInline } from './lead-summary-inline';
import {
  AssumptionsExclusionsCard,
  QuoteLineItemsCard,
  ReviewerHoldActions,
} from './reviewer-panels';
import { FinalApprovalCard } from './final-approval-card';
import { relativeTime } from './format';
import { ApprovalCard, NoPredictionCta } from './approval-card';
import { ScopingQuestionsCard } from './scoping-card';
import { PricePredictionCard } from './price-hero';
import { SiteScopeCard } from './site-scope-card';
import { ExtractedPointsCard } from './extracted-points-card';
import { JustificationCard } from './justification-card';
import { ProposalSummaryCard } from './proposal-summary-card';
import { StageRail } from './stage-rail';
import { FocusJump } from './focus-jump';
import { InspectorDrawer } from './inspector-drawer';
import { REVIEWABLE_STATUSES, HOLD_STATUSES, HOLD_BANNER, REVIEWER_HOLD_ROLES, stageOf } from './stage';
import { DealOutcomeCard } from './deal-outcome-card';
import { AttachRateCardCard } from './attach-rate-card-card';

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

// REVIEWABLE_STATUSES, HOLD_STATUSES, HOLD_BANNER, nextStepHint now live in
// ./stage (Phase D — shared stage model).

/** Focus-Pane (v2 Phase 1): the right pane shows ONE focus body at a time
 *  instead of a long stack. `focusFor` is the per-stage default; the user
 *  switches via the FocusJump. Reference material lives in the Inspector. */
type FocusId = 'price' | 'scope' | 'documents' | 'proposal';

function focusFor(stage: string): FocusId {
  switch (stage) {
    case 'discovery': return 'scope';
    case 'proposal': return 'proposal';
    default: return 'price'; // pricing / approval / delivered
  }
}

const FOCUS_ITEMS: Array<{ id: FocusId; label: string; icon: keyof typeof Icon }> = [
  { id: 'price', label: 'Price', icon: 'Sparkle' },
  { id: 'scope', label: 'Scope', icon: 'Globe' },
  { id: 'documents', label: 'Documents', icon: 'FileText' },
  { id: 'proposal', label: 'Proposal', icon: 'Send' },
];

export default function OpportunityDetailPage() {
  const user = useRequireAuth();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [eng, setEng] = useState<EngagementWithThread | null>(null);
  const [quote, setQuote] = useState<EngagementQuote | null>(null);
  const [prediction, setPrediction] = useState<Prediction | null>(null);
  // Fatal load error — the initial opportunities.get() failed, so there's
  // nothing to render. We keep the raw error so the guard can tell a real
  // 404 apart from a transient failure (and offer a Retry).
  const [loadErr, setLoadErr] = useState<unknown>(null);
  // Non-fatal action error — a lifecycle action (predict/approve/etc.)
  // failed. Shown as a dismissible banner near the actions; never
  // discards the loaded opportunity.
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [predicting, setPredicting] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  // Focus-Pane state: which single body the right pane shows. null = follow
  // the stage default (focusFor); a value = the user picked one explicitly.
  const [focus, setFocus] = useState<FocusId | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  // Drives the "Send scoping questions" / "Re-issue link" modal. The
  // modal calls opportunities.issueLink; on success we reload the
  // engagement so the gathering-link card picks up the new token.
  const [showIssueLink, setShowIssueLink] = useState(false);
  /** Scroll target — the prediction/quote surface at the top of the
   *  artifact body. SiteScopeCard's "Compute quote" smooth-scrolls
   *  here after the conventional flow updates the QuoteCard. */
  const predictionSectionRef = useRef<HTMLDivElement | null>(null);

  const canDelete = user?.role === 'admin' || user?.role === 'sales_manager';

  // Initial load — split from the action handlers so a fatal fetch error
  // (the opportunity itself couldn't be read) is distinct from a transient
  // action failure. Exposed as a callback so the Retry button can re-run it.
  const load = useCallback(() => {
    setLoadErr(null);
    opportunities.get(id).then(setEng).catch((e) => setLoadErr(e));
    quotes.forEngagement(id).then(setQuote).catch(() => setQuote(null));
    predictions.latest(id).then(setPrediction).catch(() => setPrediction(null));
  }, [id]);

  useEffect(() => {
    if (!user) return;
    load();
  }, [user, load]);

  async function runPredict() {
    setActionErr(null);
    setPredicting(true);
    try {
      const fresh = await predictions.predict(id);
      setPrediction(fresh);
      const refreshed = await opportunities.get(id);
      setEng(refreshed);
      const q = await quotes.forEngagement(id).catch(() => null);
      setQuote(q);
    } catch (e) {
      setActionErr(describeError(e));
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
    // Computing a quote from Site Scope lives in the Scope focus — flip to
    // the Price focus so the rep sees the result land, then scroll it in.
    setFocus('price');
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
      // stays snappy. The approval itself succeeded; if the draft kickoff
      // fails we don't roll it back, but we surface a non-fatal notice so
      // the deal doesn't silently strand at 'approved'.
      void proposalDraft.generate(id).catch(() =>
        setActionErr("Approved — but couldn't start drafting; open the proposal workspace to retry."),
      );
    } catch (e) {
      setActionErr(describeError(e));
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
      setActionErr(describeError(e));
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
      setActionErr(describeError(e));
      throw e; // let the modal know to stay open
    }
  }

  async function revertApproval() {
    try {
      await predictions.revertApproval(id);
      await refreshAfterDecision();
    } catch (e) {
      setActionErr(describeError(e));
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

  // Reserve "Not found" for an actual 404 — any other failure (network,
  // 500, auth) gets a friendly message plus a Retry so a transient hiccup
  // isn't a permanent dead-end.
  if (loadErr) {
    const isNotFound = loadErr instanceof ApiError && loadErr.status === 404;
    return (
      <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: isNotFound ? 'Not found' : 'Error' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              {isNotFound ? 'Opportunity not found' : "Couldn't load this opportunity"}
            </div>
            <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
              {isNotFound
                ? 'This opportunity could not be loaded — it may have been deleted.'
                : describeError(loadErr)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {!isNotFound && (
                <button className="btn accent" onClick={load}>
                  <Icon.Refresh size={12} /> Retry
                </button>
              )}
              <Link href="/opportunities" className="btn">
                <Icon.ArrowLeft size={13} /> Back to opportunities
              </Link>
            </div>
          </div>
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
  const { stage: pipelineStage } = stageOf(eng.status);
  const activeFocus: FocusId = focus ?? focusFor(pipelineStage);

  return (
    <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: headerTitle }]}>
      <div className="thread-split">
        <div className="thread-pane">
          <div className="thread-head">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <h1 className="thread-title">{headerTitle}</h1>
                <div className="thread-meta">
                  <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{eng.id.slice(0, 8)}</span>
                  {/* Direct-ingest opportunities have no template; skip the
                      separator + label rather than render "No template" inline. */}
                  {eng.templateName && (<>
                    <span className="dot">·</span>
                    <span>{eng.templateName}</span>
                  </>)}
                  {eng.name && (<>
                    <span className="dot">·</span>
                    <span>{eng.clientEmail}</span>
                  </>)}
                </div>
              </div>
              {/* Single destructive action — so when the user can't delete,
                  the menu would be a lone disabled item. Drop it entirely in
                  that case rather than show a dead one-item menu. */}
              {canDelete && (
                <RowActions
                  items={[
                    {
                      label: 'Delete opportunity',
                      icon: 'X',
                      danger: true,
                      onClick: () => setShowDelete(true),
                    },
                  ]}
                />
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              <StageChip stage={eng.status} />
              <SourceChip source={eng.source} />
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
          {user && (
            <StageRail
              status={eng.status}
              userRole={user.role}
              onJump={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              onInspector={() => setInspectorOpen(true)}
            />
          )}
          <div style={{ padding: '10px 28px 0' }}>
            <FocusJump current={activeFocus} items={FOCUS_ITEMS} onSelect={(f) => setFocus(f as FocusId)} />
          </div>
          <div className="artifact-body">
            {activeFocus === 'price' && (
            <div ref={predictionSectionRef} style={{ scrollMarginTop: 80, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Action error — a lifecycle action failed. Dismissible, and
                never discards the loaded opportunity (unlike the fatal load
                guard above). */}
            {actionErr && (
              <div style={{
                marginBottom: 16,
                padding: '12px 14px',
                borderRadius: 8,
                background: 'var(--danger-tint)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
                gap: 12,
              }}>
                <span style={{ fontSize: 12.5, color: 'var(--danger)', minWidth: 0 }}>{actionErr}</span>
                <button
                  className="btn ghost sm"
                  aria-label="Dismiss"
                  onClick={() => setActionErr(null)}
                  style={{ flexShrink: 0 }}
                >
                  <Icon.X size={12} />
                </button>
              </div>
            )}
            {user && (eng.status === 'pending_vp_approval' || eng.status === 'pending_ceo_approval') && (
              <FinalApprovalCard
                engagementId={eng.id}
                level={eng.status === 'pending_ceo_approval' ? 'ceo' : 'vp'}
                approvedPriceCents={quote?.approvedPriceCents ?? null}
                currency={quote?.currency ?? 'INR'}
                userRole={user.role}
                onChanged={() => { void refreshAfterDecision(); }}
              />
            )}
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
                approved={['approved', 'drafting', 'draft_ready', 'sent', 'closed', 'lost'].includes(eng.status)}
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

            {/* Hold banner — explains why the opportunity is parked and what
                lifts the hold. Without this the page renders nothing for the
                hold statuses. */}
            {HOLD_BANNER[eng.status] && (
              <div style={{
                margin: '12px 0',
                padding: '12px 14px',
                background: 'var(--warn-tint)',
                border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
                borderRadius: 8,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Icon.Clock size={13} style={{ color: 'var(--warn)' }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
                    On hold · {HOLD_BANNER[eng.status]!.title}
                  </span>
                </div>
                {lastHoldReason(eng.status, eng.thread) && (
                  <div style={{ fontSize: 12.5, color: 'var(--fg)', marginBottom: 4 }}>
                    {lastHoldReason(eng.status, eng.thread)}
                  </div>
                )}
                <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  {HOLD_BANNER[eng.status]!.clears}
                </div>
              </div>
            )}

            {/* Reviewer hold actions — mounted for the reviewable statuses
                AND the hold statuses, so a reviewer can still clear a hold.
                The ReviewerHoldActions component decides which buttons to
                enable. */}
            {user && REVIEWER_HOLD_ROLES.includes(user.role) && [...REVIEWABLE_STATUSES, ...HOLD_STATUSES].includes(eng.status) && (
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
                {['sent', 'closed', 'lost'].includes(eng.status) && user && (
                  <DealOutcomeCard
                    engagementId={eng.id}
                    status={eng.status}
                    userRole={user.role}
                    onChanged={() => { void refreshAfterDecision(); }}
                  />
                )}

                {/* Direct-ingest opportunity (no template, no rate card) →
                    attach one to price from the extracted scope. */}
                {!eng.templateId && !eng.rateCardId && (
                  <AttachRateCardCard
                    engagementId={eng.id}
                    onAttached={async () => {
                      const [refreshed, q, p] = await Promise.all([
                        opportunities.get(id),
                        quotes.forEngagement(id).catch(() => null),
                        predictions.latest(id).catch(() => null),
                      ]);
                      setEng(refreshed);
                      setQuote(q);
                      setPrediction(p);
                    }}
                  />
                )}

                {/* Pricing extras — promoted out of a dead-last section into
                    the Price focus, beside the number it adjusts. */}
                {quote && user && (
                  <QuoteLineItemsCard
                    engagementId={eng.id}
                    userRole={user.role}
                    currency={quote.currency}
                  />
                )}
            </div>
            )}

            {activeFocus === 'scope' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <ScopingQuestionsCard
                  engagementId={eng.id}
                  currentTemplateId={eng.templateId}
                  link={eng.gatheringLink}
                  onOpenModal={() => setShowIssueLink(true)}
                />
                <SiteScopeCard
                  engagementId={eng.id}
                  defaultOpen
                  onAfterCompute={runPredictFromSiteScope}
                  parentBusy={predicting}
                />
              </div>
            )}

            {activeFocus === 'documents' && (
              <ExtractedPointsCard engagementId={eng.id} />
            )}

            {activeFocus === 'proposal' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {quote && <JustificationCard engagementId={eng.id} clientEmail={eng.clientEmail} />}
                {['approved', 'drafting', 'draft_ready', 'sent'].includes(eng.status) && (
                  <ProposalSummaryCard
                    engagementId={eng.id}
                    status={eng.status}
                  />
                )}
              </div>
            )}
          </div>

          {user && (
            <InspectorDrawer open={inspectorOpen} onClose={() => setInspectorOpen(false)} title="Details">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <LeadSummaryInline engagementId={eng.id} />
                <LeadHud
                  engagementId={eng.id}
                  status={eng.status}
                  userRole={user.role}
                  classification={{
                    categorySlug: eng.categorySlug ?? null,
                    subCategorySlug: eng.subCategorySlug ?? null,
                    classifiedBy: eng.classifiedBy ?? null,
                    classifiedAt: eng.classifiedAt ?? null,
                  }}
                  assignedReviewerId={eng.assignedReviewerId ?? null}
                  onClassificationChange={() => { void refreshAfterDecision(); }}
                />
                <div className="card" style={{ padding: 22 }}>
                  <h3 className="section-label" style={{ marginBottom: 10 }}>Opportunity details</h3>
                  {eng.name && <Row k="Name" v={eng.name} />}
                  <Row k="Client email" v={eng.clientEmail} />
                  {eng.templateName && <Row k="Template" v={eng.templateName} />}
                  <Row k="Created" v={new Date(eng.createdAt).toLocaleString()} />
                  {eng.submittedAt && <Row k="Submitted" v={new Date(eng.submittedAt).toLocaleString()} />}
                  <Row k="Opportunity id" v={<span className="mono">{eng.id}</span>} />
                </div>
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
              </div>
            </InspectorDrawer>
          )}

          {showIssueLink && (
            <IssueLinkModal
              engagementId={eng.id}
              currentTemplateId={eng.templateId}
              isReissue={!!eng.gatheringLink}
              onIssued={async () => {
                setShowIssueLink(false);
                const refreshed = await opportunities.get(id);
                setEng(refreshed);
              }}
              onClose={() => setShowIssueLink(false)}
            />
          )}
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

/** Why the opportunity is on hold — read off the latest thread event that
 *  matches the current hold status. Same reversed-scan pattern as
 *  lastRejectionReason; clarification holds carry the text under `question`
 *  rather than `reason`. */
function lastHoldReason(status: string, thread: ThreadEventRow[] | undefined): string | null {
  const cfg = HOLD_BANNER[status];
  if (!cfg || !thread) return null;
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i]!;
    if (e.eventType === cfg.eventType) {
      const p = e.payload as { reason?: unknown; question?: unknown } | null;
      if (p && typeof p.reason === 'string' && p.reason.trim()) return p.reason.trim();
      if (p && typeof p.question === 'string' && p.question.trim()) return p.question.trim();
      return null;
    }
  }
  return null;
}



function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--divider)' }}>
      <div style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{k}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
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


