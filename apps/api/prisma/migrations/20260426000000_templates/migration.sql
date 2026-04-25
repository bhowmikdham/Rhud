-- Sprint 2 — templates + template_nodes.
--
-- Adds the decision-tree schema from design doc §4.4, with RLS policies
-- consistent with sprint 1. Key shape decisions:
--   - `root_node_id` is a self-referential FK (templates → template_nodes).
--     Nullable because templates start empty; set when the first node is
--     created or via an explicit admin endpoint.
--   - `tenant_id` is denormalized onto template_nodes so the RLS policy is
--     single-table (no join through templates).
--   - `next_rules` is JSONB with a documented shape; application code
--     (src/templates/engine) is the source of truth for the schema.

-- ── templates ────────────────────────────────────────────────────────────────
CREATE TABLE "templates" (
  "id"           UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"    UUID        NOT NULL,
  "service_line" TEXT        NOT NULL,
  "name"         TEXT        NOT NULL,
  "version"      INTEGER     NOT NULL DEFAULT 1,
  "status"       TEXT        NOT NULL DEFAULT 'draft',
  "root_node_id" UUID,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "templates_status_check" CHECK ("status" IN ('draft','published','archived'))
);

CREATE INDEX "templates_tenant_id_idx"        ON "templates"("tenant_id");
CREATE INDEX "templates_tenant_id_status_idx" ON "templates"("tenant_id","status");

ALTER TABLE "templates"
  ADD CONSTRAINT "templates_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── template_nodes ──────────────────────────────────────────────────────────
CREATE TABLE "template_nodes" (
  "id"          UUID    NOT NULL DEFAULT gen_random_uuid(),
  "template_id" UUID    NOT NULL,
  "tenant_id"   UUID    NOT NULL,
  "question"    TEXT    NOT NULL,
  "node_type"   TEXT    NOT NULL,
  "options"     JSONB,
  "allow_files" BOOLEAN NOT NULL DEFAULT false,
  "next_rules"  JSONB   NOT NULL DEFAULT '[]'::jsonb,
  "position"    INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "template_nodes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "template_nodes_node_type_check"
    CHECK ("node_type" IN ('single_select','multi_select','short_text','long_text','number','file_upload'))
);

CREATE INDEX "template_nodes_template_id_idx" ON "template_nodes"("template_id");
CREATE INDEX "template_nodes_tenant_id_idx"   ON "template_nodes"("tenant_id");

ALTER TABLE "template_nodes"
  ADD CONSTRAINT "template_nodes_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Self-referential FK on templates.root_node_id — add AFTER template_nodes
-- exists. Nullable + ON DELETE SET NULL so deleting the root node doesn't
-- cascade back into the parent template.
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_root_node_id_fkey"
  FOREIGN KEY ("root_node_id") REFERENCES "template_nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Row-Level Security ──────────────────────────────────────────────────────
ALTER TABLE "templates"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "templates"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "template_nodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "template_nodes" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "templates_tenant_isolation" ON "templates"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "template_nodes_tenant_isolation" ON "template_nodes"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── Runtime role grants ─────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "templates"      TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "template_nodes" TO rhud_app;

-- ── updated_at auto-touch trigger ───────────────────────────────────────────
-- Prisma emits @updatedAt which handles this at the ORM layer, but a DB-level
-- trigger also protects raw-SQL writers (seed scripts, imports).
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER templates_set_updated_at
  BEFORE UPDATE ON "templates"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
