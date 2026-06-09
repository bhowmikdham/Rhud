-- Gamma multi-template v2: a per-tenant LIBRARY of reusable Gamma proposal
-- decks, plus a per-opportunity selection column on engagements. Decouples
-- the deck choice from the questionnaire template — the deprecated
-- templates.gamma_template_id binding is retired in favour of this (the column
-- is intentionally KEPT here so the one-shot backfill can read it).
-- See docs/gamma-multi-template-design.md.

CREATE TABLE gamma_templates (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID         NOT NULL,
  label              TEXT         NOT NULL,
  -- The Gamma File ID this entry clones from (free-form; not a UUID).
  gamma_template_id  TEXT         NOT NULL,
  format             TEXT         NOT NULL DEFAULT 'presentation',
  service_line       TEXT,
  is_default         BOOLEAN      NOT NULL DEFAULT false,
  manifest           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT         NOT NULL DEFAULT 'active',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT gamma_templates_tenant_id_fkey
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT gamma_templates_format_check
    CHECK (format IN ('presentation', 'document')),
  CONSTRAINT gamma_templates_status_check
    CHECK (status IN ('active', 'archived'))
);

-- Backfill idempotency: one library entry per (tenant, Gamma File ID). The
-- one-shot backfill relies on INSERT ... ON CONFLICT DO NOTHING against this.
CREATE UNIQUE INDEX gamma_templates_tenant_gamma_id_uniq
  ON gamma_templates (tenant_id, gamma_template_id);

-- At most one default per tenant (partial unique over the default flag).
CREATE UNIQUE INDEX gamma_templates_one_default_per_tenant
  ON gamma_templates (tenant_id)
  WHERE is_default;

CREATE INDEX gamma_templates_tenant_id_idx ON gamma_templates (tenant_id);
CREATE INDEX gamma_templates_tenant_status_idx ON gamma_templates (tenant_id, status);

-- Tenant isolation — identical posture to the other tenant-scoped tables
-- (ENABLE + FORCE so even the table owner is policy-bound; rhud_app is
-- NOBYPASSRLS). Omitting GRANT → 42501 on the app role; omitting WITH CHECK →
-- INSERT/UPDATE by the app role fail.
ALTER TABLE gamma_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE gamma_templates FORCE ROW LEVEL SECURITY;

CREATE POLICY gamma_templates_isolation ON gamma_templates
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON gamma_templates TO rhud_app;

-- Per-opportunity selection of a library template. Nullable: existing
-- engagements get NULL (→ resolve to the tenant default, else freeform).
-- SET NULL on delete so archiving/removing a library entry re-resolves the
-- opportunity to the default rather than orphaning it.
ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS selected_gamma_template_id UUID;

ALTER TABLE engagements
  ADD CONSTRAINT engagements_selected_gamma_template_id_fkey
  FOREIGN KEY (selected_gamma_template_id)
  REFERENCES gamma_templates(id) ON DELETE SET NULL;

CREATE INDEX engagements_selected_gamma_template_id_idx
  ON engagements (selected_gamma_template_id);
