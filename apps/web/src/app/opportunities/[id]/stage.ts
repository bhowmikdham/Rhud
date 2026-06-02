/**
 * Stage model for the opportunity detail page (Phase D). Maps the raw
 * lifecycle statuses onto the five human pipeline stations + side-states, and
 * owns the lifecycle copy (nextStepHint) and the reviewer-hold constants that
 * the page and its panels share.
 */
import type { ThreadEventRow } from '@/lib/api';
import type { Icon } from '@/components/icon';

export type StageId = 'discovery' | 'pricing' | 'approval' | 'proposal' | 'delivered';
export type SideState = 'hold' | 'rejected' | 'lost' | 'expired' | null;

/** The five forward pipeline stations, in order (drives the stepper). */
export const STAGES: Array<{ id: StageId; label: string; icon: keyof typeof Icon }> = [
  { id: 'discovery', label: 'Discovery', icon: 'Link' },
  { id: 'pricing', label: 'Pricing', icon: 'Sparkle' },
  { id: 'approval', label: 'Approval', icon: 'Shield' },
  { id: 'proposal', label: 'Proposal', icon: 'FileText' },
  { id: 'delivered', label: 'Delivered', icon: 'Send' },
];

/** Map a raw lifecycle status onto its pipeline stage + optional side-state.
 *  `predicted` + `pending_approval` collapse into one Pricing/approval-input
 *  stage; holds + rejected are transient side-states over the underlying stage. */
export function stageOf(status: string): { stage: StageId; side: SideState } {
  switch (status) {
    case 'issued':
    case 'in_progress':
      return { stage: 'discovery', side: null };
    case 'submitted':
    case 'predicted':
    case 'pending_approval':
      return { stage: 'pricing', side: null };
    case 'pending_vp_approval':
    case 'pending_ceo_approval':
      return { stage: 'approval', side: null };
    case 'approved':
    case 'drafting':
    case 'draft_ready':
      return { stage: 'proposal', side: null };
    case 'sent':
    case 'closed':
      return { stage: 'delivered', side: null };
    case 'lost':
      return { stage: 'delivered', side: 'lost' };
    case 'returned_to_sales':
    case 'awaiting_clarification':
    case 'escalated':
      return { stage: 'pricing', side: 'hold' };
    case 'rejected':
      return { stage: 'pricing', side: 'rejected' };
    case 'expired':
      return { stage: 'discovery', side: 'expired' };
    default:
      return { stage: 'discovery', side: null };
  }
}

/** Who acts next at each status — drives the "Your turn / Waiting on X" badge.
 *  `roles` lists the roles for whom it is genuinely actionable (verified against
 *  the lifecycle: e.g. `escalated` is a manager/admin/ceo decision, not the rep's). */
export const ACTOR_BY_STATUS: Record<string, { label: string; roles: string[] }> = {
  issued: { label: 'the client', roles: [] },
  in_progress: { label: 'the client', roles: [] },
  submitted: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
  predicted: { label: 'a sales manager', roles: ['sales_manager', 'admin'] },
  pending_approval: { label: 'a sales manager', roles: ['sales_manager', 'admin'] },
  pending_vp_approval: { label: 'VP Sales', roles: ['vp_sales', 'admin'] },
  pending_ceo_approval: { label: 'the CEO', roles: ['ceo', 'admin'] },
  approved: { label: 'the system', roles: [] },
  drafting: { label: 'the system', roles: [] },
  draft_ready: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
  sent: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
  closed: { label: '', roles: [] },
  lost: { label: '', roles: [] },
  returned_to_sales: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
  awaiting_clarification: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
  escalated: { label: 'a manager', roles: ['sales_manager', 'admin', 'ceo'] },
  rejected: { label: 'an admin', roles: ['admin'] },
  expired: { label: 'sales', roles: ['sales_employee', 'sales_manager', 'admin'] },
};

/** Roles allowed to take reviewer hold actions (send-back / clarify / escalate).
 *  Mirrors ReviewerHoldActions' internal gate — used to hide the wrapper box
 *  entirely for non-reviewers (no empty "Need to pause?" card). */
export const REVIEWER_HOLD_ROLES = ['admin', 'sales_manager', 'tech_team'];

export const REVIEWABLE_STATUSES = ['submitted', 'pending_approval', 'predicted'];
export const HOLD_STATUSES = ['returned_to_sales', 'awaiting_clarification', 'escalated'];

// Maps a hold status to the thread event recording WHY it was held, plus
// the copy that explains what clears it.
export const HOLD_BANNER: Record<string, { eventType: string; title: string; clears: string }> = {
  returned_to_sales: {
    eventType: 'scope_returned_to_sales',
    title: 'Returned to sales',
    clears: 'Edit the scope and resubmit to send this back into review.',
  },
  awaiting_clarification: {
    eventType: 'clarification_requested',
    title: 'Awaiting clarification',
    clears: 'Answer the question, then resubmit to lift this hold.',
  },
  escalated: {
    eventType: 'scope_escalated',
    title: 'Escalated',
    clears: 'A sales manager or admin must weigh in before this can proceed.',
  },
};

export function nextStepHint(status: string): string {
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
      return 'Won — the client accepted. Audit chain sealed.';
    case 'lost':
      return 'Marked lost — the client declined the proposal. This opportunity is closed.';
    case 'pending_vp_approval':
      return 'Above the VP threshold. Awaiting VP Sales sign-off before this can go to the client.';
    case 'pending_ceo_approval':
      return 'Above the CEO threshold. Awaiting CEO sign-off before this can go to the client.';
    case 'awaiting_clarification':
      return 'On hold for a clarification. Answer the question, then resubmit to continue.';
    case 'returned_to_sales':
      return 'Sent back by the reviewer. Revise the scope and resubmit for review.';
    case 'escalated':
      return 'Escalated to a manager. Awaiting a higher-level decision before it proceeds.';
    case 'expired':
      return 'The gathering link expired before the client finished. Re-issue a scoping link to continue.';
    default:
      return 'Awaiting the next signal.';
  }
}
