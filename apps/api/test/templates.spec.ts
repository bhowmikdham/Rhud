/**
 * Templates tenant-isolation integration test.
 *
 * Mirrors the structure of rls.spec.ts: opens a real Postgres connection as
 * `rhud_app` (NOBYPASSRLS), drives the TemplatesService through TenantDb,
 * and asserts that templates created under tenant A are invisible inside a
 * `withTenant(B)` scope.
 *
 * This is the contract we promised in §4.6: "RLS isolation tests assert
 * cross-tenant leaks fail." The fact that we do this for every new
 * tenant-scoped table is what keeps the security model honest as the
 * schema grows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { TemplatesService } from '../src/templates/templates.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000aa';
const TENANT_B = '00000000-0000-0000-0000-0000000000bb';

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

describe('Templates tenant isolation', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });
  const tenantDb = new TenantDb(appRlsClient as unknown as AppPrismaService);
  const svc = new TemplatesService(tenantDb);

  beforeAll(async () => {
    // Clean and re-create the test tenants. CASCADE removes templates+nodes.
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Tenant A (templates test)' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Tenant B (templates test)' } });
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe templates between tests so they don't leak state across cases.
    await root.$executeRaw`DELETE FROM templates WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
  });

  it('a tenant only lists its own templates', async () => {
    await svc.create(TENANT_A, { serviceLine: 'Web', name: 'Tenant A — webapp' });
    await svc.create(TENANT_B, { serviceLine: 'Web', name: 'Tenant B — webapp' });

    const aList = await svc.list(TENANT_A);
    const bList = await svc.list(TENANT_B);

    expect(aList.map((t) => t.name)).toEqual(['Tenant A — webapp']);
    expect(bList.map((t) => t.name)).toEqual(['Tenant B — webapp']);
  });

  it('getById from the wrong tenant 404s rather than leaking', async () => {
    const aTmpl = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'A only' });

    // Pretending to be tenant B, asking for tenant A's template id.
    await expect(svc.getById(TENANT_B, aTmpl.id)).rejects.toThrow(/template_not_found/);
  });

  it('addNode + walk produces a valid template', async () => {
    const t = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'walk test' });

    const n1 = await svc.addNode(TENANT_A, t.id, {
      question: 'pick one',
      nodeType: 'single_select',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
    });

    // First node should auto-set rootNodeId.
    const reloaded = await svc.getById(TENANT_A, t.id);
    expect(reloaded.rootNodeId).toBe(n1.id);
    expect(reloaded.nodes).toHaveLength(1);
  });

  it('publish refuses to promote an invalid template', async () => {
    const t = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'broken' });
    await svc.addNode(TENANT_A, t.id, {
      question: 'orphan',
      nodeType: 'single_select',
      options: [{ value: 'x', label: 'X' }],
      // dangling goto — should fail validation
      nextRules: [{ when: { op: 'always' }, goto: 'does-not-exist' }],
    });

    await expect(svc.update(TENANT_A, t.id, { status: 'published' })).rejects.toThrow();
  });

  it('publish accepts a valid template', async () => {
    const t = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'good' });
    await svc.addNode(TENANT_A, t.id, {
      question: 'q',
      nodeType: 'short_text',
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
    });

    const published = await svc.update(TENANT_A, t.id, { status: 'published' });
    expect(published.status).toBe('published');
  });

  it('importNodes wires a paste-imported list as a linear chain and sets the root', async () => {
    const t = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'imported' });

    const result = await svc.importNodes(TENANT_A, t.id, {
      nodes: [
        { question: 'Engagement Details', nodeType: 'section', helpText: 'Tell us about the project' },
        { question: 'Client name', nodeType: 'short_text', placeholder: 'Acme Inc.' },
        {
          question: 'Industry',
          nodeType: 'single_select',
          options: [
            { value: 'fin', label: 'Financial' },
            { value: 'health', label: 'Healthcare' },
          ],
        },
        { question: 'Approximate budget?', nodeType: 'number', required: false },
      ],
    });

    expect(result.created).toBe(4);

    const reloaded = await svc.getById(TENANT_A, t.id);
    expect(reloaded.nodes).toHaveLength(4);
    expect(reloaded.rootNodeId).toBe(result.rootNodeId);

    // First node is the section heading.
    expect(reloaded.nodes[0]!.nodeType).toBe('section');
    expect(reloaded.nodes[0]!.helpText).toBe('Tell us about the project');

    // Each non-terminal node has a single `always` rule pointing at the next.
    for (let i = 0; i < reloaded.nodes.length - 1; i++) {
      const rules = reloaded.nodes[i]!.nextRules;
      expect(rules).toHaveLength(1);
      expect(rules[0]!.when.op).toBe('always');
      expect(rules[0]!.goto).toBe(reloaded.nodes[i + 1]!.id);
    }
    // Last terminates with END.
    const last = reloaded.nodes[reloaded.nodes.length - 1]!;
    expect(last.nextRules[0]!.goto).toBe('END');
    expect(last.required).toBe(false);
    expect(last.nodeType).toBe('number');

    // Carryover fields landed.
    expect(reloaded.nodes[1]!.placeholder).toBe('Acme Inc.');
    expect(reloaded.nodes[2]!.options).toHaveLength(2);
  });

  it('importNodes with replace=true wipes existing nodes', async () => {
    const t = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'replace test' });
    await svc.addNode(TENANT_A, t.id, {
      question: 'pre-existing',
      nodeType: 'short_text',
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
    });

    await svc.importNodes(TENANT_A, t.id, {
      replace: true,
      nodes: [
        { question: 'first', nodeType: 'short_text' },
        { question: 'second', nodeType: 'short_text' },
      ],
    });

    const reloaded = await svc.getById(TENANT_A, t.id);
    expect(reloaded.nodes).toHaveLength(2);
    expect(reloaded.nodes.map((n) => n.question)).toEqual(['first', 'second']);
  });

  it('rejects a rootNodeId from a different template', async () => {
    const tA = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'A1' });
    const tA2 = await svc.create(TENANT_A, { serviceLine: 'Web', name: 'A2' });

    const n = await svc.addNode(TENANT_A, tA2.id, {
      question: 'belongs to A2',
      nodeType: 'short_text',
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
    });

    await expect(svc.update(TENANT_A, tA.id, { rootNodeId: n.id })).rejects.toThrow(
      /root_node_not_in_template/,
    );
  });
});
