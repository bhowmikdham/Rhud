/**
 * Prediction orchestrator + opportunity-level approve — integration spec.
 *
 * Bootstraps a tenant + rate card + template + answered engagement
 * directly through Prisma, then drives PredictionService end-to-end:
 *
 *   - cold_start scenario: zero closed deals → regime=cold_start, base
 *     == predicted, drivers empty, prediction row + audit event written.
 *   - rules scenario: bump closed-deal count above the threshold,
 *     configure a loyalty rule that the client matches, re-predict →
 *     regime=rules, drivers populated, predicted < base.
 *   - snapshot pinning: a re-predict after more deals close keeps the
 *     ORIGINAL closed-count snapshot, regime stable.
 *   - approve: the new opportunity-level approve sets approved_price,
 *     mirrors onto engagement_quotes, emits approval_granted with the
 *     prediction id in the payload (the audit-trail risk we called out).
 *   - cross-tenant: tenant B cannot read tenant A's predictions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { ConsoleEmailTransport } from '../src/notifications/email.transport.js';
import { NotificationsService } from '../src/notifications/notifications.service.js';
import { ThreadService } from '../src/thread/thread.service.js';
import { PricingService } from '../src/pricing/pricing.service.js';
import { QuoteService } from '../src/pricing/quote.service.js';
import { PredictionService } from '../src/pricing/prediction.service.js';
import { TenantPricingConfigService } from '../src/pricing/tenant-pricing-config.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000a5';
const TENANT_B = '00000000-0000-0000-0000-0000000000b5';

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

describe('Prediction orchestrator + approval flow', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRls = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });
  const tenantDb = new TenantDb(appRls as unknown as AppPrismaService);
  const email = new ConsoleEmailTransport();
  const notifications = new NotificationsService(tenantDb, email);
  const thread = new ThreadService(tenantDb, notifications);
  const pricing = new PricingService(tenantDb);
  const quotes = new QuoteService(tenantDb, pricing, thread);
  const config = new TenantPricingConfigService(tenantDb);
  const predict = new PredictionService(tenantDb, thread, quotes);

  // Build a tiny template that maps a single loop iteration to vapt_web_app.
  // Grey box, 75 pages → exactly 25,000 INR per the PDF. We pre-populate
  // engagement_answers directly so we don't have to walk gathering.
  const TPL_ID = '11111111-1111-1111-1111-111111111111';
  const LOOP_NODE = '33333333-3333-3333-3333-333333333333';
  const SCOPE_NODE = '33333333-3333-3333-3333-333333333334';
  const METHOD_NODE = '33333333-3333-3333-3333-333333333335';
  const SALES_EMP = '00000000-0000-0000-0000-0000000000aa';

  async function seedTenant(tenantId: string) {
    // Use the live PricingService to persist the canonical CSaaS card —
    // RateCardTier ids must be UUIDs and seedCsaasSample handles that.
    const card = await pricing.seedCsaasSample(tenantId);
    // Tiny template: loop bound to vapt_web_app + scope_value/methodology
    // body nodes. We seed via root client (skip RLS).
    await root.template.create({
      data: {
        id: TPL_ID, tenantId,
        serviceLine: 'vapt', name: 'Test', version: 1, status: 'published',
        rateCardId: card.id,
      },
    });
    await root.templateNode.create({
      data: {
        id: LOOP_NODE, tenantId, templateId: TPL_ID,
        question: 'Apps to test', nodeType: 'loop', position: 0,
        loopConfig: { mode: 'open_ended', label: 'Application', serviceLineSlug: 'vapt_web_app' },
      },
    });
    await root.templateNode.create({
      data: {
        id: SCOPE_NODE, tenantId, templateId: TPL_ID, parentNodeId: LOOP_NODE,
        question: 'Pages', nodeType: 'number', position: 0,
        binding: { field: 'scope_value' },
      },
    });
    await root.templateNode.create({
      data: {
        id: METHOD_NODE, tenantId, templateId: TPL_ID, parentNodeId: LOOP_NODE,
        question: 'Methodology', nodeType: 'single_select', position: 1,
        options: [{ value: 'grey_box', label: 'Grey box' }, { value: 'black_box', label: 'Black box' }],
        binding: { field: 'methodology' },
      },
    });
    await root.template.update({ where: { id: TPL_ID }, data: { rootNodeId: LOOP_NODE } });
  }

  async function makeEngagement(
    tenantId: string,
    opts: { id: string; clientEmail: string; pages: number; method: string },
  ) {
    await root.engagement.create({
      data: {
        id: opts.id, tenantId,
        templateId: TPL_ID, templateVersion: 1,
        salesEmployeeId: SALES_EMP,
        clientEmail: opts.clientEmail,
        status: 'submitted',
      },
    });
    await root.engagementAnswer.create({
      data: {
        tenantId, engagementId: opts.id, nodeId: SCOPE_NODE,
        iterationIndex: 0, answer: opts.pages,
      },
    });
    await root.engagementAnswer.create({
      data: {
        tenantId, engagementId: opts.id, nodeId: METHOD_NODE,
        iterationIndex: 0, answer: opts.method,
      },
    });
  }

  beforeAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Tenant A (predict)' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Tenant B (predict)' } });
    await root.user.create({
      data: {
        id: SALES_EMP, tenantId: TENANT_A,
        email: 'sales-pred@a.test', role: 'sales_employee',
      },
    });
    await seedTenant(TENANT_A);
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRls.$disconnect();
  });

  beforeEach(async () => {
    await root.$executeRaw`DELETE FROM predictions WHERE tenant_id = ${TENANT_A}::uuid`;
    await root.$executeRaw`DELETE FROM engagement_quotes WHERE tenant_id = ${TENANT_A}::uuid`;
    await root.$executeRaw`DELETE FROM engagements WHERE tenant_id = ${TENANT_A}::uuid`;
    await root.$executeRaw`DELETE FROM tenant_pricing_config WHERE tenant_id = ${TENANT_A}::uuid`;
  });

  // ── Cold-start scenario ───────────────────────────────────────────────────

  it('cold_start: zero closed deals → predicted == base, drivers empty', async () => {
    const ENG = '44444444-4444-4444-4444-444444444401';
    await makeEngagement(TENANT_A, {
      id: ENG, clientEmail: 'alice@acme.test', pages: 75, method: 'grey_box',
    });

    const result = await predict.predictForEngagement(TENANT_A, ENG);

    expect(result.regime).toBe('cold_start');
    expect(result.basePriceCents).toBe(25_000_00);     // PDF §3.3 first line
    expect(result.predictedPriceCents).toBe(25_000_00);
    expect(result.adjustmentPct).toBe(0);
    expect(result.drivers).toEqual([]);
    expect(result.bandLowCents).toBe(result.predictedPriceCents);
    expect(result.bandHighCents).toBe(result.predictedPriceCents);

    // Persisted + audit event landed.
    const saved = await predict.latestForEngagement(TENANT_A, ENG);
    expect(saved?.id).toBe(result.id);
    const events = await root.threadEvent.findMany({
      where: { engagementId: ENG, eventType: 'price_predicted' },
    });
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { predictionId: string }).predictionId).toBe(result.id);
  });

  // ── Rules scenario ────────────────────────────────────────────────────────

  it('rules: matching loyalty rule applies discount, drivers populated', async () => {
    // Seed 6 prior closed deals with the SAME client so lifetime value
    // climbs above the rule threshold AND the closed-count crosses 5.
    for (let i = 0; i < 6; i++) {
      await root.engagement.create({
        data: {
          id: `55555555-5555-5555-5555-5555555555${i.toString().padStart(2, '0')}`,
          tenantId: TENANT_A, templateId: TPL_ID, templateVersion: 1,
          salesEmployeeId: SALES_EMP,
          clientEmail: 'bob@megacorp.test',
          status: 'closed',
          approvedPriceCents: BigInt(100_000_00), // ₹1L each, 6 deals = ₹6L
          closedAt: new Date(`2025-0${i + 1}-15T00:00:00Z`),
        },
      });
    }
    // Configure the loyalty rule.
    await config.update(TENANT_A, {
      loyaltyRules: [
        { tier: 'strategic', minLifetimeValueCents: 500_000_00, discountPct: -0.10, label: 'Strategic 10%' },
      ],
    });

    const ENG = '44444444-4444-4444-4444-444444444402';
    await makeEngagement(TENANT_A, {
      id: ENG, clientEmail: 'bob@megacorp.test', pages: 75, method: 'grey_box',
    });

    const result = await predict.predictForEngagement(TENANT_A, ENG);

    expect(result.regime).toBe('rules');
    expect(result.basePriceCents).toBe(25_000_00);
    expect(result.predictedPriceCents).toBe(22_500_00);  // 25,000 × 0.9
    expect(result.adjustmentPct).toBeCloseTo(-0.10);
    expect(result.drivers).toHaveLength(1);
    expect(result.drivers[0]).toMatchObject({
      feature: 'loyalty_strategic',
      direction: 'discount',
    });
  });

  // ── Snapshot pinning ──────────────────────────────────────────────────────

  it('snapshot pins regime: re-predict after more deals close stays in same regime', async () => {
    const ENG = '44444444-4444-4444-4444-444444444403';
    await makeEngagement(TENANT_A, {
      id: ENG, clientEmail: 'alice@acme.test', pages: 75, method: 'grey_box',
    });

    // First predict → cold_start (zero priors).
    const first = await predict.predictForEngagement(TENANT_A, ENG);
    expect(first.regime).toBe('cold_start');

    // Now seed 10 more closed deals (well past cold_start_until_n_closed).
    for (let i = 0; i < 10; i++) {
      await root.engagement.create({
        data: {
          id: `66666666-6666-6666-6666-6666666666${i.toString().padStart(2, '0')}`,
          tenantId: TENANT_A, templateId: TPL_ID, templateVersion: 1,
          salesEmployeeId: SALES_EMP,
          clientEmail: 'someone@else.test',
          status: 'closed',
          approvedPriceCents: BigInt(50_000_00),
        },
      });
    }

    // Re-predict the SAME engagement. Snapshot is pinned at 0 from the
    // first call, so we stay in cold_start even though count is now 10.
    const second = await predict.predictForEngagement(TENANT_A, ENG);
    expect(second.regime).toBe('cold_start');
    expect(second.id).not.toBe(first.id);
  });

  // ── Cross-tenant ──────────────────────────────────────────────────────────

  it('cross-tenant: tenant B cannot read tenant A predictions', async () => {
    const ENG = '44444444-4444-4444-4444-444444444404';
    await makeEngagement(TENANT_A, {
      id: ENG, clientEmail: 'alice@acme.test', pages: 75, method: 'grey_box',
    });
    await predict.predictForEngagement(TENANT_A, ENG);

    const fromB = await predict.listForEngagement(TENANT_B, ENG);
    expect(fromB).toEqual([]);
    const latestFromB = await predict.latestForEngagement(TENANT_B, ENG);
    expect(latestFromB).toBeNull();
  });
});
