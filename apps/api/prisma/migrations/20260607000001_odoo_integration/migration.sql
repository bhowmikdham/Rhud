-- Odoo (cloud) integration tables: connection, mappings, sync logs,
-- entity links, webhook events. All tenant-scoped; RLS enforced.

CREATE TABLE odoo_connections (
  tenant_id              uuid        PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  url                    text        NOT NULL,
  database               text        NOT NULL,
  login                  text        NOT NULL,
  uid                    integer,
  api_key_ciphertext     bytea       NOT NULL,
  api_key_iv             bytea       NOT NULL,
  api_key_dek_ciphertext bytea       NOT NULL,
  api_key_dek_iv         bytea       NOT NULL,
  auto_sync_enabled      boolean     NOT NULL DEFAULT true,
  default_team_id        integer,
  default_user_id        integer,
  webhook_secret         text        NOT NULL,
  last_connected_at      timestamptz,
  last_error_message     text,
  server_version         text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE odoo_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_connections_isolation ON odoo_connections
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_connections TO rhud_app;

-- ── Field mappings: Rhud → Odoo (and back) ─────────────────────────

CREATE TABLE odoo_field_mappings (
  id           uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rhud_entity  text         NOT NULL,
  rhud_field   text         NOT NULL,
  odoo_model   text         NOT NULL,
  odoo_field   text         NOT NULL,
  transform    text,
  required     boolean      NOT NULL DEFAULT false,
  direction    text         NOT NULL DEFAULT 'push',
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT odoo_field_mappings_direction_chk
    CHECK (direction IN ('push', 'pull', 'both'))
);

CREATE UNIQUE INDEX odoo_field_mappings_uniq
  ON odoo_field_mappings (tenant_id, rhud_entity, rhud_field, odoo_model, odoo_field, direction);

CREATE INDEX odoo_field_mappings_tenant_idx ON odoo_field_mappings (tenant_id);

ALTER TABLE odoo_field_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_field_mappings_isolation ON odoo_field_mappings
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_field_mappings TO rhud_app;

-- ── Entity links: Rhud-id ↔ Odoo-id ────────────────────────────────

CREATE TABLE odoo_entity_links (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rhud_entity     text        NOT NULL,
  rhud_id         text        NOT NULL,
  odoo_model      text        NOT NULL,
  odoo_id         integer     NOT NULL,
  last_synced_at  timestamptz,
  odoo_write_date timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX odoo_entity_links_rhud_uniq
  ON odoo_entity_links (tenant_id, rhud_entity, rhud_id, odoo_model);
CREATE UNIQUE INDEX odoo_entity_links_odoo_uniq
  ON odoo_entity_links (tenant_id, odoo_model, odoo_id);
CREATE INDEX odoo_entity_links_tenant_idx ON odoo_entity_links (tenant_id);

ALTER TABLE odoo_entity_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_entity_links_isolation ON odoo_entity_links
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_entity_links TO rhud_app;

-- ── Sync logs (append-only audit) ──────────────────────────────────

CREATE TABLE odoo_sync_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rhud_entity      text,
  rhud_id          text,
  odoo_model       text,
  odoo_id          integer,
  direction        text        NOT NULL,
  operation        text        NOT NULL,
  status           text        NOT NULL,
  triggered_by     text        NOT NULL,
  actor_user_id    uuid,
  error_message    text,
  request_payload  jsonb,
  response_payload jsonb,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT odoo_sync_logs_status_chk
    CHECK (status IN ('ok', 'error', 'skipped')),
  CONSTRAINT odoo_sync_logs_direction_chk
    CHECK (direction IN ('push', 'pull')),
  CONSTRAINT odoo_sync_logs_operation_chk
    CHECK (operation IN ('create', 'update', 'unlink', 'read', 'webhook', 'authenticate', 'test')),
  CONSTRAINT odoo_sync_logs_triggered_by_chk
    CHECK (triggered_by IN ('auto', 'manual', 'webhook', 'system'))
);

CREATE INDEX odoo_sync_logs_tenant_created_idx
  ON odoo_sync_logs (tenant_id, created_at DESC);
CREATE INDEX odoo_sync_logs_tenant_status_idx
  ON odoo_sync_logs (tenant_id, status);

ALTER TABLE odoo_sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_sync_logs_isolation ON odoo_sync_logs
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_sync_logs TO rhud_app;

-- ── Webhook event log (inbound from Odoo Studio Automation Rules) ──

CREATE TABLE odoo_webhook_events (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  odoo_model    text        NOT NULL,
  odoo_id       integer,
  event_type    text        NOT NULL,
  payload       jsonb       NOT NULL,
  status        text        NOT NULL DEFAULT 'pending',
  error_message text,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  CONSTRAINT odoo_webhook_events_status_chk
    CHECK (status IN ('pending', 'processed', 'failed', 'ignored'))
);

CREATE INDEX odoo_webhook_events_tenant_status_idx
  ON odoo_webhook_events (tenant_id, status);
CREATE INDEX odoo_webhook_events_tenant_received_idx
  ON odoo_webhook_events (tenant_id, received_at DESC);

ALTER TABLE odoo_webhook_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_webhook_events_isolation ON odoo_webhook_events
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_webhook_events TO rhud_app;
