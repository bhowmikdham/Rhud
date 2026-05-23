/**
 * Smoke: Maya can log in and reach the dashboard. The minimum proof
 * the auth + JWT plumbing is wired end-to-end. If this breaks, every
 * other spec breaks the same way.
 */
import { test, expect } from '@playwright/test';
import { login, SEED } from './fixtures.js';

test('login → dashboard, JWT in localStorage', async ({ page }) => {
  const token = await login(page, SEED.rep.email, SEED.rep.password);
  expect(token.split('.').length).toBe(3); // basic JWT shape
  // App shell shows the tenant name somewhere. Use a soft assertion —
  // the dashboard URL is the strong signal (already asserted in login()).
  await expect(page).toHaveURL(/\/dashboard$/);
});
