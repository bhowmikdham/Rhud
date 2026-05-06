-- Whitelist the new `file_extracted` thread event type so the
-- document-extraction pipeline can emit it as part of the audit chain.

ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;

ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'file_extracted',
      'scope_submitted','price_predicted','approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved'
    ));
