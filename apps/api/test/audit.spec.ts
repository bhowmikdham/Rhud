/**
 * Sprint-4 — audit hash chain.
 *
 * Asserts:
 *   1. Building a link over fresh events succeeds and persists a row.
 *   2. Building twice with no new events returns null (no-op).
 *   3. Building → emitting → building grows the chain by one link.
 *   4. verify() returns ok=true for an untampered chain.
 *   5. verify() detects tampering: if a thread_event is mutated outside
 *      the role's grants (which we simulate by superuser surgery), the
 *      next verify call surfaces the divergence.
 *   6. Cross-tenant: tenant B's chain is invisible from tenant A's scope.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { AuditService } from '../src/audit/audit.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000e4';
const TENANT_B = '00000000-0000-0000-0000-0000000000f4';
const USER_A = '11111111-1111-1111-1111-1111111111e4';

function appUrl(): string {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL!);
  u.username = 'rhud_app';
  u.password = 'rhud_app';
  return u.toString();
}

describe('Audit hash chain (sprint 4)', () => {
  const root = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  const appClient = new PrismaClient({ datasources: { db: { url: appUrl() } } });
  const tenantDb = new TenantDb(appClient as unknown as AppPrismaService);
  const audit = new AuditService(tenantDb);

  let engagementA = '';

  beforeAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Audit A' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Audit B' } });
    await root.user.create({
      data: { id: USER_A, tenantId: TENANT_A, email: 'a@audit.test', role: 'sales_employee' },
    });
    const tmpl = await root.template.create({
      data: { tenantId: TENANT_A, serviceLine: 'a', name: 'a', version: 1, status: 'published' },
    });
    const eng = await root.engagement.create({
      data: {
        tenantId: TENANT_A,
        templateId: tmpl.id,
        templateVersion: 1,
        salesEmployeeId: USER_A,
        clientEmail: 'c@audit.test',
        status: 'issued',
      },
    });
    engagementA = eng.id;
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appClient.$disconnect();
  });

  beforeEach(async () => {
    // Fresh chain per test.
    await root.$executeRaw`DELETE FROM audit_chain_links WHERE tenant_id = ${TENANT_A}::uuid`;
    await root.$executeRaw`DELETE FROM thread_events    WHERE tenant_id = ${TENANT_A}::uuid`;
  });

  async function emit(eventType: string): Promise<void> {
    await tenantDb.run(TENANT_A, async (db) => {
      await db.threadEvent.create({
        data: {
          tenantId: TENANT_A,
          engagementId: engagementA,
          eventType,
          actorType: 'user',
          actorId: USER_A,
          payload: { note: `event ${eventType}` },
        },
      });
    });
    // Postgres TIMESTAMPTZ has microsecond precision but tests can run faster
    // than that; pad slightly so created_at is monotonic.
    await new Promise((r) => setTimeout(r, 5));
  }

  it('build over fresh events writes a link', async () => {
    await emit('link_issued');
    await emit('link_opened');
    await emit('node_answered');

    const r = await audit.build(TENANT_A);
    expect(r).not.toBeNull();
    expect(r!.sequence).toBe(1);
    expect(r!.eventCount).toBe(3);
    expect(r!.rootHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('build with no new events returns null', async () => {
    await emit('link_issued');
    await audit.build(TENANT_A);
    const r2 = await audit.build(TENANT_A);
    expect(r2).toBeNull();
  });

  it('build → new events → build grows the chain', async () => {
    await emit('link_issued');
    const r1 = await audit.build(TENANT_A);
    expect(r1!.sequence).toBe(1);
    await emit('link_opened');
    const r2 = await audit.build(TENANT_A);
    expect(r2!.sequence).toBe(2);
    expect(r2!.eventCount).toBe(1);
  });

  it('verify returns ok for an untampered chain', async () => {
    await emit('link_issued');
    await emit('scope_submitted');
    await audit.build(TENANT_A);

    const v = await audit.verify(TENANT_A);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.links).toBe(1);
  });

  it('verify detects tampering when a sealed event is mutated', async () => {
    await emit('link_issued');
    await emit('scope_submitted');
    await audit.build(TENANT_A);

    // Surgical tamper as superuser — bypassing the rhud_app no-update grant.
    await root.$executeRaw`UPDATE thread_events
                           SET payload = '{"note":"tampered"}'::jsonb
                           WHERE tenant_id = ${TENANT_A}::uuid
                           AND   event_type = 'scope_submitted'`;

    const v = await audit.verify(TENANT_A);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.failedAtSequence).toBe(1);
      // expected !== actual hash
      expect(v.expected).not.toBe(v.actual);
    }
  });

  it('cross-tenant isolation holds for chain links', async () => {
    await emit('link_issued');
    await audit.build(TENANT_A);

    // Tenant B has no events; verify and build are both no-ops there.
    const vB = await audit.verify(TENANT_B);
    expect(vB.ok).toBe(true);
    if (vB.ok) expect(vB.links).toBe(0);

    const bBuild = await audit.build(TENANT_B);
    expect(bBuild).toBeNull();
  });
});
