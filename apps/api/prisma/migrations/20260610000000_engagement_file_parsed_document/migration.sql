-- Persist the canonical RhudDocument representation alongside
-- extracted_points + inferred_entities. Phase B Layer-1.5 capture so
-- the admin-review UI can show "exactly what we read from your sheet,
-- row by row" before any LLM step runs. Separates parsing-quality
-- diagnosis from extraction-quality diagnosis.
--
-- Schema: see packages/shared/src/document.ts (RhudDocument). Stored
-- as JSONB so the type can evolve in code without migrations; older
-- rows tolerate missing fields via defensive reads in consumers.
--
-- Nullable: rows extracted before this column existed (or for which
-- the parser bailed) keep parsed_document = NULL. The UI hides the
-- "Parsed structure" toggle when null.

ALTER TABLE engagement_files
  ADD COLUMN IF NOT EXISTS parsed_document JSONB;
