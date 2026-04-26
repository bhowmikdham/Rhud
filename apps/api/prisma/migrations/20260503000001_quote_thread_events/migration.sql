-- Add `quote_computed` and `quote_approved` to the thread_events whitelist
-- so the deterministic Stage-2 base price + manager approval show up in
-- the audit chain alongside scope_submitted / price_predicted.
ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;

ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'scope_submitted','price_predicted','approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved'
    ));
