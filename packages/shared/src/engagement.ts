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
] as const;

export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
