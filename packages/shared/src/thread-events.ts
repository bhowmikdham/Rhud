// Thread event contract — matches design doc §4.7.
// Every row in `thread_events` MUST have one of these event_type values.
// The UI, notifications, and audit tooling all key off this list.

export const THREAD_EVENT_TYPES = [
  'link_issued',
  'link_opened',
  'node_answered',
  'file_uploaded',
  /// Document extraction completed for a previously-uploaded file —
  /// payload carries `{ fileId, filename, pointCount }`. Emitted once
  /// per file when the extraction pipeline lands a `ready` outcome.
  'file_extracted',
  /// A loop iteration the responder created (or extraction auto-created)
  /// was removed via the gathering UI's per-iteration trash button.
  /// Payload: `{ loopId, iterIndex }`. Used in audit + thread timeline.
  'loop_iteration_removed',
  /// Layer-3 mapper LLM call failed (rate-limit / timeout / parse error)
  /// and fell back to heuristic-only inference. Payload includes the
  /// reason ("rate_limited" | "parse_error" | "timeout" | "no_entities")
  /// and the raw error message so the rep knows why the inferred-entity
  /// list is heuristic-only instead of LLM-driven. Used by the opportunity
  /// detail page to render a "Re-run mapping" hint.
  'mapper_fallback_heuristic',
  'scope_submitted',
  'price_predicted',
  'price_tech_adjusted',
  'approval_requested',
  'approval_granted',
  'approval_adjusted',
  'approval_rejected',
  'approval_reverted',
  'proposal_draft_requested',
  'proposal_draft_ready',
  'proposal_sent',
  'engagement_synced',
  'engagement_closed',
  'quote_computed',
  'quote_approved',
  /// Site-enumeration crawl + classification finished successfully.
  /// Payload: `{ siteUrl, totalUrls, categories: { [cat]: count } }`.
  /// Emitted once per enumeration when status flips to `ready`.
  'site_enumerated',
  /// Site enumeration ran out of retries (or hit a non-retryable error).
  /// Payload: `{ siteUrl, error, attempts }`. Distinct from
  /// site_enumerated so the timeline shows the failure clearly.
  'site_enumeration_failed',
  /// Lead-management: a ticket (complaint / question / change request /
  /// check-in / internal note) was raised against the engagement.
  /// Payload: `{ ticketId, category, priority, title }`.
  'ticket_opened',
  /// Ticket transitioned status (open ↔ in_progress, etc.) without
  /// being a final resolution. Payload: `{ ticketId, from, to }`.
  'ticket_status_changed',
  /// Ticket terminal state (resolved or wont_fix) reached.
  /// Payload: `{ ticketId, from, to, note? }`.
  'ticket_resolved',
  /// A scheduled follow-up was created. Payload: `{ followUpId,
  /// scheduledFor, reason, assignedTo? }`.
  'follow_up_scheduled',
  /// A scheduled follow-up was marked complete. Payload:
  /// `{ followUpId, note? }`.
  'follow_up_completed',
  /// AI lead summary was generated or manually saved.
  /// Payload: `{ generatedBy, riskLevel, recommendedFollowUpDays, model? }`.
  'summary_generated',
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['user', 'client', 'system', 'integration'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface ThreadEvent<P = Record<string, unknown>> {
  id: string;
  engagementId: string;
  tenantId: string;
  eventType: ThreadEventType;
  actorType: ActorType;
  actorId: string | null;
  payload: P;
  createdAt: string; // ISO 8601
}
