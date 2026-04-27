-- Invites + per-tenant LLM config.
--
-- 1. invites: pending team invitations. Token is hashed (argon2). Roles
--    constrained to the same enum as users.role. Lifecycle terminal at
--    accepted_at OR revoked_at. Email is stored citext for case-insensitive
--    lookup (matches users.email).
--
-- 2. tenant_llm_config: one row per tenant, holds provider config + the
--    encrypted API key. Envelope encryption: per-config DEK is wrapped by
--    the LLM_KEY_ENCRYPTION_KEY env (32 bytes), the DEK then encrypts the
--    actual API key. Both layers are AES-256-GCM with their own IVs. The
--    plaintext key never lands in this DB.
--
-- Both tables follow the standard tenant-isolation contract: tenant_id
-- column + RLS enabled with FORCE + isolation policy + grants to rhud_app.

-- ── invites ────────────────────────────────────────────────────────────────

CREATE TABLE invites (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID         NOT NULL,
  email           CITEXT       NOT NULL,
  role            TEXT         NOT NULL,
  token_hash      TEXT         NOT NULL,
  invited_by_id   UUID         NOT NULL,
  expires_at      TIMESTAMPTZ  NOT NULL,
  accepted_at     TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT invites_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT invites_role_check
    CHECK (role IN ('admin', 'sales_manager', 'sales_employee'))
);

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;

CREATE POLICY invites_isolation ON invites
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON invites TO rhud_app;

CREATE INDEX invites_tenant_id_idx ON invites (tenant_id);
CREATE INDEX invites_email_idx ON invites (email);
-- Partial unique: only one OPEN invite per (tenant, email). Accepted /
-- revoked invites stay around for audit but don't block re-inviting.
CREATE UNIQUE INDEX invites_tenant_email_open_unique
  ON invites (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ── tenant_llm_config ──────────────────────────────────────────────────────

CREATE TABLE tenant_llm_config (
  tenant_id                UUID         PRIMARY KEY,
  provider                 TEXT         NOT NULL,
  model                    TEXT         NOT NULL,
  base_url                 TEXT,
  api_key_ciphertext       BYTEA,
  api_key_iv               BYTEA,
  api_key_dek_ciphertext   BYTEA,
  api_key_dek_iv           BYTEA,
  monthly_token_budget     INTEGER      NOT NULL DEFAULT 0,
  enabled                  BOOLEAN      NOT NULL DEFAULT true,
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT tenant_llm_config_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT tenant_llm_config_provider_check
    CHECK (provider IN ('anthropic', 'openai', 'ollama', 'openai_compat')),
  -- API key columns are all-or-nothing: either every encryption field is
  -- present (BYO with key) or all four are NULL (Ollama / no-auth setup).
  CONSTRAINT tenant_llm_config_key_consistency
    CHECK (
      (api_key_ciphertext IS NULL AND api_key_iv IS NULL
        AND api_key_dek_ciphertext IS NULL AND api_key_dek_iv IS NULL)
      OR
      (api_key_ciphertext IS NOT NULL AND api_key_iv IS NOT NULL
        AND api_key_dek_ciphertext IS NOT NULL AND api_key_dek_iv IS NOT NULL)
    )
);

ALTER TABLE tenant_llm_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_llm_config FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_llm_config_isolation ON tenant_llm_config
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_llm_config TO rhud_app;
