-- Rate-card-driven mapper prompt — see plan: majestic-whistling-whistle.md
-- (Tier 2 of the rate-card-driven mapper refactor).
--
-- The Layer-3 mapper used to bake cybersec vocabulary into its system
-- prompt ("white-box service lines containing source_code", "Private/
-- Enterprise sector"). That worked for Prophaze and broke the moment a
-- non-cybersec tenant (cleaning, legal, anything else) published a rate
-- card. The fix: the rate card carries its own inference ontology and
-- the mapper composes its prompt from the rate card at runtime.
--
-- Three new columns:
--   • rate_cards.inference_context          — domain framing for the whole card
--   • rate_cards.default_methodology_rule    — customer-type → methodology mapping
--   • rate_cards.inference_examples          — 1–3 few-shot input/output pairs
--   • rate_card_service_lines.inference_hint — when to emit this slug
--   • rate_card_service_lines.inference_examples — 0–3 worked examples
--
-- All columns are nullable / default empty so existing rate cards keep
-- working — the mapper falls back to a synthesizeDefaultHint() helper
-- for any slug without an explicit hint.

ALTER TABLE rate_cards
  ADD COLUMN IF NOT EXISTS inference_context TEXT,
  ADD COLUMN IF NOT EXISTS default_methodology_rule TEXT,
  ADD COLUMN IF NOT EXISTS inference_examples JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE rate_card_service_lines
  ADD COLUMN IF NOT EXISTS inference_hint TEXT,
  ADD COLUMN IF NOT EXISTS inference_examples JSONB NOT NULL DEFAULT '[]'::jsonb;
