/**
 * Sprint-4 — notifications dispatch + per-tenant routing.
 *
 * Asserts:
 *   1. `link_issued` fans out to sales_employee + sales_manager (defaults).
 *   2. `node_answered` is suppressed (default route is empty) so no email.
 *   3. A tenant override can disable notifications entirely.
 *   4. A tenant override can replace the route for a specific event.
 *   5. Recipients are resolved tenant-locally (no leak across tenants).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { ConsoleEmailTransport } from '../src/notifications/email.transport.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000c4';
const TENANT_B = '00000000-0000-0000-0000-0000000000d4';
const SE_A = '11111111-1111-1111-1111-111111111ca4';
const SM_A = '22222222-2222-2222-2222-222222222ca4';
const SE_B = '11111111-1111-1111-1111-111111111cb4';

function appUrl(): string {
  if (process.env.APP_DATABASE_URL) return process.env.APP_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL!);
  u.username = 'rhud_app';
  u.password = 'rhud_app';
  return u.toString();
}

describe('Notifications dispatch (sprint 4)', () => {
  const root = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
  const appClient = new PrismaClient({ datasources: { db: { url: appUrl() } } });
  const tenantDb = new TenantDb(appClient as unknown as AppPrismaService);
  const transport = new ConsoleEmailTransport();
  const svc = new NotificationsService(tenantDb, transport);

  let engagementA = '';

  beforeAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Notif A' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Notif B' } });
    await root.user.createMany({
      data: [
        { id: SE_A, tenantId: TENANT_A, email: 'sales-a@notif.test', role: 'sales_employee' },
        { id: SM_A, tenantId: TENANT_A, email: 'mgr-a@notif.test', role: 'sales_manager' },
        { id: SE_B, tenantId: TENANT_B, email: 'sales-b@notif.test', role: 'sales_employee' },
      ],
    });

    // Tenant A needs a published template for the engagement to FK into.
    const tmplA = await root.template.create({
      data: {
        tenantId: TENANT_A,
        serviceLine: 'X',
        name: 'X',
        version: 1,
        status: 'published',
      },
    });
    const eng = await root.engagement.create({
      data: {
        tenantId: TENANT_A,
        templateId: tmplA.id,
        templateVersion: 1,
        salesEmployeeId: SE_A,
        salesManagerId: SM_A,
        clientEmail: 'client@notif.test',
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

  beforeEach(() => {
    transport.clear();
  });

  it('link_issued fans out to sales_employee + sales_manager', async () => {
    const r = await svc.dispatch({
      tenantId: TENANT_A,
      engagementId: engagementA,
      eventType: 'link_issued',
      payload: { expiresAt: '2026-05-01T00:00:00Z' },
    });
    expect(r.sent).toBe(2);
    const recents = transport.getRecent();
    expect(new Set(recents.map((m) => m.to))).toEqual(
      new Set(['sales-a@notif.test', 'mgr-a@notif.test']),
    );
  });

  it('node_answered is suppressed by default (no emails)', async () => {
    const r = await svc.dispatch({
      tenantId: TENANT_A,
      engagementId: engagementA,
      eventType: 'node_answered',
      payload: { nodeId: 'n1' },
    });
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(transport.getRecent()).toEqual([]);
  });

  it('tenant config: disabled = true short-circuits all email', async () => {
    await root.tenant.update({
      where: { id: TENANT_A },
      data: { notificationConfig: { disabled: true } },
    });
    const r = await svc.dispatch({
      tenantId: TENANT_A,
      engagementId: engagementA,
      eventType: 'link_issued',
      payload: {},
    });
    expect(r.sent).toBe(0);
    expect(transport.getRecent()).toEqual([]);
    // Reset — NULL the JSONB via raw SQL (Prisma's typed `null` collides
    // with `JsonNull`; raw is the simplest path in tests).
    await root.$executeRaw`UPDATE tenants SET notification_config = NULL WHERE id = ${TENANT_A}::uuid`;
  });

  it('tenant config: per-event route override replaces default', async () => {
    await root.tenant.update({
      where: { id: TENANT_A },
      data: {
        notificationConfig: { routes: { link_issued: ['client'] } },
      },
    });
    const r = await svc.dispatch({
      tenantId: TENANT_A,
      engagementId: engagementA,
      eventType: 'link_issued',
      payload: {},
    });
    expect(r.sent).toBe(1);
    expect(transport.getRecent()[0]?.to).toBe('client@notif.test');
    await root.$executeRaw`UPDATE tenants SET notification_config = NULL WHERE id = ${TENANT_A}::uuid`;
  });

  it('cross-tenant: dispatch on tenant B engagement does not see tenant A users', async () => {
    // Tenant B has no engagement yet; using a fake id, the service should
    // skip (engagement not visible) without leaking anything.
    const r = await svc.dispatch({
      tenantId: TENANT_B,
      engagementId: '00000000-0000-0000-0000-00000000beef',
      eventType: 'link_issued',
      payload: {},
    });
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe(1);
    expect(transport.getRecent()).toEqual([]);
  });
});
