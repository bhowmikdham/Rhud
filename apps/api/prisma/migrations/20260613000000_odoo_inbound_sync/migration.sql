-- Inbound (Odoo → Rhud) sync infrastructure.
--
-- What's added:
--   1. Polling cursor on odoo_connections so tenants without Studio
--      Automation Rules (i.e. anyone not on the Custom plan) can still
--      receive inbound updates via incremental search_read.
--   2. Snapshot cache + push timestamp on odoo_entity_links so the
--      processor can dedupe webhook echoes (Rhud pushes → Odoo fires
--      its own webhook → would otherwise come straight back).
--   3. odoo_imported_opportunities — snapshots of crm.lead records
--      that came from Odoo but haven't yet been promoted to a Rhud
--      Engagement. A user picks a template + salesperson to "promote"
--      a snapshot, which then creates an Engagement bound to the
--      Odoo record via the existing odoo_entity_links table.
--   4. engagements.imported_from_odoo flag — distinguishes an
--      Engagement promoted from Odoo from one issued natively, so the
--      UI can hide the Rhud-only gathering flow on imported records.

-- ── 1. Polling cursor on odoo_connections ────────────────────────────

ALTER TABLE odoo_connections
  ADD COLUMN last_polled_at        timestamptz,
  ADD COLUMN poll_interval_seconds integer NOT NULL DEFAULT 300;

-- ── 2. Snapshot cache + push timestamp on odoo_entity_links ──────────
-- cached_record holds the most recent canonical record we fetched
-- from Odoo (after webhook fire / polling tick). last_pushed_at marks
-- when WE last wrote to the Odoo record — the processor uses it to
-- skip inbound events whose Odoo write_date is within ~30s, which
-- almost always means the inbound is just our own write echoing back.

ALTER TABLE odoo_entity_links
  ADD COLUMN cached_record   jsonb,
  ADD COLUMN cached_at       timestamptz,
  ADD COLUMN last_pushed_at  timestamptz;

CREATE INDEX odoo_entity_links_write_date_idx
  ON odoo_entity_links (tenant_id, odoo_write_date DESC);

-- ── 3. Imported-but-not-promoted opportunity snapshots ───────────────
--
-- These rows are the lightweight "we know this Odoo opportunity
-- exists" representation. They show up in the Rhud UI under "External
-- opportunities". A user can then promote one to a real Engagement
-- (which requires picking a template + salesperson — fields Odoo's
-- crm.lead doesn't carry).

CREATE TABLE odoo_imported_opportunities (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  odoo_model               text        NOT NULL DEFAULT 'crm.lead',
  odoo_id                  integer     NOT NULL,
  --Canonical snapshot from Odoo (after re-fetching, never the raw webhook payload).
  snapshot                 jsonb       NOT NULL,
  --Odoo's `write_date` from the snapshot. NULL only when a record
  --pre-dates v8 or was created without it (very rare).
  odoo_write_date          timestamptz,
  --When set, the snapshot has been promoted to a Rhud Engagement.
  --We keep the row after promotion for audit (\"this engagement
  --was imported on X by Y\").
  promoted_engagement_id   uuid        REFERENCES engagements(id) ON DELETE SET NULL,
  promoted_at              timestamptz,
  promoted_by              uuid,
  --First time we saw this Odoo record (via webhook or polling tick).
  imported_at              timestamptz NOT NULL DEFAULT now(),
  --Last refresh of the snapshot cache.
  last_refreshed_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT odoo_imported_opportunities_uniq UNIQUE (tenant_id, odoo_model, odoo_id)
);

CREATE INDEX odoo_imported_opportunities_tenant_idx
  ON odoo_imported_opportunities (tenant_id);
CREATE INDEX odoo_imported_opportunities_unpromoted_idx
  ON odoo_imported_opportunities (tenant_id, promoted_at) WHERE promoted_at IS NULL;
CREATE INDEX odoo_imported_opportunities_engagement_idx
  ON odoo_imported_opportunities (promoted_engagement_id);

ALTER TABLE odoo_imported_opportunities ENABLE ROW LEVEL SECURITY;

CREATE POLICY odoo_imported_opportunities_isolation ON odoo_imported_opportunities
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON odoo_imported_opportunities TO rhud_app;

-- ── 4. engagements.imported_from_odoo flag ───────────────────────────

ALTER TABLE engagements
  ADD COLUMN imported_from_odoo boolean NOT NULL DEFAULT false;

CREATE INDEX engagements_imported_from_odoo_idx
  ON engagements (tenant_id) WHERE imported_from_odoo = true;
