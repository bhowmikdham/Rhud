-- Industry templates — generalise the scope-classification taxonomy
-- beyond the cyber-specific seed shipped in Phase B.
--
-- Today's model: 16 cyber categories live as `tenant_id IS NULL` system
-- rows shared across all tenants; tenants can add but not edit them, and
-- the LLM preamble is hardcoded to "cybersecurity sales classifier".
--
-- New model: each tenant owns its full taxonomy as `tenant_id = self`
-- rows. At signup the tenant picks an "industry template" and we clone
-- that template's categories into their tenant_id. Existing tenants are
-- backfilled with the Cybersecurity template (preserving today's UX).
-- The `tenant_id IS NULL` system rows are kept untouched in this
-- migration — a follow-up release drops them once we've verified every
-- engagement.category_slug resolves to a live tenant-owned row.

-- ── 1. industry_templates: global config of available verticals ────
-- Not tenant-scoped (no RLS). App role gets SELECT only; INSERT/UPDATE
-- is reserved to the migration superuser.

CREATE TABLE industry_templates (
  slug                text        PRIMARY KEY,
  name                text        NOT NULL,
  -- Front of the LLM system prompt, e.g. "You are a cybersecurity sales
  -- classifier." Tenant-editable later (deferred).
  classifier_preamble text        NOT NULL,
  -- Slug the classifier falls back to when nothing matches. Nullable for
  -- the "blank" template (tenant defines own world; no canonical fallback).
  fallback_slug       text,
  version             int         NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE industry_template_categories (
  template_slug text NOT NULL REFERENCES industry_templates(slug) ON DELETE CASCADE,
  slug          text NOT NULL,
  name          text NOT NULL,
  parent_slug   text,
  position      int  NOT NULL DEFAULT 0,
  PRIMARY KEY (template_slug, slug)
);

CREATE INDEX industry_template_categories_parent_idx
  ON industry_template_categories (template_slug, parent_slug);

-- Global config tables: SELECT for the app role, no DML. No RLS.
GRANT SELECT ON industry_templates           TO rhud_app;
GRANT SELECT ON industry_template_categories TO rhud_app;

-- ── 2. tenants.industry_template_slug ─────────────────────────────
-- FK added after seeding so the default value ('cybersecurity') resolves.

ALTER TABLE tenants
  ADD COLUMN industry_template_slug text NOT NULL DEFAULT 'cybersecurity';

-- ── 3. opportunity_categories.archived_at (soft-delete) ───────────
-- Existing partial unique index `opportunity_categories_tenant_slug_uniq`
-- treats every (tenant_id, slug) pair as unique forever — which would
-- block re-creating an archived slug or running "Reset taxonomy" when
-- the new template re-introduces slugs the tenant already archived.
-- We swap the index to exclude archived rows so soft-archive is truly
-- soft and re-creation is legal.

ALTER TABLE opportunity_categories
  ADD COLUMN archived_at timestamptz;

DROP INDEX opportunity_categories_tenant_slug_uniq;
CREATE UNIQUE INDEX opportunity_categories_tenant_slug_uniq
  ON opportunity_categories (tenant_id, slug)
  WHERE tenant_id IS NOT NULL AND archived_at IS NULL;

-- Hot lookup index for the categories tab's "active categories" query.
CREATE INDEX opportunity_categories_active_idx
  ON opportunity_categories (tenant_id)
  WHERE archived_at IS NULL;

-- ── 4. Seed templates ─────────────────────────────────────────────
-- Cybersecurity preserves the existing seed verbatim — that's what
-- existing tenants get backfilled with, so today's behavior is unchanged.
-- Blank is name-only (no categories); tenants who pick it define their
-- own world from scratch.

INSERT INTO industry_templates (slug, name, classifier_preamble, fallback_slug, version) VALUES
  ('cybersecurity', 'Cybersecurity',
   'You are a cybersecurity sales classifier.',
   'other_cybersecurity', 1),
  ('blank', 'Blank — define your own',
   'You are an opportunity classifier.',
   NULL, 1);

-- Cybersecurity taxonomy (copy of the 16-row Phase B seed in
-- 20260617000000_phase_b_classification_routing/migration.sql).
INSERT INTO industry_template_categories (template_slug, slug, name, parent_slug, position) VALUES
  -- Top-level
  ('cybersecurity', 'security_testing',         'Security Testing',          NULL,                1),
  ('cybersecurity', 'grc',                       'GRC',                       NULL,                2),
  ('cybersecurity', 'managed_security_services', 'Managed Security Services', NULL,                3),
  ('cybersecurity', 'other_cybersecurity',       'Other Cybersecurity',       NULL,                4),
  -- Security Testing → subcategories
  ('cybersecurity', 'vapt',                      'VAPT',                      'security_testing',  1),
  ('cybersecurity', 'red_team',                  'Red Teaming',               'security_testing',  2),
  ('cybersecurity', 'api_testing',               'API Testing',               'security_testing',  3),
  ('cybersecurity', 'mobile_app_testing',        'Mobile App Testing',        'security_testing',  4),
  ('cybersecurity', 'cloud_security',            'Cloud Security',            'security_testing',  5),
  ('cybersecurity', 'security_testing_other',    'Other',                     'security_testing',  6),
  -- GRC → subcategories
  ('cybersecurity', 'iso_27001',                 'ISO 27001',                 'grc',               1),
  ('cybersecurity', 'dpdp',                      'DPDP',                      'grc',               2),
  ('cybersecurity', 'pci_dss',                   'PCI DSS',                   'grc',               3),
  ('cybersecurity', 'rbi_sebi',                  'RBI/SEBI',                  'grc',               4),
  ('cybersecurity', 'policy_review',             'Policy Review',             'grc',               5),
  ('cybersecurity', 'grc_other',                 'Other',                     'grc',               6);

-- Blank template intentionally seeds no categories.

-- Add FK now that the cybersecurity row exists for the default.
-- ON UPDATE CASCADE lets us rename a template slug later without a
-- multi-step dance; ON DELETE RESTRICT keeps a template with active
-- tenants from being wiped accidentally (no ON DELETE clause = RESTRICT).
ALTER TABLE tenants
  ADD CONSTRAINT tenants_industry_template_slug_fkey
  FOREIGN KEY (industry_template_slug)
  REFERENCES industry_templates(slug)
  ON UPDATE CASCADE;

-- ── 5. Backfill existing tenants ──────────────────────────────────
-- Clone the Cybersecurity template's categories into each existing
-- tenant. `ON CONFLICT DO NOTHING` makes this idempotent: a partially-
-- applied migration that re-runs won't double-insert. Tenants who later
-- add a row with the same slug as the template would lose the template
-- copy here — but at migration time none exist (we just added the
-- column with a default), so the result is deterministic.

INSERT INTO opportunity_categories (tenant_id, slug, name, parent_slug, position)
SELECT t.id, c.slug, c.name, c.parent_slug, c.position
FROM tenants t
CROSS JOIN industry_template_categories c
WHERE c.template_slug = t.industry_template_slug
ON CONFLICT DO NOTHING;
