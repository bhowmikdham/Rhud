/**
 * Phase E — Playwright E2E config.
 *
 * Local dev: run `pnpm api:dev` + `pnpm web:dev` in two terminals, then
 * `pnpm --filter @rhud/web test`. The config assumes:
 *   - API on http://localhost:8000
 *   - Web on http://localhost:3000
 *   - Tenant A seeded with `pnpm --filter @rhud/api seed`
 *
 * CI: the workflow boots the API + Web with `next start` before running
 * tests. We don't use Playwright's `webServer` to spawn them because the
 * server processes are configured via env (DATABASE_URL, JWT_SECRET,
 * etc.) and the CI step composes that env carefully.
 *
 * Five specs cover the critical lifecycle:
 *   - smoke-login: log in as Maya, see dashboard.
 *   - smoke-issue-link: create opportunity, see /g/ link.
 *   - smoke-gathering: walk gathering loop, submit, see status flip.
 *   - smoke-partner-intake: create token, POST, see chip on list.
 *   - smoke-docx-export: approve flow → click DOCX button → verify
 *     Content-Type.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  // Single shared DB → serial execution avoids cross-test interference.
  // If we ever shard out per-tenant fixtures, flip this on.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:3000',
    // Captured only on failure to keep run dirs small. CI uploads
    // playwright-report when any spec fails.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Each test ignores the previous JWT — fixtures.login() sets it
    // fresh. Keep storageState empty to start.
    storageState: { cookies: [], origins: [] },
  },
});
