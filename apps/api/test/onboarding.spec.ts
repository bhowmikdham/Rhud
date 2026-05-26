/**
 * Signup clone-on-create — UnscopedDb.createTenantWithAdmin clones the
 * picked industry template's categories into the new tenant's id in the
 * same transaction. Verifies:
 *   - default (no slug passed) clones the Cybersecurity taxonomy
 *   - explicit 'blank' creates no categories
 *   - invalid slug rejects with BadRequest and leaves nothing behind
 */
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { SystemPrismaService } from '../src/db/prisma.service.js';
import { UnscopedDb } from '../src/db/unscoped-db.js';

function uniqueEmail(label: string): string {
  return `onboarding-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

describe('Signup clone-on-create', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  // UnscopedDb only needs $transaction; the constructor accepts
  // SystemPrismaService but functionally any superuser PrismaClient works.
  const unscoped = new UnscopedDb(root as unknown as SystemPrismaService);

  // Track tenant ids created across cases so afterEach can prune them.
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    // Sanity check: the two seed templates we ship at launch must exist.
    const slugs = (await root.industryTemplate.findMany({ select: { slug: true } }))
      .map((t) => t.slug);
    expect(slugs).toContain('cybersecurity');
    expect(slugs).toContain('blank');
  });

  afterEach(async () => {
    if (createdTenantIds.length === 0) return;
    await root.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id IN (${createdTenantIds.map((id) => `'${id}'::uuid`).join(',')})`,
    );
    createdTenantIds.length = 0;
  });

  afterAll(async () => {
    await root.$disconnect();
  });

  it("defaults to 'cybersecurity' and clones the 16-row taxonomy", async () => {
    const { tenantId } = await unscoped.createTenantWithAdmin({
      tenantName: 'Default-template signup',
      email: uniqueEmail('default'),
      passwordHash: 'fake-hash',
      emailVerificationTokenHash: 'fake-token-hash',
      emailVerificationExpiresAt: new Date(Date.now() + 3600_000),
    });
    createdTenantIds.push(tenantId);

    const tenant = await root.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.industryTemplateSlug).toBe('cybersecurity');

    const cats = await root.opportunityCategory.findMany({ where: { tenantId } });
    // Cybersecurity ships 4 top-level + 12 subcategories = 16.
    expect(cats).toHaveLength(16);
    expect(cats.find((c) => c.slug === 'security_testing' && c.parentSlug === null)).toBeDefined();
    expect(cats.find((c) => c.slug === 'vapt' && c.parentSlug === 'security_testing')).toBeDefined();
  });

  it("'blank' clones zero categories", async () => {
    const { tenantId } = await unscoped.createTenantWithAdmin({
      tenantName: 'Blank-template signup',
      email: uniqueEmail('blank'),
      industryTemplateSlug: 'blank',
      passwordHash: 'fake-hash',
      emailVerificationTokenHash: 'fake-token-hash',
      emailVerificationExpiresAt: new Date(Date.now() + 3600_000),
    });
    createdTenantIds.push(tenantId);

    const tenant = await root.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.industryTemplateSlug).toBe('blank');

    const cats = await root.opportunityCategory.findMany({ where: { tenantId } });
    expect(cats).toHaveLength(0);
  });

  it('rejects an unknown template slug and rolls back the tenant insert', async () => {
    const email = uniqueEmail('badslug');
    await expect(
      unscoped.createTenantWithAdmin({
        tenantName: 'Should not exist',
        email,
        industryTemplateSlug: 'definitely_not_a_real_template',
        passwordHash: 'fake-hash',
        emailVerificationTokenHash: 'fake-token-hash',
        emailVerificationExpiresAt: new Date(Date.now() + 3600_000),
      }),
    ).rejects.toThrow(/unknown_industry_template/);

    // No tenant with that name should exist — tx rolled back.
    const orphan = await root.tenant.findFirst({ where: { name: 'Should not exist' } });
    expect(orphan).toBeNull();
    // No user with that email either.
    const orphanUser = await root.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE email = ${email}::citext LIMIT 1`;
    expect(orphanUser).toHaveLength(0);
  });
});
