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
  /// The questionnaire supplied an explicit source-code line count (a
  /// white-box signal) but the engagement/application selected Black Box,
  /// so white-box source-code review (`vapt_*_source_code_*`) was NOT
  /// priced. Surfaced so the rep can decide whether a code review is
  /// actually in scope rather than have the contradiction silently dropped.
  /// Payload: `{ fileId, sample, testingType }`.
  'source_code_review_skipped',
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
  // Phase A — reviewer action events.
  /// Technical reviewer clicked "Send Back to Sales" with a reason.
  /// Payload: `{ reason }`. Status transitions to 'returned_to_sales'.
  'scope_returned_to_sales',
  /// Reviewer asked sales/client a clarifying question.
  /// Payload: `{ question }`. Status transitions to 'awaiting_clarification'.
  'clarification_requested',
  /// Reviewer escalated to a manager / admin.
  /// Payload: `{ reason, escalatedToRole }`. Status → 'escalated'.
  'scope_escalated',
  /// Reviewer edited the assumptions field. Payload: `{ length }`.
  'scope_assumptions_updated',
  /// Reviewer edited the exclusions field. Payload: `{ length }`.
  'scope_exclusions_updated',
  /// New quote line item added (travel/tool/resource/discount/custom).
  /// Payload: `{ lineItemId, kind, label, amountCents }`.
  'quote_line_item_added',
  /// Quote line item removed.
  /// Payload: `{ lineItemId, kind, label, amountCents }`.
  'quote_line_item_removed',
  /// Quote line item edited in place. Payload:
  /// `{ lineItemId, kind, label, amountCents }`.
  'quote_line_item_updated',
  // Phase B — classification + routing.
  /// First classification (LLM or manual). Payload:
  /// `{ categorySlug, subCategorySlug?, source: 'llm' | 'manual', model? }`.
  'engagement_classified',
  /// Reclassification — category changed after a previous one was set.
  /// Same payload as `engagement_classified` plus
  /// `previousCategorySlug` + `previousSubCategorySlug`.
  'engagement_reclassified',
  /// Reviewer auto-assigned by the routing service.
  /// Payload: `{ reviewerUserId, categorySlug, ruleId }`.
  'reviewer_assigned',
  /// Manual reassignment by an admin / manager.
  /// Payload: `{ previousReviewerUserId, reviewerUserId, reason? }`.
  'reviewer_reassigned',
  // Phase C — multi-level approval (PM workflow stage 5).
  /// Sales manager approved a price that exceeds a tenant threshold;
  /// escalating to VP or CEO. Payload:
  ///   { level: 'vp' | 'ceo', approvedPriceCents, thresholdCents }
  'final_approval_requested',
  /// VP or CEO greenlit the gated approval.
  /// Payload: `{ level, approvedPriceCents, approverRole, comment? }`
  'final_approval_granted',
  /// VP or CEO rejected the gated approval; status → 'rejected'.
  /// Payload: `{ level, approverRole, reason }`
  'final_approval_rejected',
  /// Engagement was created from an external email (e.g. via the Outlook
  /// add-in). Emitted once at creation time alongside `link_issued`, so the
  /// audit timeline preserves provenance — the rep can see which inbound
  /// email kicked off the opportunity. Payload:
  ///   { source: 'outlook' | 'gmail' | 'manual_paste',
  ///     messageId, fromEmail, fromName?, subject, bodySnippet }
  /// `bodySnippet` is the first ~500 chars of the email body (full body is
  /// not stored — too noisy for the timeline and we don't have a separate
  /// raw-email store yet).
  'engagement_created_from_email',
  // Direct-ingest pipeline — see docs/direct-ingest.md §3.5.
  /// One or more IngestionArtifact rows were promoted into this
  /// engagement (paste-text, file-drop, voice, WhatsApp). Note: the
  /// Outlook add-in path emits `engagement_created_from_email` above
  /// instead — it doesn't use the IngestionArtifact pipeline.
  /// Distinct from `link_issued` — no gathering token exists yet.
  /// Payload: `{ source, artifactIds, kind }` where `source` is an
  /// EngagementSource value and `kind` is an ArtifactKind value.
  'requirements_ingested',
  /// A gathering link was minted against an *existing* engagement —
  /// either the first link on a direct-ingest opportunity (rep needs
  /// follow-up scoping) or a re-issue on a previously-linked one.
  /// Distinct from `link_issued`, which only fires on the very first
  /// token for an engagement created via the link-share wizard.
  /// Payload: `{ tokenId, expiresAt, reason? }`.
  'link_reissued',
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
