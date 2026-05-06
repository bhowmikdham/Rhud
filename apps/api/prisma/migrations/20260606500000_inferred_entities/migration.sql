-- Cached output of the rate-card field mapper (Layer 3 of the
-- extraction-to-pricing pipeline). Computed at extraction time and
-- read by QuoteService.computeAndPersistForEngagement on every
-- re-predict, so the LLM only fires ONCE per file regardless of
-- how many times the manager re-evaluates the quote. Solves both
-- the rate-limit pressure and the latency on Re-predict.

ALTER TABLE engagement_files
  ADD COLUMN inferred_entities jsonb;
