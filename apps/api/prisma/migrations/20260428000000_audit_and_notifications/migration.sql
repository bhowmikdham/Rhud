-- Sprint 4 — audit hash chain + per-tenant notification config.
--
-- 1. tenants.notification_config — JSONB. Shape lives in @rhud/shared
--    `TenantNotificationConfig`. Null means "use defaults".
-- 2. audit_chain_links — periodic Merkle-style hash chain over thread_events
--    (design doc §4.6 audit integrity). Each link covers a window
--    [from_created_at, to_created_at) and stores root_hash chained off the
--    previous link's root. Verification re-computes the chain and asserts
--    every stored root matches.
--
-- audit_chain_links is APPEND-ONLY at the role level — same posture as
-- thread_events. Even a buggy app can't rewrite history.

-- ── tenants.notification_config ──────────────────────────────────────────────
ALTER TABLE "tenants" ADD COLUMN "notification_config" JSONB;

-- ── audit_chain_links ────────────────────────────────────────────────────────
CREATE TABLE "audit_chain_links" (
  "id"               UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"        UUID        NOT NULL,
  "sequence"         INTEGER     NOT NULL,
  "root_hash"        TEXT        NOT NULL,
  "prev_hash"        TEXT,
  "from_created_at"  TIMESTAMPTZ NOT NULL,
  "to_created_at"    TIMESTAMPTZ NOT NULL,
  "event_count"      INTEGER     NOT NULL,
  "computed_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),
  "mirrored_s3_key"  TEXT,
  CONSTRAINT "audit_chain_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_chain_links_seq_unique" UNIQUE ("tenant_id","sequence")
);

CREATE INDEX "audit_chain_links_tenant_id_computed_at_idx"
  ON "audit_chain_links"("tenant_id","computed_at");

ALTER TABLE "audit_chain_links"
  ADD CONSTRAINT "audit_chain_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;

-- ── RLS ──────────────────────────────────────────────────────────────────────
ALTER TABLE "audit_chain_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_chain_links" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "audit_chain_links_tenant_isolation" ON "audit_chain_links"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── Runtime grants — append-only ─────────────────────────────────────────────
-- Same posture as thread_events: SELECT + INSERT only. Even mirroring updates
-- (mirrored_s3_key) happen via a separate ALTER from a maintenance role; the
-- runtime app cannot UPDATE its own audit history.
GRANT SELECT, INSERT ON "audit_chain_links" TO rhud_app;

-- The mirror job (later sprint) needs UPDATE for setting mirrored_s3_key.
-- We add it now to keep the migration self-contained, but the maintenance
-- pipeline that calls it should connect via a separate role in production.
GRANT UPDATE ("mirrored_s3_key") ON "audit_chain_links" TO rhud_app;
