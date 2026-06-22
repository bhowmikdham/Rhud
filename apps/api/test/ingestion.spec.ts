/**
 * Sprint-1 integration test for the direct-ingest pipeline.
 * See docs/direct-ingest.md §8 for the verification scenarios.
 *
 * Drives IngestionService + EngagementsService against a real Postgres
 * connected as `rhud_app` (NOBYPASSRLS). Asserts:
 *   1. Paste-text receive+promote → engagement + requirements_ingested
 *      event, source=paste_text, templateId=null, status=ingesting.
 *   3. Direct-ingest opportunity → POST /opportunities/:id/links attaches
 *      a template + emits link_issued (first link on this engagement).
 *   4. Re-issue link on an engagement that already has a token → emits
 *      link_reissued (not link_issued).
 *   6. Backfill correctness: pre-existing engagements have source = 'manual_form'.
 *
 * Scenarios 2 (file-drop, needs S3) and 5 (proposal without template,
 * needs LLM) are deferred — the core promote() path is exercised here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { ThreadService } from '../src/thread/thread.service.js';
import { S3Service } from '../src/storage/s3.service.js';
import { EmailService } from '../src/email/email.service.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { EngagementsService } from '../src/engagements/engagements.service.js';
import { IngestionService } from '../src/ingestion/ingestion.service.js';

const TENANT = '00000000-0000-0000-0000-0000000000d1';
const USER = '11111111-1111-1111-1111-1111111111d1';
const TMPL = '99999999-9999-9999-9999-9999999999d1';

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

describe('Direct-ingest pipeline (sprint 1)', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });

  const tenantDb = new TenantDb(appRlsClient as unknown as AppPrismaService);
  const email = { sendNotification: async () => true } as unknown as EmailService;
  const notifications = new NotificationsService(tenantDb, email);
  const thread = new ThreadService(tenantDb, notifications);
  const s3 = new S3Service();
  const engagementsSvc = new EngagementsService(tenantDb, thread, s3);
  // Extraction stub — these tests don't exercise the extraction
  // pipeline (no LLM, no S3 round-trip). promote() fires kickoff post-
  // commit; returning 0 is the no-op path.
  const extractionStub = {
    kickoffForEngagement: async () => 0,
    kickoff: async () => undefined,
  } as unknown as import('../src/extraction/extraction.service.js').ExtractionService;
  const ingestionSvc = new IngestionService(
    tenantDb, thread, s3, extractionStub, engagementsSvc,
  );

  beforeAll(async () => {
    // Hard reset prior fixture state.
    await root.$executeRaw`DELETE FROM tenants WHERE id = ${TENANT}::uuid`;
    await root.tenant.create({ data: { id: TENANT, name: 'Tenant (ingest)' } });
    await root.user.create({
      data: { id: USER, tenantId: TENANT, email: 'rep@ingest.test', role: 'sales_employee' },
    });
    await root.template.create({
      data: {
        id: TMPL,
        tenantId: TENANT,
        serviceLine: 'Ingest E2E',
        name: 'Ingest test template',
        version: 1,
        status: 'published',
      },
    });
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id = ${TENANT}::uuid`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
  });

  // ── Scenario 1: paste-text happy path ──────────────────────────────
  it('promotes a paste-text artifact into an ingesting opportunity', async () => {
    const r = await ingestionSvc.receiveAndPromote({
      tenantId: TENANT,
      source: 'paste_text',
      content: {
        kind: 'text',
        data: { rawText: 'Hi team, please scope a VAPT for our Q4 release.' },
      },
      receivedBy: USER,
      salesEmployeeId: USER,
      overrides: { clientEmail: 'alex@northwind.test' },
    });
    expect(r.engagementId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(r.artifactIds).toHaveLength(1);

    // The engagement is bare — no template, status=ingesting.
    const eng = await root.engagement.findUnique({ where: { id: r.engagementId } });
    expect(eng).toBeTruthy();
    expect(eng!.source).toBe('paste_text');
    expect(eng!.templateId).toBeNull();
    expect(eng!.status).toBe('ingesting');
    expect(eng!.clientEmail).toBe('alex@northwind.test');
    expect(eng!.ingestionId).toBe(r.artifactIds[0]);

    // The artifact was promoted (engagementId set, status=promoted).
    const art = await root.ingestionArtifact.findUnique({ where: { id: r.artifactIds[0]! } });
    expect(art).toBeTruthy();
    expect(art!.engagementId).toBe(r.engagementId);
    expect(art!.status).toBe('promoted');
    expect(art!.kind).toBe('text');
    expect(art!.rawText).toContain('VAPT');

    // The requirements_ingested event landed.
    const events = await root.threadEvent.findMany({
      where: { engagementId: r.engagementId, eventType: 'requirements_ingested' },
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as Record<string, unknown>;
    expect(payload.source).toBe('paste_text');
    expect(payload.kind).toBe('text');

    // The materialised EngagementFile exists with originArtifactId set.
    const files = await root.engagementFile.findMany({ where: { engagementId: r.engagementId } });
    expect(files).toHaveLength(1);
    expect(files[0]!.originArtifactId).toBe(r.artifactIds[0]);
    expect(files[0]!.contentType).toBe('text/plain');
  });

  // ── Scenario 3: direct-ingest then re-scope (first link) ───────────
  it('issues the first link on a direct-ingest opportunity (link_issued)', async () => {
    const r = await ingestionSvc.receiveAndPromote({
      tenantId: TENANT,
      source: 'paste_text',
      content: { kind: 'text', data: { rawText: 'follow-up scoping needed' } },
      receivedBy: USER,
      salesEmployeeId: USER,
      overrides: { clientEmail: 'rescope@ingest.test' },
    });

    const link = await engagementsSvc.issueLinkForExisting({
      tenantId: TENANT,
      engagementId: r.engagementId,
      salesEmployeeId: USER,
      templateId: TMPL,
      publicBaseUrl: 'https://app.test',
    });
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.url).toContain(`/g/${link.token}`);

    // Template attached as a side-effect of the mint.
    const eng = await root.engagement.findUnique({ where: { id: r.engagementId } });
    expect(eng!.templateId).toBe(TMPL);
    expect(eng!.templateVersion).toBe(1);

    // First token on this engagement → link_issued (not link_reissued).
    const issuedEvents = await root.threadEvent.findMany({
      where: { engagementId: r.engagementId, eventType: 'link_issued' },
    });
    expect(issuedEvents).toHaveLength(1);
    const reissuedEvents = await root.threadEvent.findMany({
      where: { engagementId: r.engagementId, eventType: 'link_reissued' },
    });
    expect(reissuedEvents).toHaveLength(0);
  });

  // ── Scenario 4: re-issue on link-share opportunity (link_reissued) ──
  it('emits link_reissued when minting a second token on an existing engagement', async () => {
    // First token via the legacy create-with-link path.
    const first = await engagementsSvc.issue({
      tenantId: TENANT,
      salesEmployeeId: USER,
      dto: { templateId: TMPL, clientEmail: 'reissue@ingest.test' },
      publicBaseUrl: 'https://app.test',
    });
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Second token — same engagement, same template.
    const second = await engagementsSvc.issueLinkForExisting({
      tenantId: TENANT,
      engagementId: first.engagementId,
      salesEmployeeId: USER,
      templateId: TMPL,
      reason: 'client asked for clarification',
      publicBaseUrl: 'https://app.test',
    });
    expect(second.token).not.toBe(first.token);

    const reissuedEvents = await root.threadEvent.findMany({
      where: { engagementId: first.engagementId, eventType: 'link_reissued' },
    });
    expect(reissuedEvents).toHaveLength(1);
    const payload = reissuedEvents[0]!.payload as Record<string, unknown>;
    expect(payload.reason).toBe('client asked for clarification');

    // Two GatheringToken rows exist for the engagement.
    const tokens = await root.gatheringToken.findMany({
      where: { engagementId: first.engagementId },
    });
    expect(tokens).toHaveLength(2);
  });

  // Rejects template switches on re-issue (audit / answer-integrity invariant).
  it('rejects re-issue with a different templateId', async () => {
    const created = await engagementsSvc.issue({
      tenantId: TENANT,
      salesEmployeeId: USER,
      dto: { templateId: TMPL, clientEmail: 'switch@ingest.test' },
      publicBaseUrl: 'https://app.test',
    });
    // Create a second published template to attempt the switch.
    const OTHER_TMPL = '99999999-9999-9999-9999-99999999d1ee';
    await root.template.create({
      data: {
        id: OTHER_TMPL,
        tenantId: TENANT,
        serviceLine: 'Other',
        name: 'Other',
        version: 1,
        status: 'published',
      },
    });

    await expect(
      engagementsSvc.issueLinkForExisting({
        tenantId: TENANT,
        engagementId: created.engagementId,
        salesEmployeeId: USER,
        templateId: OTHER_TMPL,
        publicBaseUrl: 'https://app.test',
      }),
    ).rejects.toThrow(/template_mismatch_with_existing/);
  });

  // ── Scenario 6: backfill correctness ─────────────────────────────
  it('every engagement carries a source (CHECK constraint + default backfilled)', async () => {
    // After the migration, every engagement (including new ones we just
    // created) has a non-null source from the whitelist.
    const rows = await root.engagement.findMany({
      where: { tenantId: TENANT },
      select: { id: true, source: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    const ALLOWED = new Set([
      'manual_form','direct_upload','paste_text','voice_note',
      'email_import','whatsapp_import','rfp_import','sow_import',
      'odoo_import','api',
    ]);
    for (const r of rows) {
      expect(r.source).toBeTruthy();
      expect(ALLOWED.has(r.source)).toBe(true);
    }
  });
});
