-- Persistent retry queue for document extraction. When the LLM
-- provider rate-limits us (Gemini 429 / RESOURCE_EXHAUSTED is the
-- common case), inline backoff inside the request is useless — the
-- per-minute token bucket doesn't reset until the minute rolls over.
-- Instead we mark the row `retry_queued` with a future `retry_at`
-- and a small cron picks it up and re-fires kickoff once the throttle
-- window has cleared.

ALTER TABLE engagement_files
  ADD COLUMN extraction_retry_at  timestamptz,
  ADD COLUMN extraction_attempts  integer NOT NULL DEFAULT 0;

-- Allow the new 'retry_queued' status; existing constraint listed
-- only the original five states.
ALTER TABLE engagement_files
  DROP CONSTRAINT IF EXISTS engagement_files_extraction_status_chk;

ALTER TABLE engagement_files
  ADD CONSTRAINT engagement_files_extraction_status_chk
  CHECK (
    extraction_status IS NULL
    OR extraction_status IN ('pending', 'processing', 'ready', 'failed', 'skipped', 'retry_queued')
  );

-- Index the cron's hot path (status + retry_at).
CREATE INDEX engagement_files_retry_queue_idx
  ON engagement_files (extraction_status, extraction_retry_at)
  WHERE extraction_status = 'retry_queued';
