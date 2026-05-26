/**
 * CategoriesService — tenant CRUD + archive cascade + RLS isolation.
 *
 * Mirrors templates.spec.ts: real Postgres connection through the
 * `rhud_app` role (NOBYPASSRLS) so RLS policies actually enforce.
 * Two test tenants A + B verify that mutations under one are invisible
 * from the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { CategoriesService } from '../src/classification/categories.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000ca';
const TENANT_B = '00000000-0000-0000-0000-0000000000cb';
const REVIEWER_A = '00000000-0000-0000-0000-0000000000c1';

function appDatabaseUrl(): string {
  const explicit = process.env.APP_DATABASE_URL;
  if (explicit) return explicit;
  const root = process.env.DATABASE_URL;
  if (!root) throw new Error('DATABASE_URL not set');
  const u = new URL(root);
  u.username = 'rhud_app';
  u.password = 'rhud_app';
  return u.toString();
}

describe('CategoriesService', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });
  const tenantDb = new TenantDb(appRlsClient as unknown as AppPrismaService);
  const svc = new CategoriesService(tenantDb);

  beforeAll(async () => {
    // Clean and recreate the test tenants. Cascading delete clears
    // categories + routing rules + users.
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({
      data: { id: TENANT_A, name: 'Tenant A (categories test)' },
    });
    await root.tenant.create({
      data: { id: TENANT_B, name: 'Tenant B (categories test)' },
    });
    // Insert a stub reviewer in A so we can test the routing-rule
    // cascade-on-archive.
    await root.user.create({
      data: {
        id: REVIEWER_A,
        tenantId: TENANT_A,
        email: 'reviewer-a-categories@test.local',
        role: 'tech_team',
        passwordHash: null,
        emailVerified: true,
      },
    });
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe tenant-owned categories + routing rules between tests so
    // they start each case from the post-signup baseline (Cybersecurity
    // taxonomy is auto-cloned by the migration backfill — leave it).
    await root.$executeRaw`
      DELETE FROM opportunity_routing_rules
       WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    // Re-clone fresh taxonomy by re-running the backfill SQL.
    await root.$executeRaw`
      DELETE FROM opportunity_categories
       WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$executeRaw`
      INSERT INTO opportunity_categories (tenant_id, slug, name, parent_slug, position)
      SELECT t.id, c.slug, c.name, c.parent_slug, c.position
        FROM tenants t
       CROSS JOIN industry_template_categories c
       WHERE c.template_slug = t.industry_template_slug
         AND t.id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
  });

  it('create + getTree round-trips a new category for the right tenant only', async () => {
    const created = await svc.create(TENANT_A, {
      slug: 'custom_topic',
      name: 'Custom topic',
      position: 99,
    });
    expect(created.slug).toBe('custom_topic');
    expect(created.tenantId).toBe(TENANT_A);

    const aTree = await svc.getTree(TENANT_A);
    expect(aTree.topLevel.find((c) => c.slug === 'custom_topic')).toBeDefined();

    const bTree = await svc.getTree(TENANT_B);
    expect(bTree.topLevel.find((c) => c.slug === 'custom_topic')).toBeUndefined();
  });

  it('rejects bad slug format', async () => {
    await expect(
      svc.create(TENANT_A, { slug: 'Bad-Slug', name: 'x' }),
    ).rejects.toThrow(/invalid_slug_format/);
    await expect(
      svc.create(TENANT_A, { slug: '1leadingdigit', name: 'x' }),
    ).rejects.toThrow(/invalid_slug_format/);
  });

  it('rejects duplicate slug within the same tenant (active rows)', async () => {
    await svc.create(TENANT_A, { slug: 'dup', name: 'first' });
    await expect(
      svc.create(TENANT_A, { slug: 'dup', name: 'second' }),
    ).rejects.toThrow(/slug_already_exists/);
  });

  it('allows re-creating a slug after it has been archived', async () => {
    await svc.create(TENANT_A, { slug: 'recyclable', name: 'first' });
    await svc.archive(TENANT_A, 'recyclable');
    // Re-create with the same slug should now succeed.
    const recreated = await svc.create(TENANT_A, {
      slug: 'recyclable',
      name: 'second',
    });
    expect(recreated.name).toBe('second');
  });

  it('update renames + reorders', async () => {
    await svc.create(TENANT_A, { slug: 'orig', name: 'Original' });
    const renamed = await svc.update(TENANT_A, 'orig', { name: 'Renamed', position: 10 });
    expect(renamed.name).toBe('Renamed');
    expect(renamed.position).toBe(10);
  });

  it('update re-parents a top-level to be a child of another top-level', async () => {
    await svc.create(TENANT_A, { slug: 'parent_a', name: 'Parent A' });
    await svc.create(TENANT_A, { slug: 'orphan', name: 'Orphan' });
    const moved = await svc.update(TENANT_A, 'orphan', { parentSlug: 'parent_a' });
    expect(moved.parentSlug).toBe('parent_a');
  });

  it('refuses to re-parent a top-level that itself has children', async () => {
    await svc.create(TENANT_A, { slug: 'p1', name: 'P1' });
    await svc.create(TENANT_A, { slug: 'p2', name: 'P2' });
    await svc.create(TENANT_A, { slug: 'c1', name: 'C1', parentSlug: 'p1' });
    await expect(
      svc.update(TENANT_A, 'p1', { parentSlug: 'p2' }),
    ).rejects.toThrow(/cannot_demote_category_with_children/);
  });

  it('archive soft-deletes + cascades children + hard-deletes routing rules', async () => {
    await svc.create(TENANT_A, { slug: 'doomed_top', name: 'Doomed' });
    await svc.create(TENANT_A, {
      slug: 'doomed_child',
      name: 'Doomed Child',
      parentSlug: 'doomed_top',
    });
    // Add a routing rule pointing at the top + the child.
    await tenantDb.run(TENANT_A, async (db) => {
      await db.opportunityRoutingRule.create({
        data: {
          tenantId: TENANT_A,
          categorySlug: 'doomed_top',
          reviewerUserId: REVIEWER_A,
        },
      });
      await db.opportunityRoutingRule.create({
        data: {
          tenantId: TENANT_A,
          categorySlug: 'doomed_child',
          reviewerUserId: REVIEWER_A,
        },
      });
    });

    await svc.archive(TENANT_A, 'doomed_top');

    // Both rows should be archived (not visible in the active tree).
    const tree = await svc.getTree(TENANT_A);
    expect(tree.topLevel.find((c) => c.slug === 'doomed_top')).toBeUndefined();
    expect(
      (tree.childrenByParent['doomed_top'] ?? []).find((c) => c.slug === 'doomed_child'),
    ).toBeUndefined();

    // Routing rules are hard-deleted.
    const rules = await tenantDb.run(TENANT_A, async (db) =>
      db.opportunityRoutingRule.findMany({
        where: { tenantId: TENANT_A, categorySlug: { in: ['doomed_top', 'doomed_child'] } },
      }),
    );
    expect(rules).toHaveLength(0);
  });

  it('bulkReorder applies positions in one shot', async () => {
    await svc.create(TENANT_A, { slug: 'b1', name: 'B1', position: 1 });
    await svc.create(TENANT_A, { slug: 'b2', name: 'B2', position: 2 });
    await svc.bulkReorder(TENANT_A, {
      items: [
        { slug: 'b1', position: 20 },
        { slug: 'b2', position: 10 },
      ],
    });
    const tree = await svc.getTree(TENANT_A);
    const b1 = tree.topLevel.find((c) => c.slug === 'b1');
    const b2 = tree.topLevel.find((c) => c.slug === 'b2');
    expect(b1?.position).toBe(20);
    expect(b2?.position).toBe(10);
  });

  it('resetFromTemplate clones the new template and wipes routing rules', async () => {
    // Seed a custom row + a routing rule under A first.
    await svc.create(TENANT_A, { slug: 'will_be_gone', name: 'Will be gone' });
    await tenantDb.run(TENANT_A, async (db) => {
      await db.opportunityRoutingRule.create({
        data: {
          tenantId: TENANT_A,
          categorySlug: 'will_be_gone',
          reviewerUserId: REVIEWER_A,
        },
      });
    });

    await svc.resetFromTemplate(TENANT_A, 'blank');

    const tree = await svc.getTree(TENANT_A);
    // Blank template has no categories.
    expect(tree.topLevel).toHaveLength(0);

    const rules = await tenantDb.run(TENANT_A, async (db) =>
      db.opportunityRoutingRule.findMany({ where: { tenantId: TENANT_A } }),
    );
    expect(rules).toHaveLength(0);

    // Switch back to cybersecurity → categories repopulate.
    await svc.resetFromTemplate(TENANT_A, 'cybersecurity');
    const back = await svc.getTree(TENANT_A);
    expect(back.topLevel.find((c) => c.slug === 'security_testing')).toBeDefined();
    expect(back.childrenByParent['security_testing']?.find((c) => c.slug === 'vapt')).toBeDefined();
  });

  it('resetFromTemplate 404s for an unknown template slug', async () => {
    await expect(
      svc.resetFromTemplate(TENANT_A, 'no_such_template'),
    ).rejects.toThrow(/unknown_industry_template/);
  });
});
