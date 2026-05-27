-- Phase 4 of the industry-template generalization: drop the legacy
-- `tenant_id IS NULL` "system row" pattern from opportunity_categories.
--
-- Background: the original Phase B taxonomy was seeded as system rows
-- visible cross-tenant via an RLS policy that allowed `tenant_id IS NULL
-- OR tenant_id = current_tenant`. Phase 1 of the industry-template work
-- cloned those rows into per-tenant copies and switched reads to filter
-- `where: { tenantId, archivedAt: null }`, making the system rows
-- inert. This migration now removes the inert rows + the supporting
-- infrastructure (partial index, RLS branch, nullable column) so
-- future schema readers don't have to puzzle over a dead concept.
--
-- Audit before running in prod (must return zero):
--   SELECT DISTINCT e.tenant_id, e.category_slug
--     FROM engagements e
--    WHERE e.category_slug IS NOT NULL
--      AND NOT EXISTS (
--        SELECT 1 FROM opportunity_categories c
--         WHERE c.tenant_id = e.tenant_id
--           AND c.slug = e.category_slug
--           AND c.archived_at IS NULL);

-- ── 1. Delete the inert system rows ──────────────────────────────
-- These have been invisible to the application since Phase 1 of the
-- industry-template work. Safe to delete unconditionally.

DELETE FROM opportunity_categories WHERE tenant_id IS NULL;

-- ── 2. Drop the system-row unique index ──────────────────────────
-- Targets `WHERE tenant_id IS NULL` rows that no longer exist.

DROP INDEX IF EXISTS opportunity_categories_system_slug_uniq;

-- ── 3. Simplify the tenant-slug unique index ─────────────────────
-- Previously: WHERE tenant_id IS NOT NULL AND archived_at IS NULL.
-- After NOT NULL on tenant_id, the first clause is redundant.

DROP INDEX IF EXISTS opportunity_categories_tenant_slug_uniq;
CREATE UNIQUE INDEX opportunity_categories_tenant_slug_uniq
  ON opportunity_categories (tenant_id, slug)
  WHERE archived_at IS NULL;

-- ── 4. NOT NULL the tenant_id column ─────────────────────────────
-- All remaining rows are tenant-owned, so this never fails. Locks in
-- the invariant at the DB level — even a bad raw INSERT can't land
-- a null going forward.

ALTER TABLE opportunity_categories
  ALTER COLUMN tenant_id SET NOT NULL;

-- ── 5. Tighten the RLS policy ────────────────────────────────────
-- Drop the `tenant_id IS NULL OR …` branch. Defense in depth: even
-- if a future bug somehow produced a null tenant_id (it can't, per
-- step 4), the policy would no longer surface it cross-tenant.

DROP POLICY IF EXISTS opportunity_categories_isolation ON opportunity_categories;
CREATE POLICY opportunity_categories_isolation ON opportunity_categories
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
