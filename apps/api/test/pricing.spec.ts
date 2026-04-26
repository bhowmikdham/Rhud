/**
 * Pricing engine tenant-isolation + persistence integration test.
 *
 * Mirrors the structure of templates.spec.ts: opens a real Postgres
 * connection as `rhud_app`, drives PricingService through TenantDb,
 * and asserts that:
 *
 *   1. A rate card created under tenant A is invisible to tenant B.
 *   2. The seed → quote round-trip reproduces the PDF §3.3 numbers
 *      *after* persisting through Postgres + reloading the canonical
 *      RateCard back out — same answer as the in-memory pricing.spec
 *      gives, but now with the schema in the loop.
 *   3. Quoting a tenant's card from the wrong tenant 404s rather than
 *      leaking the card.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from '../src/db/prisma.service.js';
import { TenantDb } from '../src/db/with-tenant.js';
import { PricingService } from '../src/pricing/pricing.service.js';

const TENANT_A = '00000000-0000-0000-0000-0000000000a4';
const TENANT_B = '00000000-0000-0000-0000-0000000000b4';

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

describe('Pricing engine — tenant isolation + persistence', () => {
  const rootUrl = process.env.DATABASE_URL;
  if (!rootUrl) throw new Error('DATABASE_URL must be set');
  const root = new PrismaClient({ datasources: { db: { url: rootUrl } } });
  const appRlsClient = new PrismaClient({ datasources: { db: { url: appDatabaseUrl() } } });
  const tenantDb = new TenantDb(appRlsClient as unknown as AppPrismaService);
  const svc = new PricingService(tenantDb);

  beforeAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.tenant.create({ data: { id: TENANT_A, name: 'Tenant A (pricing)' } });
    await root.tenant.create({ data: { id: TENANT_B, name: 'Tenant B (pricing)' } });
  });

  afterAll(async () => {
    await root.$executeRaw`DELETE FROM tenants WHERE id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
    await root.$disconnect();
    await appRlsClient.$disconnect();
  });

  beforeEach(async () => {
    await root.$executeRaw`DELETE FROM rate_cards WHERE tenant_id IN (${TENANT_A}::uuid, ${TENANT_B}::uuid)`;
  });

  it('seedCsaasSample is idempotent and tenant-isolated', async () => {
    const a1 = await svc.seedCsaasSample(TENANT_A);
    const a2 = await svc.seedCsaasSample(TENANT_A);
    expect(a1.id).toBe(a2.id);                    // idempotent
    expect(a1.serviceLines.length).toBeGreaterThan(0);

    const aList = await svc.list(TENANT_A);
    const bList = await svc.list(TENANT_B);
    expect(aList).toHaveLength(1);
    expect(bList).toEqual([]);
  });

  it('reloads the canonical rate card from Postgres and prices the PDF worked example', async () => {
    const card = await svc.seedCsaasSample(TENANT_A);

    const result = await svc.quote(TENANT_A, card.id, [
      { entityId: 'wa_1', serviceLineSlug: 'vapt_web_app',        dimensions: { pages: 75 },   methodology: 'grey_box',     customerType: 'external' },
      { entityId: 'wa_2', serviceLineSlug: 'vapt_web_app',        dimensions: { pages: 22 },   methodology: 'black_box',    customerType: 'external' },
      { entityId: 'ma_1', serviceLineSlug: 'vapt_mobile_android', dimensions: { screens: 60 }, methodology: 'grey_box_apk', customerType: 'external' },
      { entityId: 'api_1', serviceLineSlug: 'vapt_api',           dimensions: { apis: 35 },                                  customerType: 'external' },
    ]);

    expect(result.totalCents).toBe(92_000_00);
    expect(result.currency).toBe('INR');
    expect(result.lines).toHaveLength(4);
    expect(result.hasUnmatched).toBe(false);
  });

  it('cross-tenant: tenant B cannot fetch tenant A rate card by id', async () => {
    const aCard = await svc.seedCsaasSample(TENANT_A);
    await expect(svc.getById(TENANT_B, aCard.id)).rejects.toThrow(/rate_card_not_found/);
  });

  it('cross-tenant: tenant B cannot quote against tenant A rate card', async () => {
    const aCard = await svc.seedCsaasSample(TENANT_A);
    await expect(svc.quote(TENANT_B, aCard.id, [
      { entityId: 'x', serviceLineSlug: 'vapt_web_app', dimensions: { pages: 10 }, methodology: 'grey_box', customerType: 'external' },
    ])).rejects.toThrow(/rate_card_not_found/);
  });

  it('publish flips status and refuses to publish an empty card', async () => {
    const card = await svc.create(TENANT_A, {
      name: 'Empty draft',
      serviceLines: [
        { slug: 'tmp_line', displayName: 'Tmp', scopeUnit: 'pages', tiers: [] },
      ],
    });

    await expect(svc.publish(TENANT_A, card.id)).rejects.toThrow(/no_tiers/);

    // Add a tier (via create flow as a fresh card for cleanliness) and publish that one.
    const card2 = await svc.create(TENANT_A, {
      name: 'Real draft',
      serviceLines: [
        {
          slug: 'real_line',
          displayName: 'Real',
          scopeUnit: 'pages',
          tiers: [
            { rangeMin: 0, rangeMax: 100, methodology: null, customerType: 'external', priceCents: 5_000_00 },
          ],
        },
      ],
    });
    const published = await svc.publish(TENANT_A, card2.id);
    expect(published.status).toBe('published');
  });
});
