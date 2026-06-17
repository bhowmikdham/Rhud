/**
 * Regression tests for the heuristic fallback in `inferEntities`
 * (the path taken when the LLM mapper is unavailable / threw / returned
 * zero entities — i.e. cold-start and rate-limited deployments).
 *
 * Headline bug (production, opportunity "Link 18"): a client message
 * listed ONLY `windows_pc_laptop_count: 8`, `firewall_count: 1`,
 * `wifi_router_count: 1`. The heuristic phantom-inferred IDS / IPS / DLP
 * (10k + 10k + 50k) and ballooned the quote to 78,500. Root causes, all
 * fixed and exercised below:
 *
 *   1. Mention-gate matched the broad `network` DOMAIN keyword (aliases
 *      firewall/router) for every network slug — driver tokens now win.
 *   2. Flat binary slugs (IDS/IPS/DLP/IAM) were emitted from numeric
 *      counts via Pass 1 — they are now Pass-2-only (affirmative flag).
 *   3. Short aliases (ids/iam/…) matched INSIDE words (user_ids, miami) —
 *      now matched as whole tokens.
 *   4. `pickScopeValue` borrowed a sibling device's count onto a slug —
 *      scope now must come from a point naming the slug's own driver.
 *   5. `detectBinaryFlags` treated a numeric "1" as "yes" — dropped.
 */

import { describe, it, expect } from 'vitest';
import type { LlmService } from '../llm/llm.service.js';
import {
  RateCardFieldMapperService,
  type ExtractedPointInput,
} from './rate-card-mapper.service.js';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';

// Force the heuristic fallback path: a 'manual' provider makes
// inferEntities skip the LLM entirely, so heuristicInfer runs directly.
const mapper = new RateCardFieldMapperService(
  { getProviderName: async () => 'manual' } as unknown as LlmService,
);
const rateCard = buildProphazeRateCardFixture();

const infer = (points: ExtractedPointInput[]) =>
  mapper.inferEntities('t', points, rateCard);

// The exact extracted points from the "Link 18" opportunity.
const LINK_18_POINTS: ExtractedPointInput[] = [
  { key: 'windows_pc_laptop_count', label: 'PC/Laptop windows (8)', value: '8' },
  { key: 'firewall_count', label: 'Firewall - 1', value: '1' },
  { key: 'wifi_router_count', label: 'WiFi Router - 1', value: '1' },
];

