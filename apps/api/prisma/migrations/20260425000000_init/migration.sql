-- Init migration — sprint 1 schema + RLS foundation.
--
-- What this does:
--   1. Ensures Postgres extensions + the `rhud_app` runtime role exist
--      (idempotent — also installed at container init via infra/postgres/init).
--   2. Creates tenants, users, magic_links.
--   3. Enables Row-Level Security on every tenant-scoped table.
--   4. Defines a single policy per table keyed on
--      current_setting('app.tenant_id')::uuid, which the `withTenant` wrapper
--      sets as a transaction-local value before every query.
--   5. Grants the runtime `rhud_app` role table access, explicitly NOBYPASSRLS.
--
-- If you regenerate from schema.prisma (prisma migrate dev), preserve the RLS
-- and grant blocks at the bottom of this file — Prisma won't emit them.

-- ── Prerequisites (extensions + runtime role) ────────────────────────────────
-- These also live in infra/postgres/init so the dev container has them on
-- first boot. Embedding them here makes the migration self-contained, which
-- is what Prisma's shadow database needs to validate the migration cleanly.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rhud_app') THEN
    CREATE ROLE rhud_app LOGIN PASSWORD 'rhud_app' NOBYPASSRLS;
  END IF;
END
$$;

-- ── Tables ───────────────────────────────────────────────────────────────────
CREATE TABLE "tenants" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "name"         TEXT        NOT NULL,
  "plan"         TEXT        NOT NULL DEFAULT 'mvp',
  "odoo_config"  JSONB,
  "slack_config" JSONB,
  "teams_config" JSONB,
  "gamma_config" JSONB,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "users" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID        NOT NULL,
  "email"        CITEXT      NOT NULL,
  "password_hash" TEXT,
  "role"         TEXT        NOT NULL,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "users_role_check" CHECK ("role" IN ('admin','sales_manager','sales_employee'))
);

CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

ALTER TABLE "users"
  ADD CONSTRAINT "users_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "magic_links" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID        NOT NULL,
  "user_id"     UUID        NOT NULL,
  "token_hash"  TEXT        NOT NULL,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "magic_links_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "magic_links_user_id_idx" ON "magic_links"("user_id");
CREATE INDEX "magic_links_tenant_id_idx" ON "magic_links"("tenant_id");

ALTER TABLE "magic_links"
  ADD CONSTRAINT "magic_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "magic_links"
  ADD CONSTRAINT "magic_links_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security ──────────────────────────────────────────────────────
-- `tenants` is NOT tenant-scoped in the usual sense; a tenant is only ever
-- read/written by admin ops. We still enable RLS and allow access only when
-- app.tenant_id matches the row id — prevents accidental cross-tenant leakage
-- from unrelated code paths. Admin/system tasks use a separate DB role.

ALTER TABLE "tenants"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants"      FORCE ROW LEVEL SECURITY;
ALTER TABLE "users"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "users"        FORCE ROW LEVEL SECURITY;
ALTER TABLE "magic_links"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "magic_links"  FORCE ROW LEVEL SECURITY;

-- Tenants: a session may only see its own tenant row.
CREATE POLICY "tenants_self_access" ON "tenants"
  USING ("id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("id" = current_setting('app.tenant_id', true)::uuid);

-- Users: session only sees rows belonging to current app.tenant_id.
CREATE POLICY "users_tenant_isolation" ON "users"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- Magic links: same.
CREATE POLICY "magic_links_tenant_isolation" ON "magic_links"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── Runtime role grants ─────────────────────────────────────────────────────
-- `rhud_app` is created by infra/postgres/init/01-extensions.sql and is
-- explicitly NOBYPASSRLS. The app connects as this role at runtime.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenants"     TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "users"       TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "magic_links" TO rhud_app;
