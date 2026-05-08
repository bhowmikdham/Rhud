-- Lead-summary auto-generation infrastructure.
--
-- Two pieces:
--   1. Track which thread event the cached summary was generated
--      against. The thread events table is append-only (insert grant
--      only, no UPDATE/DELETE), so the latest event id + createdAt is
--      a stable fingerprint of the activity chain. The auto path
--      compares the cached event-at to the latest event's createdAt;
--      same → cache hit (no LLM call); different → regenerate.
--   2. Per-tenant toggle for the auto behaviour. Default ON because
--      the whole point is "user clicks an opportunity → summary is
--      already there". Tenants can flip it off in /settings if they
--      want to control LLM spend manually.

ALTER TABLE engagement_summaries
  ADD COLUMN based_on_event_id uuid,
  ADD COLUMN based_on_event_at timestamptz;

-- Existing rows: stamp them with the *current* latest event so the
-- next visit treats them as up-to-date until new activity lands.
-- Without this, every existing engagement would auto-regenerate on
-- first load, defeating the token-saving purpose.
UPDATE engagement_summaries s
SET
  based_on_event_id = (
    SELECT te.id FROM thread_events te
    WHERE te.engagement_id = s.engagement_id
    ORDER BY te.created_at DESC, te.id DESC
    LIMIT 1
  ),
  based_on_event_at = (
    SELECT te.created_at FROM thread_events te
    WHERE te.engagement_id = s.engagement_id
    ORDER BY te.created_at DESC, te.id DESC
    LIMIT 1
  );

ALTER TABLE tenants
  ADD COLUMN lead_summary_auto_generate boolean NOT NULL DEFAULT true;
