-- Resync thread_events_event_type_check with THREAD_EVENT_TYPES
-- (packages/shared/src/thread-events.ts). The CHECK had drifted out of sync:
-- it was missing 'source_code_review_skipped' — so every attempt to emit that
-- event threw a constraint violation and the source-code-review contradiction
-- flag silently failed. It was also missing 'quote_line_item_updated' and
-- 'engagement_created_from_email' (same latent bug). Recreate the constraint
-- from the full current event-type list.
ALTER TABLE thread_events DROP CONSTRAINT IF EXISTS thread_events_event_type_check;
ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'link_issued',
    'link_opened',
    'node_answered',
    'file_uploaded',
    'file_extracted',
    'loop_iteration_removed',
    'mapper_fallback_heuristic',
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
    'site_enumerated',
    'site_enumeration_failed',
    'ticket_opened',
    'ticket_status_changed',
    'ticket_resolved',
    'follow_up_scheduled',
    'follow_up_completed',
    'summary_generated',
    'scope_returned_to_sales',
    'clarification_requested',
    'scope_escalated',
    'scope_assumptions_updated',
    'scope_exclusions_updated',
    'quote_line_item_added',
    'quote_line_item_removed',
    'quote_line_item_updated',
    'engagement_classified',
    'engagement_reclassified',
    'reviewer_assigned',
    'reviewer_reassigned',
    'final_approval_requested',
    'final_approval_granted',
    'final_approval_rejected',
    'engagement_created_from_email',
    'requirements_ingested',
    'link_reissued'
  ]::text[]));
