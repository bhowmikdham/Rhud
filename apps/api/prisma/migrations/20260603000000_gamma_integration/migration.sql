-- Gamma integration: per-tenant API config + deck reference columns
-- on engagements so a Gamma-driven proposal lives alongside an LLM-
-- driven one (they share status transitions; the proposal_draft_source
-- column tells the UI which renderer to use).

CREATE TABLE tenant_gamma_config (
  tenant_id                UUID         PRIMARY KEY,
  workspace_name           TEXT,
  workspace_id             TEXT,
  api_key_ciphertext       BYTEA,
  api_key_iv               BYTEA,
  api_key_dek_ciphertext   BYTEA,
  api_key_dek_iv           BYTEA,
  proposal_driver          TEXT         NOT NULL DEFAULT 'llm',
  enabled                  BOOLEAN      NOT NULL DEFAULT true,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT tenant_gamma_config_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tenant_gamma_config_proposal_driver_check
    CHECK (proposal_driver IN ('llm', 'gamma')),
  -- Same all-or-nothing rule as tenant_llm_config: either every key
  -- column is populated (admin entered an API key) or all are NULL.
  CONSTRAINT tenant_gamma_config_key_consistency
    CHECK (
      (api_key_ciphertext IS NULL AND api_key_iv IS NULL
        AND api_key_dek_ciphertext IS NULL AND api_key_dek_iv IS NULL)
      OR
      (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL
        AND api_key_dek_ciphertext IS NOT NULL AND api_key_dek_iv IS NOT NULL)
    )
);

ALTER TABLE tenant_gamma_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_gamma_config FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_gamma_config_isolation ON tenant_gamma_config
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_gamma_config TO rhud_app;

-- Engagement columns for the Gamma deck pointer.
ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS gamma_deck_url  TEXT,
  ADD COLUMN IF NOT EXISTS gamma_deck_id   TEXT;
