/**
 * Smoke: end-to-end partner intake.
 *
 * 1. Admin sets tenant defaults (default template + default sales owner)
 *    so the intake endpoint has a fallback chain.
 * 2. Admin creates a partner token.
 * 3. POST to /partner-intake/:token with a free-text bodyText.
 * 4. Verify a new engagement landed with source='partner_api'.
 * 5. Revoke the partner token (cleanup).
 *
 * Drives the API directly — this spec is about the new public endpoint,
 * not the UI flows that already had spec coverage.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiToken, SEED } from './fixtures.js';

test('partner intake: token → POST → opportunity has source=partner_api', async ({ request }) => {
  const jwt = await apiToken(request, SEED.admin.email, SEED.admin.password);
  const authHeaders = { authorization: `Bearer ${jwt}` };

  // 1. Read /tenant/me to discover any published template + a sales-
  //    employee user. Use them as the workspace defaults if they aren't
  //    already set.
  const templatesRes = await request.get(`${apiBase()}/api/v1/templates`, { headers: authHeaders });
  expect(templatesRes.ok(), 'templates list').toBeTruthy();
  const templatesAll = await templatesRes.json() as Array<{ id: string; status: string }>;
  const template = templatesAll.find((t) => t.status === 'published');
  test.skip(!template, 'no published template in seed → skipping partner intake smoke');
  const tpl = template!;

  const usersRes = await request.get(`${apiBase()}/api/v1/tenant/users`, { headers: authHeaders });
  expect(usersRes.ok(), 'users list').toBeTruthy();
  const users = await usersRes.json() as Array<{ id: string; email: string; role: string }>;
  const owner = users.find((u) => u.email === SEED.rep.email)
    ?? users.find((u) => u.role === 'sales_employee')
    ?? users.find((u) => u.role === 'admin');
  test.skip(!owner, 'no eligible sales owner in seed → skipping');

  // Tenant defaults: set them so the intake endpoint has a fallback.
  await request.patch(`${apiBase()}/api/v1/tenant/me`, {
    headers: authHeaders,
    data: { defaultTemplateId: tpl.id, defaultSalesOwnerId: owner!.id },
  });

  // 2. Mint a partner token.
  const cleanupNames = ['E2E Intake Partner'];
  const listBefore = await (await request.get(`${apiBase()}/api/v1/tenant/partner-tokens`,
    { headers: authHeaders })).json() as Array<{ id: string; name: string; status: string }>;
  for (const r of listBefore) {
    if (cleanupNames.includes(r.name) && r.status === 'active') {
      await request.delete(`${apiBase()}/api/v1/tenant/partner-tokens/${r.id}`, { headers: authHeaders });
    }
  }
  const createRes = await request.post(`${apiBase()}/api/v1/tenant/partner-tokens`, {
    headers: authHeaders,
    data: { name: cleanupNames[0] },
  });
  expect(createRes.status()).toBe(201);
  const { partner, token } = await createRes.json() as { partner: { id: string }; token: string };

  // 3. POST as the partner — note: no `/api/v1` prefix; partner-intake
  //    lives at the root.
  const intakeRes = await request.post(`${apiBase()}/partner-intake/${token}`, {
    multipart: {
      clientEmail: 'leadsmoke@northwind.example',
      name: 'E2E intake — Northwind',
      bodyText: 'Smoke test brief: we need a VAPT on three web apps with API testing. Compliance is SOC2 Type II.',
    },
  });
  expect(intakeRes.status(), 'partner intake response').toBe(201);
  const intake = await intakeRes.json() as {
    engagementId: string;
    status: string;
    source: string;
  };
  expect(intake.status).toBe('issued');
  expect(intake.source).toBe('partner_api');

  // 4. Verify on the opportunities list — should appear with source.
  const listRes = await request.get(`${apiBase()}/api/v1/opportunities`, { headers: authHeaders });
  expect(listRes.ok()).toBeTruthy();
  const list = await listRes.json() as Array<{
    id: string;
    source?: string;
    partnerName?: string | null;
    clientEmail: string;
  }>;
  const ours = list.find((e) => e.id === intake.engagementId);
  expect(ours, 'created engagement not found on list').toBeTruthy();
  expect(ours!.source).toBe('partner_api');
  expect(ours!.partnerName).toBe(cleanupNames[0]);
  expect(ours!.clientEmail).toBe('leadsmoke@northwind.example');

  // 5. Cleanup.
  await request.delete(`${apiBase()}/api/v1/tenant/partner-tokens/${partner.id}`, { headers: authHeaders });
});
