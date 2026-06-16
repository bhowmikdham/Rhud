-- Volume pooling across multi-application instances (per_unit lines).
-- The flag lived only in the fixture/TS type, so the live quote (which loads
-- the rate card from the DB) never saw it and always priced each app at its
-- own tier. Persist it as a column and backfill existing rate cards.
ALTER TABLE rate_card_service_lines
  ADD COLUMN IF NOT EXISTS pool_across_entities BOOLEAN NOT NULL DEFAULT false;

-- Backfill: pool the per-app, per_unit volume-tiered lines (web app / API /
-- mobile). Network / cloud are infra-wide (single instance) so they stay off.
UPDATE rate_card_service_lines
   SET pool_across_entities = true
 WHERE pricing_model = 'per_unit'
   AND slug ~ '^vapt_(web_app|api|mobile)_';
