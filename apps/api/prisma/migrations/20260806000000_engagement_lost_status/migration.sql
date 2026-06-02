-- Phase F: add the 'lost' terminal status. A 'sent' opportunity can be marked
-- won (-> 'closed') or lost (-> 'lost') from the deal-outcome surface. Mirrors
-- the engagements_status_check rewrite in 20260802000000_direct_ingest_pipeline,
-- with 'lost' inserted after 'closed'.

ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_status_check;
ALTER TABLE engagements
  ADD CONSTRAINT engagements_status_check
    CHECK (status IN (
      'ingesting',
      'issued','in_progress','submitted','predicted',
      'pending_approval','approved',
      'drafting','draft_ready','sent','closed','lost','rejected','expired',
      'returned_to_sales','awaiting_clarification','escalated',
      'pending_vp_approval','pending_ceo_approval'
    ));
