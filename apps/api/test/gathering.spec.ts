/**
 * Sprint-3 integration test: end-to-end gathering flow + tenant isolation.
 *
 * Drives EngagementsService and GatheringService against a real Postgres
 * connecting as `rhud_app` (NOBYPASSRLS). Asserts:
 *   1. Issuing a link emits a `link_issued` thread event atomically.
 *   2. The plaintext token (returned exactly once) resolves correctly.
 *   3. Walking the seeded tree records answers + node_answered events.
 *   4. Submit transitions status → submitted, revokes the token.
 *   5. Cross-tenant: tenant B cannot see tenant A's engagements / thread.
 *   6. A revoked or wrong token returns 401 without leaking which.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService, SystemPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { UnscopedDb } from '../src/db/unscoped-db.js';
import { ThreadService } from '../src/thread/thread.service.js';
import { S3Service } from '../src/storage/s3.service.js';
import { EngagementsService } from '../src/engagements/engagements.service.js';
import { GatheringService } from '../src/gathering/gathering.service.js';
import { ConsoleEmailTransport } from '../src/notifications/email.transport.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000a3';
const TENANT_B = '00000000-0000-0000-0000-0000000000b3';
// Reuse a fixed user id per tenant so we don't need extra fixtures.
const USER_A = '11111111-1111-1111-1111-1111111111a3';
const USER_B = '11111111-1111-1111-1111-1111111111b3';

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

const REQ_CTX = { ip: '127.0.0.1', userAgent: 'vitest', acceptLanguage: 'en' };

describe('Gathering / engagement flow (sprint 3)', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });

  // The system role is used by UnscopedDb (for token resolution lookups).
  const systemClient = new PrismaClient({ datasources: { db: { url: rootUrl } } });

  const tenantDb = new TenantDb(appRlsClient as unknown as AppPrismaService);
  const unscoped = new UnscopedDb(systemClient as unknown as SystemPrismaService);
  const emailTransport = new ConsoleEmailTransport();
  const notifications = new NotificationsService(tenantDb, emailTransport);
  const thread = new ThreadService(tenantDb, notifications);
  const s3 = new S3Service();
  const engagementsSvc = new EngagementsService(tenantDb, thread);
  const gatheringSvc = new GatheringService(unscoped, tenantDb, thread, s3);

  // Seeded template ids per tenant (4 nodes A→B→C→END for clarity).
  const TMPL_A = '99999999-9999-9999-9999-9999999999a3';
  const TMPL_B = '99999999-9999-9999-9999-9999999999b3';
  const NODE_A = (tenant: 'a' | 'b', n: number) =>
    `aaaaaaaa-aaaa-aaaa-aaaa-${tenant === 'a' ? 'aaaa' : 'bbbb'}${n.toString().padStart(8, '0')}`;

  beforeAll(async () => {
    // Hard reset any prior fixture state.
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Tenant A (gather)' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Tenant B (gather)' } });
    await root.user.create({
      data: { id: USER_A, tenantId: TENANT_A, email: 'sales-a@gather.test', role: 'sales_employee' },
    });
    await root.user.create({
      data: { id: USER_B, tenantId: TENANT_B, email: 'sales-b@gather.test', role: 'sales_employee' },
    });

    const seedPairs: Array<{ tenantId: string; tmplId: string; t: 'a' | 'b' }> = [
      { tenantId: TENANT_A, tmplId: TMPL_A, t: 'a' },
      { tenantId: TENANT_B, tmplId: TMPL_B, t: 'b' },
    ];
    for (const { tenantId, tmplId, t } of seedPairs) {
      await root.template.create({
        data: {
          id: tmplId,
          tenantId,
          serviceLine: 'Gather E2E',
          name: `Tenant ${t.toUpperCase()} template`,
          version: 1,
          status: 'published',
        },
      });
      const n1 = NODE_A(t, 1), n2 = NODE_A(t, 2);
      await root.templateNode.createMany({
        data: [
          {
            id: n1, tenantId, templateId: tmplId,
            question: 'q1?', nodeType: 'short_text',
            nextRules: [{ when: { op: 'always' }, goto: n2 }] as unknown as object,
            position: 0,
          },
          {
            id: n2, tenantId, templateId: tmplId,
            question: 'q2?', nodeType: 'short_text',
            nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
            position: 1,
          },
        ],
      });
      await root.template.update({ where: { id: tmplId }, data: { rootNodeId: n1 } });
    }
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
    await systemClient.$disconnect();
  });

  it('issues a tokenised link, resolves it, walks the tree, and submits', async () => {
    const issued = await engagementsSvc.issue({
      tenantId: TENANT_A,
      salesEmployeeId: USER_A,
      dto: { templateId: TMPL_A, clientEmail: 'client-a@gather.test' },
      publicBaseUrl: 'https://app.test',
    });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(issued.url).toContain(`/g/${issued.token}`);

    // First /state — binds fingerprint, emits link_opened.
    const s1 = await gatheringSvc.getState(issued.token, REQ_CTX);
    expect(s1.engagementId).toBe(issued.engagementId);
    expect(s1.currentNode?.position).toBe(0);

    // Answer node 1 → returns node 2.
    const r1 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, {
      nodeId: s1.currentNode!.id,
      answer: 'first answer',
    });
    expect(r1.next.kind).toBe('node');
    if (r1.next.kind !== 'node') throw new Error('unreachable');
    expect(r1.next.node.position).toBe(1);

    // Answer node 2 → END.
    const r2 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, {
      nodeId: r1.next.node.id,
      answer: 'second answer',
    });
    expect(r2.next.kind).toBe('end');

    // Submit finalises and revokes the token.
    const sub = await gatheringSvc.submit(issued.token, REQ_CTX);
    expect(sub.status).toBe('submitted');

    // After revocation, further use is rejected.
    await expect(gatheringSvc.getState(issued.token, REQ_CTX)).rejects.toThrow(
      /invalid_or_expired_token/,
    );

    // Thread carries the expected events in order.
    const events = await thread.listForEngagement(TENANT_A, issued.engagementId);
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      'link_issued',
      'link_opened',
      'node_answered',
      'node_answered',
      'scope_submitted',
    ]);
  });

  it('rejects garbage tokens with the same error as expired tokens', async () => {
    await expect(gatheringSvc.getState('not-a-real-token-but-long-enough', REQ_CTX)).rejects.toThrow(
      /invalid_or_expired_token/,
    );
  });

  it('cross-tenant: tenant B cannot fetch tenant A engagement via service', async () => {
    const issued = await engagementsSvc.issue({
      tenantId: TENANT_A,
      salesEmployeeId: USER_A,
      dto: { templateId: TMPL_A, clientEmail: 'leaktest@a.test' },
      publicBaseUrl: 'https://app.test',
    });
    await expect(engagementsSvc.getById(TENANT_B, issued.engagementId)).rejects.toThrow(
      /engagement_not_found/,
    );
  });

  it('list is tenant-scoped', async () => {
    // After the previous test, tenant A has at least 2 engagements; tenant B has 0.
    const aList = await engagementsSvc.list(TENANT_A);
    const bList = await engagementsSvc.list(TENANT_B);
    expect(aList.length).toBeGreaterThanOrEqual(2);
    expect(bList).toEqual([]);
    expect(aList.every((e) => e.clientEmail.endsWith('@gather.test') || e.clientEmail.endsWith('@a.test'))).toBe(true);
  });
});
