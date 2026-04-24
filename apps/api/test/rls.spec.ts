/**
 * Cross-tenant RLS isolation test — THE contract.
 *
 * What this asserts:
 *   1. When `withTenant(A)` is active, queries see tenant A rows only.
 *   2. When `withTenant(B)` is active, queries see tenant B rows only.
 *   3. Without any tenant set (app.tenant_id NULL), the `rhud_app` role sees
 *      zero rows — i.e., a bug that forgets to call withTenant results in
 *      empty reads, never cross-tenant reads.
 *   4. An INSERT attempting to write another tenant's tenant_id is rejected
 *      by the WITH CHECK clause of the RLS policy.
 *
 * These assertions run against a real Postgres (docker compose). This test
 * depends on the init migration being applied and the `rhud_app` role being
 * present (infra/postgres/init/01-extensions.sql).
 *
 * The test opens two connections:
 *   - `root` as the superuser (DATABASE_URL) for setup/teardown.
 *   - `app`  as the rhud_app role (APP_DATABASE_URL or derived) — NOBYPASSRLS.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';

const TENANT_A = '00000000-0000-0000-0000-00000000000a';
const TENANT_B = '00000000-0000-0000-0000-00000000000b';

function appDatabaseUrl(): string {
  // The app should connect as rhud_app (NOBYPASSRLS). If the caller didn't
  // set APP_DATABASE_URL, derive one by swapping user/pass in DATABASE_URL.
  const explicit = process.env.APP_DATABASE_URL;
  if (explicit) return explicit;
  const root = process.env.DATABASE_URL;
  if (!root) throw new Error('DATABASE_URL not set');
  const u = new URL(root);
  u.username = 'rhud_app';
  u.password = 'rhud_app';
  return u.toString();
}

describe('RLS tenant isolation', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set to run this test');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appClient = new PrismaService(); // uses DATABASE_URL by default
  // Override app client to use rhud_app role
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });
  const tenantDb = new TenantDb(appRlsClient as unknown as PrismaService);

  beforeAll(async () => {
    // Clean slate — these rows will be re-created.
    await root.$executeRaw`DELETE FROM users        WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$executeRaw`DELETE FROM tenants      WHERE id        IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;

    await root.tenant.create({ data: { id: TENANT_A, name: 'Tenant A' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Tenant B' } });

    await root.user.create({
      data: { tenantId: TENANT_A, email: 'a1@rls.test', role: 'admin' },
    });
    await root.user.create({
      data: { tenantId: TENANT_B, email: 'b1@rls.test', role: 'admin' },
    });
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM users        WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$executeRaw`DELETE FROM tenants      WHERE id        IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
    await appClient.$disconnect();
  });

  it('sees only tenant A rows inside withTenant(A)', async () => {
    const emails = await tenantDb.run(TENANT_A, async (db) => {
      const rows = await db.user.findMany({ select: { email: true } });
      return rows.map((r: { email: string }) => r.email);
    });
    expect(emails).toEqual(['a1@rls.test']);
  });

  it('sees only tenant B rows inside withTenant(B)', async () => {
    const emails = await tenantDb.run(TENANT_B, async (db) => {
      const rows = await db.user.findMany({ select: { email: true } });
      return rows.map((r: { email: string }) => r.email);
    });
    expect(emails).toEqual(['b1@rls.test']);
  });

  it('rejects queries when no tenant is set on the app role', async () => {
    // The RLS policy references current_setting('app.tenant_id', true)::uuid.
    // When the setting is unset it resolves to '' — casting to uuid raises
    // `invalid input syntax for type uuid`. This is the intended, LOUD
    // failure mode: a forgotten withTenant() fails at query time rather than
    // silently returning empty results. No cross-tenant rows leak either way.
    await expect(
      appRlsClient.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM users`,
    ).rejects.toThrow(/invalid input syntax for type uuid/);
  });

  it('rejects INSERTs that claim another tenant_id (WITH CHECK)', async () => {
    await expect(
      tenantDb.run(TENANT_A, async (db) => {
        // Attempt to write a user whose tenant_id is B while scoped as A.
        await db.$executeRaw`INSERT INTO users (tenant_id, email, role)
                             VALUES (${TENANT_B}::uuid, 'evil@rls.test', 'admin')`;
      }),
    ).rejects.toThrow();

    // And no such row leaked in.
    const rows = await root.$queryRaw<Array<{ email: string }>>`SELECT email FROM users WHERE email = 'evil@rls.test'`;
    expect(rows).toEqual([]);
  });
});
