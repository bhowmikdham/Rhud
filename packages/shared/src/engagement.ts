// Engagement lifecycle states — matches the design doc §4.4 `engagements.status` CHECK.
export const ENGAGEMENT_STATUSES = [
  /// Direct-ingest initial state. The engagement was created from one or
  /// more IngestionArtifact rows (paste-text, file-drop, email, voice,
  /// WhatsApp). Extraction is running on the attached files; transitions
  /// to `submitted` when every EngagementFile reaches `extraction.status`
  /// = ready. Distinct from `issued` because no gathering token exists
  /// for this engagement — the rep already had the requirements.
  /// See docs/direct-ingest.md §3.2.
  'ingesting',
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
  /// Deal marked lost at the 'sent' stage (the client declined the proposal).
  /// Terminal, like 'closed' (won) and 'rejected' (a price rejection upstream).
  'lost',
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
