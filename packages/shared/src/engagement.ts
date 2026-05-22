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
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
