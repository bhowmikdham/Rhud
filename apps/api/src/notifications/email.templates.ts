/**
 * Email template registry.
 *
 * One small module per event type would be over-engineered for sprint 4,
 * so we keep them inline here. Each entry produces (subject, textBody)
 * given a stable `EmailContext`. The shapes of the per-event payloads
 * intentionally accept what's typically present on the thread event.
 */
import type { ThreadEventType } from '@rhud/shared';

export interface EmailContext {
  // Engagement-level fields available on every send.
  engagementId: string;
  templateName: string;
  clientEmail: string;
  // Pre-built link to the engagement detail page in the portal.
  portalUrl: string;
  // Recipient role (sales_employee | sales_manager | client) — the body
  // sometimes adapts to whom we're addressing.
  recipientRole: 'sales_employee' | 'sales_manager' | 'client';
  // Free-form payload from the thread event. Keys vary by event type.
  payload: Record<string, unknown>;
}

interface Template {
  subject: (ctx: EmailContext) => string;
  textBody: (ctx: EmailContext) => string;
}

const sharedSig = '\n\n—\nrhud · scope-to-proposal automation';

export const EMAIL_TEMPLATES: Partial<Record<ThreadEventType, Template>> = {
  link_issued: {
    subject: (c) => `[Rhud] Gathering link issued for ${c.clientEmail}`,
    textBody: (c) =>
      `A scope-gathering link was issued for ${c.clientEmail} on the "${c.templateName}" template.\n\n` +
      `View engagement: ${c.portalUrl}\n` +
      `Link expires: ${typeof c.payload.expiresAt === 'string' ? c.payload.expiresAt : 'see portal'}` +
      sharedSig,
  },
  file_uploaded: {
    subject: (c) => `[Rhud] ${c.clientEmail} uploaded a file`,
    textBody: (c) => {
      const fname = typeof c.payload.filename === 'string' ? c.payload.filename : 'a file';
      const sz = typeof c.payload.sizeBytes === 'number' ? `${(c.payload.sizeBytes / 1024).toFixed(1)} KB` : '';
      return (
        `${c.clientEmail} uploaded ${fname} ${sz ? `(${sz})` : ''}.\n\n` +
        `View engagement: ${c.portalUrl}` + sharedSig
      );
    },
  },
  scope_submitted: {
    subject: (c) => `[Rhud] Scope submitted by ${c.clientEmail}`,
    textBody: (c) =>
      `${c.clientEmail} submitted the scope for "${c.templateName}". ML price prediction is queued.\n\n` +
      `View engagement: ${c.portalUrl}` + sharedSig,
  },
  price_predicted: {
    subject: (c) => `[Rhud] Price predicted — ${c.clientEmail}`,
    textBody: (c) => {
      const lo = typeof c.payload.priceLowCents === 'number' ? `$${(c.payload.priceLowCents / 100).toFixed(0)}` : '?';
      const hi = typeof c.payload.priceHighCents === 'number' ? `$${(c.payload.priceHighCents / 100).toFixed(0)}` : '?';
      return (
        `Predicted price band for ${c.clientEmail}: ${lo} – ${hi}\n\n` +
        `Manager review: ${c.portalUrl}` + sharedSig
      );
    },
  },
  approval_requested: {
    subject: (c) => `[Rhud] Approval needed — ${c.clientEmail}`,
    textBody: (c) =>
      `A scope + price for ${c.clientEmail} is awaiting your approval.\n\n` +
      `Review: ${c.portalUrl}` + sharedSig,
  },
  approval_granted: {
    subject: (c) => `[Rhud] Manager approved — ${c.clientEmail}`,
    textBody: (c) =>
      `The price for ${c.clientEmail} was approved. Gamma drafting will start automatically.\n\n` +
      `View: ${c.portalUrl}` + sharedSig,
  },
  approval_adjusted: {
    subject: (c) => `[Rhud] Manager adjusted price — ${c.clientEmail}`,
    textBody: (c) =>
      `The manager adjusted the approved price for ${c.clientEmail}.\n\n` +
      `View: ${c.portalUrl}` + sharedSig,
  },
  approval_rejected: {
    subject: (c) => `[Rhud] Approval rejected — ${c.clientEmail}`,
    textBody: (c) => {
      const note = typeof c.payload.comment === 'string' ? `Note: ${c.payload.comment}` : '';
      return `The price for ${c.clientEmail} was rejected.\n${note}\n\nView: ${c.portalUrl}` + sharedSig;
    },
  },
  approval_reverted: {
    subject: (c) => `[Rhud] Approval reverted — ${c.clientEmail}`,
    textBody: (c) => {
      const from = typeof c.payload.fromStatus === 'string' ? c.payload.fromStatus : 'previous state';
      const to = typeof c.payload.toStatus === 'string' ? c.payload.toStatus : 'pending';
      return (
        `An admin reverted the ${from === 'rejected' ? 'rejection' : 'approval'} for ${c.clientEmail}. ` +
        `Status is now "${to}".\n\nView: ${c.portalUrl}` + sharedSig
      );
    },
  },
  proposal_draft_requested: {
    subject: (c) => `[Rhud] Drafting proposal — ${c.clientEmail}`,
    textBody: (c) =>
      `Proposal drafting started for ${c.clientEmail}. You'll get another email when it's ready for review.\n\n` +
      `Track: ${c.portalUrl}` + sharedSig,
  },
  proposal_draft_ready: {
    subject: (c) => `[Rhud] Proposal draft ready — ${c.clientEmail}`,
    textBody: (c) =>
      `Gamma generated the draft. Review it inside the portal before sending to the client.\n\n` +
      `Review: ${c.portalUrl}` + sharedSig,
  },
  proposal_sent: {
    subject: (c) =>
      c.recipientRole === 'client'
        ? `Your proposal — ${c.templateName}`
        : `[Rhud] Proposal sent to ${c.clientEmail}`,
    textBody: (c) => {
      const proposalUrl = typeof c.payload.proposalUrl === 'string' ? c.payload.proposalUrl : null;
      const proposalText = typeof c.payload.proposalText === 'string' ? c.payload.proposalText : null;
      const deliveryMode = typeof c.payload.deliveryMode === 'string' ? c.payload.deliveryMode : null;

      if (c.recipientRole === 'client') {
        // Self-reported sends should NOT email the client — the rep
        // already did. Bail to a no-op subject/body that the dispatcher
        // can surface in audit but clients won't actually receive
        // (caller should filter, but defensive default here).
        if (deliveryMode === 'self_reported') {
          return (
            `Hi,\n\nThis is a record-keeping copy of the proposal you were sent ` +
            `directly. No action needed.` + sharedSig
          );
        }
        if (proposalUrl) {
          return (
            `Hi,\n\nThanks for the time you spent on the scope. Here's the proposal ` +
            `we drafted based on it:\n\n${proposalUrl}\n\n` +
            `Let us know what you think — just reply to this email.` + sharedSig
          );
        }
        if (proposalText) {
          return (
            `Hi,\n\nThanks for the time you spent on the scope. Here's the proposal ` +
            `we drafted based on it:\n\n──────────────────────────────────\n` +
            `${proposalText}\n──────────────────────────────────\n\n` +
            `Let us know what you think — just reply to this email.` + sharedSig
          );
        }
        // Neither URL nor text — shouldn't happen, but degrade gracefully.
        return (
          `Hi,\n\nWe've prepared your proposal. We'll be in touch shortly with ` +
          `the details.` + sharedSig
        );
      }
      // Team-side: link the deck if we have one, otherwise the portal.
      const link = proposalUrl ?? c.portalUrl;
      const mode =
        deliveryMode === 'self_reported'
          ? '(rep marked as sent manually)'
          : '(emailed via Rhud)';
      return `Proposal sent to ${c.clientEmail} ${mode}.\n\nView: ${link}` + sharedSig;
    },
  },
  engagement_synced: {
    subject: (c) => `[Rhud] Synced to Odoo — ${c.clientEmail}`,
    textBody: (c) => `Engagement for ${c.clientEmail} synced to Odoo as a quotation.\n\nView: ${c.portalUrl}` + sharedSig,
  },
  engagement_closed: {
    subject: (c) => `[Rhud] Engagement closed — ${c.clientEmail}`,
    textBody: (c) =>
      `The engagement for ${c.clientEmail} is closed and the audit chain sealed.\n\n` +
      `View: ${c.portalUrl}` + sharedSig,
  },
};

export function renderEmail(eventType: ThreadEventType, ctx: EmailContext): { subject: string; textBody: string } | null {
  const t = EMAIL_TEMPLATES[eventType];
  if (!t) return null;
  return { subject: t.subject(ctx), textBody: t.textBody(ctx) };
}

// ── Out-of-band emails (not driven by ThreadEvent) ──────────────────────────

export interface InviteEmailArgs {
  to: string;
  role: string;
  inviterEmail: string;
  acceptUrl: string;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'admin',
  sales_manager: 'sales manager',
  sales_employee: 'sales rep',
};

export function renderInviteEmail(args: InviteEmailArgs): { subject: string; textBody: string } {
  const roleLabel = ROLE_LABEL[args.role] ?? args.role;
  return {
    subject: `[Rhud] You've been invited to join the workspace`,
    textBody:
      `${args.inviterEmail} invited you to join their Rhud workspace as ${roleLabel}.\n\n` +
      `Click here to set a password and sign in:\n${args.acceptUrl}\n\n` +
      `This invite expires in 7 days. If you weren't expecting it, ignore this email.` +
      sharedSig,
  };
}