describe('heuristic fallback — phantom network line items (Link 18)', () => {
  it('does NOT phantom-infer IDS/IPS/DLP from a firewall+router-only doc', async () => {
    const slugs = (await infer(LINK_18_POINTS)).map((e) => e.serviceLineSlug);
    expect(slugs).not.toContain('vapt_network_ids');
    expect(slugs).not.toContain('vapt_network_ips');
    expect(slugs).not.toContain('vapt_network_dlp');
  });

  it('still infers the firewall and router that WERE mentioned, at scope 1', async () => {
    const bySlug = new Map((await infer(LINK_18_POINTS)).map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(1);
    expect(bySlug.get('vapt_network_routers')?.scopeValue).toBe(1);
  });

  it('only emits the network slugs actually named in the doc', async () => {
    const networkSlugs = (await infer(LINK_18_POINTS))
      .map((e) => e.serviceLineSlug)
      .filter((s) => s.startsWith('vapt_network_'));
    expect(new Set(networkSlugs)).toEqual(
      new Set(['vapt_network_firewalls', 'vapt_network_routers']),
    );
  });
});

describe('heuristic fallback — category gate (P0c: non-scope fields never yield a count)', () => {
  it('does NOT mine a scope count from an identity field ("Acme, 10 employees")', async () => {
    const points: ExtractedPointInput[] = [
      { key: 'firewall_count', label: 'Firewalls in scope', value: '2', category: 'scope' },
      // An identity point that happens to contain a number must be ignored by
      // the scope picker — pre-P0c "10" could leak onto a device count.
      { key: 'company_name', label: 'Company', value: 'Acme Corp with 10 employees', category: 'identity' },
      { key: 'primary_contact', label: 'Contact', value: 'Jane (x42)', category: 'identity' },
    ];
    const bySlug = new Map((await infer(points)).map((e) => [e.serviceLineSlug, e]));
    // The legitimately-scoped firewalls survive at the right count...
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(2);
    // ...and no entity carries the identity numbers 10 or 42.
    for (const e of bySlug.values()) {
      expect(e.scopeValue).not.toBe(10);
      expect(e.scopeValue).not.toBe(42);
    }
  });

  it('still scopes normally when category is absent (un-categorised input ungated)', async () => {
    const points: ExtractedPointInput[] = [
      { key: 'firewall_count', label: 'Firewall - 3', value: '3' },
    ];
    const bySlug = new Map((await infer(points)).map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(3);
  });
});

describe('heuristic fallback — flat binary slugs (IDS/IPS/DLP/IAM)', () => {
  it('emits IDS only from an affirmative flag (Pass 2), not a raw count', async () => {
    // A numeric "count of IDS devices" must NOT price a flat IDS line...
    const fromCount = (await infer([
      { key: 'ids_devices', label: 'Number of IDS devices', value: '2' },
    ])).map((e) => e.serviceLineSlug);
    expect(fromCount).not.toContain('vapt_network_ids');

    // ...but an affirmative "IDS in scope? yes" still does.
    const fromFlag = (await infer([
      { key: 'ids_in_scope', label: 'Intrusion Detection System (IDS) in scope?', value: 'yes' },
    ])).map((e) => e.serviceLineSlug);
    expect(fromFlag).toContain('vapt_network_ids');
  });

  it('does NOT phantom-infer IDS from the homograph "user IDs"', async () => {
    const slugs = (await infer([
      { key: 'user_ids', label: 'How many user IDs in the system', value: '4200' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).not.toContain('vapt_network_ids');
  });

  it('does NOT phantom-infer IAM from a word merely containing "iam" (miami)', async () => {
    const slugs = (await infer([
      { key: 'miami_offices', label: 'Number of Miami offices', value: '7' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).not.toContain('vapt_cloud_iam');
  });

  it('does NOT read a numeric "1" as an affirmative IPS flag ("Number of public IPs: 1")', async () => {
    const slugs = (await infer([
      { key: 'public_ips', label: 'Number of public IPs', value: '1' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).not.toContain('vapt_network_ips');
  });

  it('still emits IPS from an explicit affirmative flag', async () => {
    const slugs = (await infer([
      { key: 'ips', label: 'IPS deployed?', value: 'yes' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).toContain('vapt_network_ips');
  });
});

describe('heuristic fallback — scope-value borrowing (pickScopeValue)', () => {
  it('does NOT borrow a sibling database count onto the firewall line', async () => {
    const bySlug = new Map((await infer([
      { key: 'db_count', label: 'How many production databases (RDS/postgres)', value: '12' },
      { key: 'firewall_count', label: 'Firewall - 1', value: '1' },
    ])).map((e) => [e.serviceLineSlug, e]));

    // The firewall keeps its OWN count of 1 (was: borrowed 12 → ₹60,000).
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(1);
    // The database count lands on its real owner.
    expect(bySlug.get('vapt_cloud_databases')?.scopeValue).toBe(12);
  });

  it('does NOT borrow a large "host servers" count onto the firewall line', async () => {
    const bySlug = new Map((await infer([
      { key: 'firewall_count', label: 'Firewall', value: '1' },
      { key: 'inventory', label: 'Total host servers in scope', value: '1500' },
    ])).map((e) => [e.serviceLineSlug, e]));

    // Was: firewall scope 1500 → ₹7,500,000.
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(1);
  });

  it('picks up the count when the driver is named only in the answer value', async () => {
    // Free-text Q/A: device type lives in the VALUE, not the label.
    const bySlug = new Map((await infer([
      { key: 'network_devices_in_scope', label: 'What network devices are in scope?', value: '2 firewalls' },
    ])).map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.get('vapt_network_firewalls')?.scopeValue).toBe(2);
  });
});

describe('heuristic fallback — plural acronyms must still match (no under-scoping)', () => {
  it('emits SCA lines for the plural wording "SCAs"', async () => {
    const slugs = (await infer([
      { key: 'scas_pages', label: 'Approx pages requested for SCAs scan', value: '40' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).toContain('vapt_web_app_sca');
    expect(slugs).toContain('vapt_api_sca');
  });

  it('emits the login-modules line for the plural wording "SSOs"', async () => {
    const slugs = (await infer([
      { key: 'customer_type', label: 'Engagement access', value: 'internal' },
      { key: 'ssos', label: 'How many SSOs configured', value: '2' },
    ])).map((e) => e.serviceLineSlug);
    expect(slugs).toContain('vapt_web_app_login_modules');
  });
});
