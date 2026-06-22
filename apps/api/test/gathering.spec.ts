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
import { PricingService } from '../src/pricing/pricing.service.js';
import { RateCardHintSynthesizerService } from '../src/pricing/rate-card-hint-synthesizer.service.js';
import { QuoteService } from '../src/pricing/quote.service.js';
import { EmailService } from '../src/email/email.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { MlClient } from '../src/ml/ml-client.service.js';
import { MlService } from '../src/ml/ml.service.js';
import { OdooService } from '../src/integrations/odoo/odoo.service.js';

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
  // Notifications fan-out is tested in notifications.spec.ts; here we just
  // need a no-op EmailService so the service constructs without touching SES.
  const email = { sendNotification: async () => true } as unknown as EmailService;
  const notifications = new NotificationsService(tenantDb, email);
  const thread = new ThreadService(tenantDb, notifications);
  const s3 = new S3Service();
  // Stub the ML client so the gathering test doesn't require a running
  // FastAPI service. Returns null (= "no model") for every predict call,
  // which is the same path tenants without a trained model take in prod.
  const mlClient = new MlClient();
  mlClient.predict = async () => null;
  mlClient.train = async () => null;
  const mlSvc = new MlService(tenantDb, thread, mlClient);
  const engagementsSvc = new EngagementsService(tenantDb, thread, s3);
  const pricingSvc = new PricingService(tenantDb, new RateCardHintSynthesizerService());
  // Stub the rate-card field mapper — these tests don't exercise
  // extraction-driven pricing. Returning [] makes the quote service
  // fall back to form-only input, matching pre-mapper behavior.
  const fieldMapperStub = {
    inferEntities: async () => [],
    toScopedEntities: () => [],
  } as unknown as import('../src/pricing/rate-card-mapper.service.js').RateCardFieldMapperService;
  const quoteSvc = new QuoteService(tenantDb, pricingSvc, thread, fieldMapperStub);
  // Stub ExtractionService — these tests don't exercise the
  // document-extraction pipeline (no files involved) so we hand
  // GatheringService a minimal shape that no-ops for both kickoff
  // paths it calls. `isAllSettled` returning true makes submit fire
  // predict synchronously, matching pre-extraction-feature behavior.
  const extractionStub = {
    kickoff: async () => undefined,
    kickoffForEngagement: async () => 0,
    isAllSettled: async () => true,
  } as unknown as import('../src/extraction/extraction.service.js').ExtractionService;
  // Stub OdooService — auto-sync hook is a no-op when Odoo isn't
  // configured (which it isn't in test).
  const odooSvc = new OdooService(tenantDb);
  // Stub ClassificationService — Phase B's auto-classify is fire-and-
  // forget on submit. Returning undefined matches its void return.
  const classificationStub = {
    classifyOnSubmit: async () => undefined,
  } as unknown as import('../src/classification/classification.service.js').ClassificationService;
  const gatheringSvc = new GatheringService(
    unscoped, tenantDb, thread, s3, mlSvc, quoteSvc, extractionStub, odooSvc, classificationStub,
  );

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

  it('a section node advances on null and an optional question accepts a skip', async () => {
    // Drop a fresh template in tenant A: section → optional number → END.
    const tmplId = '99999999-9999-9999-9999-9999999999c3';
    const sec = 'aaaaaaaa-aaaa-aaaa-aaaa-cccc00000001';
    const opt = 'aaaaaaaa-aaaa-aaaa-aaaa-cccc00000002';
    await root.template.create({
      data: { id: tmplId, tenantId: TENANT_A, serviceLine: 'opt', name: 'opt-section', version: 1, status: 'published' },
    });
    await root.templateNode.createMany({
      data: [
        {
          id: sec, tenantId: TENANT_A, templateId: tmplId,
          question: 'Engagement Details', nodeType: 'section',
          helpText: 'Tell us a bit', required: true, position: 0,
          nextRules: [{ when: { op: 'always' }, goto: opt }] as unknown as object,
        },
        {
          id: opt, tenantId: TENANT_A, templateId: tmplId,
          question: 'Approximate budget?', nodeType: 'number',
          required: false, position: 1,
          nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
        },
      ],
    });
    await root.template.update({ where: { id: tmplId }, data: { rootNodeId: sec } });

    const issued = await engagementsSvc.issue({
      tenantId: TENANT_A,
      salesEmployeeId: USER_A,
      dto: { templateId: tmplId, clientEmail: 'opt-section@gather.test' },
      publicBaseUrl: 'https://app.test',
    });

    const s = await gatheringSvc.getState(issued.token, REQ_CTX);
    expect(s.currentNode?.nodeType).toBe('section');
    expect(s.currentNode?.helpText).toBe('Tell us a bit');

    const past = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, {
      nodeId: s.currentNode!.id,
      answer: null,
    });
    if (past.next.kind !== 'node') throw new Error('expected node after section');
    expect(past.next.node.nodeType).toBe('number');
    expect(past.next.node.required).toBe(false);

    const skipped = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, {
      nodeId: past.next.node.id,
      answer: null,
    });
    expect(skipped.next.kind).toBe('end');
  });

  it('walks a loop body across multiple iterations with body END = "Add another?"', async () => {
    // Template:
    //   • root (short_text "Project name?")
    //     → loop (label "Application")
    //         body[0]: short_text  "Name of the application"
    //         body[1]: single_select "Type" (Dynamic / Static)
    //   • tail: short_text "Anything else?"
    const tmplId = '99999999-9999-9999-9999-9999999999d3';
    const rootId = 'aaaaaaaa-aaaa-aaaa-aaaa-dddd00000001';
    const loopId = 'aaaaaaaa-aaaa-aaaa-aaaa-dddd00000002';
    const body0  = 'aaaaaaaa-aaaa-aaaa-aaaa-dddd00000003';
    const body1  = 'aaaaaaaa-aaaa-aaaa-aaaa-dddd00000004';
    const tailId = 'aaaaaaaa-aaaa-aaaa-aaaa-dddd00000005';

    await root.template.create({
      data: { id: tmplId, tenantId: TENANT_A, serviceLine: 'loop', name: 'loop test', version: 1, status: 'published' },
    });
    await root.templateNode.createMany({
      data: [
        {
          id: rootId, tenantId: TENANT_A, templateId: tmplId,
          question: 'Project name?', nodeType: 'short_text', position: 0,
          nextRules: [{ when: { op: 'always' }, goto: loopId }] as unknown as object,
        },
        {
          id: loopId, tenantId: TENANT_A, templateId: tmplId,
          question: 'Applications', nodeType: 'loop', position: 1,
          loopConfig: { mode: 'open_ended', label: 'Application' } as unknown as object,
          nextRules: [{ when: { op: 'always' }, goto: tailId }] as unknown as object,
        },
        {
          id: body0, tenantId: TENANT_A, templateId: tmplId, parentNodeId: loopId,
          question: 'Name of the application', nodeType: 'short_text', position: 0,
          nextRules: [{ when: { op: 'always' }, goto: body1 }] as unknown as object,
        },
        {
          id: body1, tenantId: TENANT_A, templateId: tmplId, parentNodeId: loopId,
          question: 'Type', nodeType: 'single_select', position: 1,
          options: [
            { value: 'dynamic', label: 'Dynamic' },
            { value: 'static', label: 'Static' },
          ] as unknown as object,
          // body END means end-of-body — the runtime translates this into
          // an "Add another?" prompt rather than ending the template.
          nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
        },
        {
          id: tailId, tenantId: TENANT_A, templateId: tmplId,
          question: 'Anything else?', nodeType: 'short_text', position: 2,
          required: false,
          nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
        },
      ],
    });
    await root.template.update({ where: { id: tmplId }, data: { rootNodeId: rootId } });

    const issued = await engagementsSvc.issue({
      tenantId: TENANT_A,
      salesEmployeeId: USER_A,
      dto: { templateId: tmplId, clientEmail: 'loop-walk@gather.test' },
      publicBaseUrl: 'https://app.test',
    });

    // 1) State at start: root short_text.
    const s0 = await gatheringSvc.getState(issued.token, REQ_CTX);
    expect(s0.currentNode?.id).toBe(rootId);
    expect(s0.loopContext).toBeNull();

    // 2) Answer root → into the loop body, iter 0, with loopContext.
    const a1 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: rootId, answer: 'Project Apollo' });
    if (a1.next.kind !== 'node') throw new Error('expected node');
    expect(a1.next.node.id).toBe(body0);
    expect(a1.next.loopContext?.iter).toBe(0);
    expect(a1.next.loopContext?.label).toBe('Application');

    // 3) Answer body[0] iter 0 → body[1] iter 0, same loopContext.
    const a2 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body0, answer: 'app.example.com' });
    if (a2.next.kind !== 'node') throw new Error('expected node');
    expect(a2.next.node.id).toBe(body1);
    expect(a2.next.loopContext?.iter).toBe(0);

    // 4) Answer body[1] iter 0 → loop_step (Add another?).
    const a3 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body1, answer: 'dynamic' });
    expect(a3.next.kind).toBe('loop_step');
    if (a3.next.kind !== 'loop_step') throw new Error('unreachable');
    expect(a3.next.loopId).toBe(loopId);
    expect(a3.next.iter).toBe(0);

    // 5) Continue → bumps iter to 1, returns body[0] for the new iter.
    const a4 = await gatheringSvc.submitLoopStep(issued.token, REQ_CTX, { loopId, action: 'continue' });
    if (a4.next.kind !== 'node') throw new Error('expected node after continue');
    expect(a4.next.node.id).toBe(body0);
    expect(a4.next.loopContext?.iter).toBe(1);

    // 6) Walk iter 1 to end-of-body.
    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body0, answer: 'admin.example.com' });
    const a6 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body1, answer: 'static' });
    if (a6.next.kind !== 'loop_step') throw new Error('expected loop_step');
    expect(a6.next.iter).toBe(1);

    // 7) Continue once more → iter 2.
    await gatheringSvc.submitLoopStep(issued.token, REQ_CTX, { loopId, action: 'continue' });
    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body0, answer: 'api.example.com' });
    const a8 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: body1, answer: 'dynamic' });
    if (a8.next.kind !== 'loop_step') throw new Error('expected loop_step');
    expect(a8.next.iter).toBe(2);

    // 8) Done → walks past the loop into the tail.
    const a9 = await gatheringSvc.submitLoopStep(issued.token, REQ_CTX, { loopId, action: 'done' });
    if (a9.next.kind !== 'node') throw new Error('expected node after done');
    expect(a9.next.node.id).toBe(tailId);
    expect(a9.next.loopContext).toBeNull();

    // 9) State at this point: cursor at tailId, loopAnswers[loopId] has 3 iterations.
    const sMid = await gatheringSvc.getState(issued.token, REQ_CTX);
    expect(sMid.currentNode?.id).toBe(tailId);
    expect(sMid.loopAnswers[loopId]).toHaveLength(3);
    expect(sMid.loopAnswers[loopId]?.[0]?.[body0]).toBe('app.example.com');
    expect(sMid.loopAnswers[loopId]?.[2]?.[body1]).toBe('dynamic');

    // 10) Skip the optional tail and submit.
    const a10 = await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: tailId, answer: null });
    expect(a10.next.kind).toBe('end');
    const done = await gatheringSvc.submit(issued.token, REQ_CTX);
    expect(done.status).toBe('submitted');
  });

  it('end-to-end: gathering loop + bindings produce a base-priced quote on submit', async () => {
    // Stand up the canonical CSaaS rate card for tenant A.
    const card = await pricingSvc.seedCsaasSample(TENANT_A);

    // Build a template with one loop bound to vapt_web_app + a body of
    // bound questions. Two iterations → matches PDF §3.3 "wa_1 + wa_2".
    const tmplId = '99999999-9999-9999-9999-9999999999e3';
    const loopId = 'aaaaaaaa-aaaa-aaaa-aaaa-eeee00000001';
    const bMethod = 'aaaaaaaa-aaaa-aaaa-aaaa-eeee00000002';
    const bPages  = 'aaaaaaaa-aaaa-aaaa-aaaa-eeee00000003';

    await root.template.create({
      data: {
        id: tmplId, tenantId: TENANT_A, serviceLine: 'webapp',
        name: 'webapp scoping', version: 1, status: 'published',
        rateCardId: card.id,
      },
    });
    await root.templateNode.createMany({
      data: [
        {
          id: loopId, tenantId: TENANT_A, templateId: tmplId,
          question: 'Web Applications', nodeType: 'loop', position: 0,
          loopConfig: {
            mode: 'open_ended',
            label: 'Web App',
            serviceLineSlug: 'vapt_web_app',
          } as unknown as object,
          nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
        },
        {
          id: bMethod, tenantId: TENANT_A, templateId: tmplId, parentNodeId: loopId,
          question: 'Test type', nodeType: 'single_select', position: 0,
          options: [
            { value: 'grey_box', label: 'Grey Box' },
            { value: 'black_box', label: 'Black Box' },
          ] as unknown as object,
          binding: { field: 'methodology' } as unknown as object,
          nextRules: [{ when: { op: 'always' }, goto: bPages }] as unknown as object,
        },
        {
          id: bPages, tenantId: TENANT_A, templateId: tmplId, parentNodeId: loopId,
          question: 'Number of pages', nodeType: 'number', position: 1,
          binding: { field: 'scope_value' } as unknown as object,
          nextRules: [{ when: { op: 'always' }, goto: 'END' }] as unknown as object,
        },
      ],
    });
    await root.template.update({ where: { id: tmplId }, data: { rootNodeId: loopId } });

    // Issue + walk: 75 pages grey, then 22 pages black → continue / done.
    const issued = await engagementsSvc.issue({
      tenantId: TENANT_A,
      salesEmployeeId: USER_A,
      dto: { templateId: tmplId, clientEmail: 'quote-e2e@gather.test' },
      publicBaseUrl: 'https://app.test',
    });

    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: bMethod, answer: 'grey_box' });
    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: bPages,  answer: 75 });
    await gatheringSvc.submitLoopStep(issued.token, REQ_CTX, { loopId, action: 'continue' });
    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: bMethod, answer: 'black_box' });
    await gatheringSvc.submitAnswer(issued.token, REQ_CTX, { nodeId: bPages,  answer: 22 });
    await gatheringSvc.submitLoopStep(issued.token, REQ_CTX, { loopId, action: 'done' });

    // submit triggers compute-and-persist. Inline-await it via the service
    // so we're not racing the fire-and-forget ML path.
    const subm = await gatheringSvc.submit(issued.token, REQ_CTX);
    expect(subm.status).toBe('submitted');

    // 75 pages, grey, external = 25,000 ; 22 pages, black, external = 7,000 → 32,000.
    const quote = await quoteSvc.getForEngagement(TENANT_A, issued.engagementId);
    expect(quote).not.toBeNull();
    expect(quote!.currency).toBe('INR');
    expect(quote!.baseTotalCents).toBe(32_000_00);
    expect(quote!.baseBreakdown).toHaveLength(2);
    const [first, second] = quote!.baseBreakdown;
    expect(first!.serviceLineSlug).toBe('vapt_web_app');
    expect(first!.scopeValue).toBe(75);
    expect(first!.priceCents).toBe(25_000_00);
    expect(second!.scopeValue).toBe(22);
    expect(second!.priceCents).toBe(7_000_00);
    // (Quote-level approve was removed — see authz-boundary-2. Final price
    // approval now flows through the gated PredictionController.approve path,
    // covered by the pricing/prediction tests.)
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
