/**
 * Smoke: an admin can set the Phase E inbound defaults via the UI.
 *
 * Navigates to Settings → Inbound email, fills the local part + picks
 * a template + owner, saves, and verifies via GET /tenant/me that the
 * row was updated. Reverts at the end so subsequent runs see a clean
 * starting state.
 */
import { test, expect } from '@playwright/test';
import { login, apiBase, SEED } from './fixtures.js';

test('admin can save inbound email + tenant defaults via Settings', async ({ page, request }) => {
  const token = await login(page, SEED.admin.email, SEED.admin.password);
  const authHeaders = { authorization: `Bearer ${token}` };

  // Snapshot the original values so we restore them at the end —
  // keeps the dev DB tidy if the spec is run repeatedly.
  const meBefore = await (await request.get(`${apiBase()}/api/v1/tenant/me`, { headers: authHeaders })).json() as {
    inboundEmailLocal: string | null;
    defaultTemplateId: string | null;
    defaultSalesOwnerId: string | null;
  };

  // Use a deterministic test-only local so we can roll it back without
  // colliding with another tenant.
  const testLocal = `e2e-inbound-${Date.now() % 100000}`;

  await page.goto('/settings?tab=inbound');
  await page.waitForURL(/\/settings/);

  // Settings panel renders the local-part input first. Find it by
  // placeholder so the test isn't tied to the label DOM ordering.
  const localInput = page.locator('input[placeholder="acme-sales"]').first();
  await expect(localInput).toBeVisible({ timeout: 10_000 });
  await localInput.fill(testLocal);

  // Pick the first available template + sales owner from the dropdowns.
  const templateSelect = page.locator('select').first();
  const optionCount = await templateSelect.locator('option').count();
  test.skip(optionCount < 2, 'no template options to choose; skipping');
  await templateSelect.selectOption({ index: 1 });

  const ownerSelect = page.locator('select').nth(1);
  const ownerOptions = await ownerSelect.locator('option').count();
  test.skip(ownerOptions < 2, 'no owner options to choose; skipping');
  await ownerSelect.selectOption({ index: 1 });

  // Click Save.
  await page.getByRole('button', { name: /save/i }).click();

  // Verify via the API.
  await expect(async () => {
    const me = await (await request.get(`${apiBase()}/api/v1/tenant/me`, { headers: authHeaders })).json() as {
      inboundEmailLocal: string | null;
    };
    expect(me.inboundEmailLocal).toBe(testLocal);
  }).toPass({ timeout: 5000 });

  // Restore.
  await request.patch(`${apiBase()}/api/v1/tenant/me`, {
    headers: authHeaders,
    data: {
      inboundEmailLocal: meBefore.inboundEmailLocal,
      defaultTemplateId: meBefore.defaultTemplateId,
      defaultSalesOwnerId: meBefore.defaultSalesOwnerId,
    },
  });
});
