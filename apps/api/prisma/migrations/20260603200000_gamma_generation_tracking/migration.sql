-- Track in-flight Gamma generations on the engagement so getCurrent()
-- can poll Gamma's /generations/{id} status endpoint instead of
-- blocking the original POST /draft request. This makes the UI feel
-- alive during the 30-90 seconds Gamma takes to produce a deck.
ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS gamma_generation_id         TEXT,
  ADD COLUMN IF NOT EXISTS gamma_generation_started_at TIMESTAMPTZ;
