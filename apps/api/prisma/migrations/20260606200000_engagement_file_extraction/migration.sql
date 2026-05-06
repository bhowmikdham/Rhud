-- Document extraction pipeline state on engagement_files.
-- Files uploaded by the client (e.g. requirements PDFs, scope
-- spreadsheets) get text-extracted then LLM-structured into a
-- key/value list of pricing-relevant data points.
--
-- All columns nullable — extraction is async and lazy; legacy rows
-- that pre-date this feature have null extraction_status, treated as
-- "never attempted" by the service.

ALTER TABLE engagement_files
  ADD COLUMN extraction_status      text,
  ADD COLUMN extraction_started_at  timestamptz,
  ADD COLUMN extracted_at           timestamptz,
  ADD COLUMN extraction_error       text,
  ADD COLUMN extracted_text         text,
  ADD COLUMN extracted_points       jsonb;

ALTER TABLE engagement_files
  ADD CONSTRAINT engagement_files_extraction_status_chk
  CHECK (
    extraction_status IS NULL
    OR extraction_status IN ('pending', 'processing', 'ready', 'failed', 'skipped')
  );

CREATE INDEX engagement_files_status_idx
  ON engagement_files (engagement_id, extraction_status);
