-- Per-user OAuth integrations (Outlook now, Gmail later). Tokens are
-- stored using the same envelope encryption as tenant_llm_config —
-- one DEK per row wrapped by LLM_KEY_ENCRYPTION_KEY.

CREATE TABLE user_integrations (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                       uuid        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  tenant_id                     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider                      text        NOT NULL,
  account_email                 text        NOT NULL,

  access_token_ciphertext       bytea       NOT NULL,
  access_token_iv               bytea       NOT NULL,
  access_token_dek_ciphertext   bytea       NOT NULL,
  access_token_dek_iv           bytea       NOT NULL,
  access_token_expires_at       timestamptz NOT NULL,

  refresh_token_ciphertext      bytea,
  refresh_token_iv              bytea,
  refresh_token_dek_ciphertext  bytea,
  refresh_token_dek_iv          bytea,

  scopes                        text,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_integrations_provider_chk CHECK (provider IN ('outlook', 'gmail')),
  CONSTRAINT user_integrations_user_provider_uniq UNIQUE (user_id, provider)
);

CREATE INDEX user_integrations_tenant_idx ON user_integrations (tenant_id);

-- RLS: scoped on tenant_id like every other tenant-bound table.
ALTER TABLE user_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_integrations_tenant_isolation ON user_integrations
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON user_integrations TO rhud_app;
