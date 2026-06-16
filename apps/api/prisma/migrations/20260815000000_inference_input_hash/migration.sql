-- Content-addressed inference cache. Stores a hash of the inference INPUTS
-- (extracted points + rate-card version + prompt version) alongside the
-- cached inferred_entities, so a re-run of an UNCHANGED document short-circuits
-- the (non-deterministic) LLM call and returns the identical result — fixing
-- "re-run the same doc, get a different quote".
ALTER TABLE engagement_files ADD COLUMN IF NOT EXISTS inference_input_hash TEXT;
