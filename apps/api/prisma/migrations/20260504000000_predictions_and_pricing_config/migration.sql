-- Sprint 1: adaptive pricing — schema foundation.
--
-- 1. engagements.closed_engagement_count_snapshot — pinned at predict-time
--    so regime selection is reproducible later even after more deals close.
-- 2. tenant_pricing_config — per-tenant tunables: regime thresholds,
--    loyalty rules, manual modifiers, retrain hour. Lives in DB, not
--    code, so a customer with thin data can opt to stay in rules longer.
-- 3. predictions — append-only history. A prediction is never updated;
--    a re-predict creates a new row and supersedes by created_at desc.
--
-- All three tables follow the existing tenant-isolation contract:
--   - tenant_id column + RLS enabled with FORCE
--   - SELECT/INSERT/UPDATE/DELETE granted to rhud_app
--   - policy keyed on current_setting('app.tenant_id')::uuid

ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS closed_engagement_count_snapshot INTEGER;

-- ── tenant_pricing_config ──────────────────────────────────────────────────

CREATE TABLE tenant_pricing_config (
  tenant_id                  UUID         PRIMARY KEY,
  loyalty_rules              JSONB        NOT NULL DEFAULT '[]'::jsonb,
  manual_modifiers           JSONB        NOT NULL DEFAULT '[]'::jsonb,
  cold_start_until_n_closed  INTEGER      NOT NULL DEFAULT 5,
  rules_until_n_closed       INTEGER      NOT NULL DEFAULT 30,
  linear_until_n_closed      INTEGER      NOT NULL DEFAULT 100,
  retrain_hour_utc           INTEGER      NOT NULL DEFAULT 2,
  updated_at                 TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT tenant_pricing_config_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tenant_pricing_config_thresholds_ordered
    CHECK (cold_start_until_n_closed <= rules_until_n_closed
           AND rules_until_n_closed <= linear_until_n_closed),
  CONSTRAINT tenant_pricing_config_retrain_hour_check
    CHECK (retrain_hour_utc >= 0 AND retrain_hour_utc < 24)
);

ALTER TABLE tenant_pricing_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_pricing_config FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_pricing_config_isolation ON tenant_pricing_config
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_pricing_config TO rhud_app;

-- ── predictions ────────────────────────────────────────────────────────────

CREATE TABLE predictions (
  id                       UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID         NOT NULL,
  engagement_id            UUID         NOT NULL,
  -- cold_start | rules | linear | boosted (CHECK below).
  regime                   TEXT         NOT NULL,
  base_price_cents         BIGINT       NOT NULL,
  predicted_price_cents    BIGINT       NOT NULL,
  -- Signed ratio (final/base − 1). 0 in cold_start. NUMERIC(6,4) gives
  -- four decimals up to ±99.9999 — plenty for a discount/premium pct.
  adjustment_pct           NUMERIC(6,4) NOT NULL DEFAULT 0,
  band_low_cents           BIGINT       NOT NULL,
  band_high_cents          BIGINT       NOT NULL,
  -- Win-prob fields stay null until a classifier ships. Three of them
  -- so the approval card can show three points on the win-curve later.
  win_prob_at_predicted    NUMERIC(4,3),
  win_prob_at_base         NUMERIC(4,3),
  win_prob_at_band_low     NUMERIC(4,3),
  -- [{feature, weight, direction}] — populated in rules regime, empty
  -- in cold_start. ML regimes will populate from SHAP later.
  drivers                  JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- [{engagement_id, base, final, won, similarity}] — empty until ML.
  similar_past             JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- {closed_used, last_trained_at, model_version} — provenance for the
  -- "data quality" note in the UI.
  data_quality             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT predictions_engagement_id_fkey
    FOREIGN KEY (engagement_id) REFERENCES engagements(id) ON DELETE CASCADE,
  CONSTRAINT predictions_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT predictions_regime_check
    CHECK (regime IN ('cold_start','rules','linear','boosted'))
);

ALTER TABLE predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE predictions FORCE ROW LEVEL SECURITY;

CREATE POLICY predictions_isolation ON predictions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON predictions TO rhud_app;

CREATE INDEX predictions_tenant_id_idx
  ON predictions (tenant_id);
CREATE INDEX predictions_engagement_id_created_at_idx
  ON predictions (engagement_id, created_at DESC);
