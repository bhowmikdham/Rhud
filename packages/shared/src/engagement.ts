// Engagement lifecycle states — matches the design doc §4.4 `engagements.status` CHECK.
export const ENGAGEMENT_STATUSES = [
  'issued',
  'in_progress',
  'submitted',
  'predicted',
  'pending_approval',
  'approved',
  'drafting',
  'draft_ready',
  'sent',
  'closed',
  'rejected',
  'expired',
  // Phase A — reviewer-driven holds (PM workflow stage 4).
  /// Reviewer clicked "Send Back to Sales" — the rep must edit scope
  /// and resubmit before the engagement can re-enter predict/approval.
  'returned_to_sales',
  /// Reviewer asked for a clarification. The opportunity is on hold
  /// until the question is answered (then back to 'submitted').
  'awaiting_clarification',
  /// Reviewer escalated to a sales manager / admin.
  'escalated',
  // Phase C — multi-level approval (PM workflow stage 5).
  /// Sales manager approved a price above the tenant's VP threshold;
  /// a vp_sales (or admin) user must final-approve before the
  /// engagement can advance to 'approved'.
  'pending_vp_approval',
  /// Same as above but above the tenant's CEO threshold (which sits
  /// above VP threshold). Requires ceo (or admin) final-approval.
  'pending_ceo_approval',
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];

// Phase E — opportunity provenance. Set at engagement creation and
// rendered as a "via X" chip in the opportunities list. Whitelisted on
// the engagements_source_check DB constraint; keep this list in sync.
export const ENGAGEMENT_SOURCES = [
  /// Created by a logged-in user via the "New opportunity" form.
  'manual',
  /// Created by the Postmark inbound webhook from a customer email.
  'inbound_email',
  /// Created by POST /partner-intake/:token. `partnerTokenId` carries
  /// the back-ref so the UI can show "via partner Acme Reseller".
  'partner_api',
  /// Mirror of an Odoo crm.lead picked up by the polling sync.
  'odoo',
] as const;

export type EngagementSource = (typeof ENGAGEMENT_SOURCES)[number];
