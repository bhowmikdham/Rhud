/**
 * Smoke: opportunities list loads after login. Doesn't assert on the
 * exact row content (seed data varies); only that the page renders
 * the list shell + responds to navigation. If this fails the tenant
 * scoping + JWT is broken.
 */
import { test, expect } from '@playwright/test';
import { login, SEED } from './fixtures.js';

test('opportunities list renders after login', async ({ page }) => {
  await login(page, SEED.rep.email, SEED.rep.password);
  await page.goto('/opportunities');
  await page.waitForURL(/\/opportunities/, { timeout: 10_000 });
  // Look for either the page title or the empty-state. Either way,
  // the page reached `ready`.
  const heading = page.getByRole('heading', { name: /opportunit/i }).first();
  await expect(heading).toBeVisible({ timeout: 10_000 });
});
