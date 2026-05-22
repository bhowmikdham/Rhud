-- Phase B — opportunity classification taxonomy + tenant routing rules.
--
-- Implements PM workflow stages 2 (AI scope classification) + 3
-- (technical review routing). Seeds the PM-defined taxonomy as
-- system rows visible to every tenant.

-- ── 1. Categories table — system + per-tenant ─────────────────────
-- System categories (tenant_id IS NULL) are seeded once at migration
-- time and visible to every tenant. A tenant can add its own custom
-- categories with their own tenant_id.

CREATE TABLE opportunity_categories (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        REFERENCES tenants(id) ON DELETE CASCADE,
  -- Stable identifier ('security_testing', 'vapt', 'grc', 'iso_27001', ...).
  -- We key on slug rather than UUID so seeds + LLM classification
  -- output don't have to know the row id.
  slug        text        NOT NULL,
  -- Display name ('Security Testing', 'VAPT', 'GRC', ...).
  name        text        NOT NULL,
  -- For a subcategory, the parent's slug. NULL for top-level categories.
  parent_slug text,
  position    int         NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Slug uniqueness:
--   - System (tenant_id IS NULL) → globally unique slug
--   - Tenant rows → unique per (tenant_id, slug)
-- These are partial unique indexes so the two namespaces don't collide.
CREATE UNIQUE INDEX opportunity_categories_system_slug_uniq
  ON opportunity_categories (slug) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX opportunity_categories_tenant_slug_uniq
  ON opportunity_categories (tenant_id, slug) WHERE tenant_id IS NOT NULL;
CREATE INDEX opportunity_categories_parent_idx
  ON opportunity_categories (parent_slug);

ALTER TABLE opportunity_categories ENABLE ROW LEVEL SECURITY;

-- RLS: visible to all tenants when tenant_id IS NULL (system rows);
-- writable only by the tenant whose id matches. Combined with the
-- migration-level INSERT (which runs as the superuser), system rows
-- can be seeded but not modified by application code.
CREATE POLICY opportunity_categories_isolation ON opportunity_categories
  FOR ALL
  USING (
    tenant_id IS NULL
    OR tenant_id = current_setting('app.tenant_id', true)::uuid
  )
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_categories TO rhud_app;

-- ── 2. Routing rules — per-tenant ─────────────────────────────────
-- (tenant, category) → reviewer user. When a submitted engagement is
-- classified, the routing service looks up the rule and assigns
-- engagement.assigned_reviewer_id.

CREATE TABLE opportunity_routing_rules (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- 'security_testing', 'grc', 'managed_security_services', etc.
  -- Matches opportunity_categories.slug (system or tenant-defined).
  category_slug    text        NOT NULL,
  reviewer_user_id uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- When multiple users are listed for the same category, position is a
  -- preference order (lower number wins). For MVP we pick the first
  -- match; future logic can round-robin or load-balance.
  position         int         NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX opportunity_routing_rules_uniq
  ON opportunity_routing_rules (tenant_id, category_slug, reviewer_user_id);
CREATE INDEX opportunity_routing_rules_lookup_idx
  ON opportunity_routing_rules (tenant_id, category_slug, position);

ALTER TABLE opportunity_routing_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY opportunity_routing_rules_isolation ON opportunity_routing_rules
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_routing_rules TO rhud_app;

-- ── 3. Engagement classification + reviewer-assignment columns ──

ALTER TABLE engagements
  ADD COLUMN category_slug         text,
  ADD COLUMN sub_category_slug     text,
  -- 'llm' | 'manual'
  ADD COLUMN classified_by         text,
  ADD COLUMN classified_at         timestamptz,
  ADD COLUMN assigned_reviewer_id  uuid REFERENCES users(id) ON DELETE SET NULL;

-- Hot index for the manager dashboard "what's on my desk" query.
CREATE INDEX engagements_assigned_reviewer_idx
  ON engagements (assigned_reviewer_id)
  WHERE assigned_reviewer_id IS NOT NULL;

-- ── 4. Thread event whitelist — classification + routing events ──

ALTER TABLE thread_events DROP CONSTRAINT IF EXISTS thread_events_event_type_check;
ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'file_extracted','loop_iteration_removed','mapper_fallback_heuristic',
      'scope_submitted','price_predicted','price_tech_adjusted',
      'approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved',
      'site_enumerated','site_enumeration_failed',
      'ticket_opened','ticket_status_changed','ticket_resolved',
      'follow_up_scheduled','follow_up_completed',
      'summary_generated',
      'scope_returned_to_sales','clarification_requested','scope_escalated',
      'scope_assumptions_updated','scope_exclusions_updated',
      'quote_line_item_added','quote_line_item_removed',
      -- Phase B additions:
      --   engagement_classified: first classification (LLM or manual)
      --   engagement_reclassified: category changed after initial set
      --   reviewer_assigned: auto-assigned by the routing service
      --   reviewer_reassigned: manual reassignment by admin/manager
      'engagement_classified',
      'engagement_reclassified',
      'reviewer_assigned',
      'reviewer_reassigned'
    ));

-- ── 5. Seed PM taxonomy as system categories (tenant_id NULL) ────

INSERT INTO opportunity_categories (tenant_id, slug, name, parent_slug, position) VALUES
  -- Top-level
  (NULL, 'security_testing',            'Security Testing',           NULL,                1),
  (NULL, 'grc',                          'GRC',                        NULL,                2),
  (NULL, 'managed_security_services',    'Managed Security Services',  NULL,                3),
  (NULL, 'other_cybersecurity',          'Other Cybersecurity',        NULL,                4),
  -- Security Testing → subcategories
  (NULL, 'vapt',                         'VAPT',                       'security_testing',  1),
  (NULL, 'red_team',                     'Red Teaming',                'security_testing',  2),
  (NULL, 'api_testing',                  'API Testing',                'security_testing',  3),
  (NULL, 'mobile_app_testing',           'Mobile App Testing',         'security_testing',  4),
  (NULL, 'cloud_security',               'Cloud Security',             'security_testing',  5),
  (NULL, 'security_testing_other',       'Other',                      'security_testing',  6),
  -- GRC → subcategories
  (NULL, 'iso_27001',                    'ISO 27001',                  'grc',               1),
  (NULL, 'dpdp',                         'DPDP',                       'grc',               2),
  (NULL, 'pci_dss',                      'PCI DSS',                    'grc',               3),
  (NULL, 'rbi_sebi',                     'RBI/SEBI',                   'grc',               4),
  (NULL, 'policy_review',                'Policy Review',              'grc',               5),
  (NULL, 'grc_other',                    'Other',                      'grc',               6);
