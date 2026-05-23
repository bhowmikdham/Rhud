/**
 * Phase E — shared E2E helpers.
 *
 * `login(page, email, password)` walks the UI: navigate to /login,
 * fill the form, wait for /dashboard. After it resolves, the JWT is
 * in localStorage under `rhud.token` (same key the production app
 * reads from). Returns that token so tests can drive the API directly
 * for setup steps that don't need UI verification.
 *
 * `apiToken(request, email, password)` skips the UI entirely — useful
 * for tests that only need an authenticated context for HTTP calls.
 *
 * `apiBase()` returns the API URL the tests should hit. Honors the
 * E2E_API_URL env override; defaults to http://localhost:8000 (the
 * dev API port).
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { expect } from '@playwright/test';

export const SEED = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  admin:    { email: 'admin@everlane.test',  password: 'password-dev-only-12' },
  manager:  { email: 'oren@everlane.test',   password: 'password-dev-only-12' },
  rep:      { email: 'maya@everlane.test',   password: 'password-dev-only-12' },
};

export function apiBase(): string {
  return process.env.E2E_API_URL ?? 'http://localhost:8000';
}

export async function login(
  page: Page,
  email: string,
  password: string,
): Promise<string> {
  await page.goto('/login');
  await page.fill('input[type="email"], input[name="email"]', email);
  await page.fill('input[type="password"], input[name="password"]', password);
  await page.click('button[type="submit"]');
  // The app redirects to /dashboard on success; if anything else, the
  // form surfaces the error inline. Wait on the URL to keep the wait
  // robust against various button-label / heading-text changes.
  await page.waitForURL(/\/dashboard$/, { timeout: 15_000 });
  // Resolve the JWT after the redirect lands so tests can also call
  // the API directly with this Authorization header.
  const token = await page.evaluate(() => window.localStorage.getItem('rhud.token'));
  expect(token, 'JWT was not stored in localStorage after login').toBeTruthy();
  return token!;
}

/** Direct API login for setup steps that don't need browser UI. */
export async function apiToken(
  request: APIRequestContext,
  email: string,
  password: string,
): Promise<string> {
  const res = await request.post(`${apiBase()}/api/v1/auth/login`, {
    data: { email, password },
  });
  expect(res.ok(), `auth/login HTTP ${res.status()}`).toBeTruthy();
  const body = await res.json() as { token: string };
  return body.token;
}
