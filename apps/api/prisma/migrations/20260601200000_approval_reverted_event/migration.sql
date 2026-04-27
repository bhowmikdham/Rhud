-- Add `approval_reverted` to the thread_events whitelist so the new
-- admin-only revert flow can record an audit event when an approval or
-- rejection is rolled back (e.g. the manager clicked the wrong button).
ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;

ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'scope_submitted','price_predicted','approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved'
    ));
