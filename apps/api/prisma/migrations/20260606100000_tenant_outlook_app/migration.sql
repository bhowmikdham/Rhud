-- Per-tenant Microsoft Entra app credentials. One row per workspace,
-- managed via the admin UI in /integrations. Replaces the OUTLOOK_*
-- env-var approach so admins can set this up without server access.

CREATE TABLE tenant_outlook_app (
  tenant_id                    uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  client_id                    text        NOT NULL,

  client_secret_ciphertext     bytea       NOT NULL,
  client_secret_iv             bytea       NOT NULL,
  client_secret_dek_ciphertext bytea       NOT NULL,
  client_secret_dek_iv         bytea       NOT NULL,

  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_outlook_app ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_outlook_app_isolation ON tenant_outlook_app
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_outlook_app TO rhud_app;
