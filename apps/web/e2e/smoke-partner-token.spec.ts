/**
 * Smoke: an admin can create a partner token via the API. Verifies the
 * tenant-scoped CRUD path plus the one-time plaintext token response.
 *
 * We drive the API directly here (not the UI) for two reasons:
 *   (1) the create modal asks for template + sales-owner overrides,
 *       and we don't want to assert on dropdown contents that depend
 *       on seed data,
 *   (2) the partner-intake spec needs a plaintext token to POST with,
 *       and the UI banner returns it only once (we'd have to scrape).
 *
 * The next spec (smoke-partner-intake) reuses the token created here
 * by sharing a test.describe.serial — Playwright keeps state across
 * tests in the same describe block by default.
 */
import { test, expect } from '@playwright/test';
import { apiBase, apiToken, SEED } from './fixtures.js';

test('admin creates a partner token via /tenant/partner-tokens', async ({ request }) => {
  const jwt = await apiToken(request, SEED.admin.email, SEED.admin.password);

  // Pre-flight: clear any leftover same-name tokens from previous runs.
  // List + revoke any with our test name. Idempotent.
  const list = await request.get(`${apiBase()}/api/v1/tenant/partner-tokens`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(list.ok()).toBeTruthy();
  const existing = (await list.json()) as Array<{ id: string; name: string; status: string }>;
  for (const row of existing) {
    if (row.name === 'E2E Test Partner' && row.status === 'active') {
      await request.delete(`${apiBase()}/api/v1/tenant/partner-tokens/${row.id}`, {
        headers: { authorization: `Bearer ${jwt}` },
      });
    }
  }

  const create = await request.post(`${apiBase()}/api/v1/tenant/partner-tokens`, {
    headers: { authorization: `Bearer ${jwt}` },
    data: { name: 'E2E Test Partner' },
  });
  expect(create.status(), 'create response').toBe(201);
  const body = await create.json() as { partner: { id: string; name: string; status: string }; token: string };
  expect(body.partner.name).toBe('E2E Test Partner');
  expect(body.partner.status).toBe('active');
  // Plaintext token is 32 random bytes base64url — ~43 chars.
  expect(body.token.length).toBeGreaterThanOrEqual(40);

  // Revoke it so the test is idempotent across runs.
  const del = await request.delete(`${apiBase()}/api/v1/tenant/partner-tokens/${body.partner.id}`, {
    headers: { authorization: `Bearer ${jwt}` },
  });
  expect(del.status()).toBe(204);
});
