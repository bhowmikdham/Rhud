/**
 * scope-summary specs.
 *
 * Locks in the human-facing rendering of inferred entities. The Review
 * UI is built directly on top of this output, so regressions here ship
 * straight into the client experience.
 */

import { describe, it, expect } from 'vitest';
import {
  buildScopeSummary,
  type ScopeSummaryEntityInput,
  type RateCard,
  type RateCardServiceLine,
} from '@rhud/shared';

// ── Tiny rate-card builder for tests ──────────────────────────────────────
//
// We don't need real tiers — buildScopeSummary only reads slug +
// displayName + scopeUnit off serviceLines. Keep the test card minimal
// and varied to cover all the domain-classification branches.

function sl(slug: string, displayName: string): RateCardServiceLine {
  return {
    id: `sl-${slug}`,
    slug,
    displayName,
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 0,
    tiers: [],
  };
}

const RATE_CARD: RateCard = {
  id: 'rc-test',
  tenantId: 'tenant-test',
  name: 'Test Rate Card',
  version: 1,
  status: 'published',
  currency: 'INR',
  serviceLines: [
    sl('vapt_web_app_dynamic_pages', 'VAPT — Web App / Dynamic Pages'),
    sl('vapt_web_app_input_fields',  'VAPT — Web App / Input Fields'),
    sl('vapt_web_app_roles',         'VAPT — Web App / Roles'),
    sl('vapt_api_endpoints',         'VAPT — API / Endpoints'),
    sl('vapt_api_roles',             'VAPT — API / Roles'),
    sl('vapt_mobile_ios_screens',    'VAPT — Mobile (iOS) / Screens'),
    sl('vapt_mobile_android_screens','VAPT — Mobile (Android) / Screens'),
    sl('vapt_network_firewalls',     'VAPT — Network / Firewalls'),
    sl('vapt_network_routers',       'VAPT — Network / Routers'),
    sl('vapt_cloud_instances',       'VAPT — Cloud / Instances'),
    sl('vapt_cloud_iam',             'VAPT — Cloud / IAM'),
    // Non-cybersec slug to test the 'other' bucket fallback.
    sl('deep_clean_residential',     'Deep Clean — Residential'),
  ],
  openPricedServices: [],
};

function ent(over: Partial<ScopeSummaryEntityInput>): ScopeSummaryEntityInput {
  return {
    serviceLineSlug: 'vapt_web_app_dynamic_pages',
    scopeValue: 1,
    methodology: null,
    customerType: 'external',
    confidence: 0.9,
    ...over,
  };
}

// ── Empty / floor cases ───────────────────────────────────────────────────

describe('buildScopeSummary — empty paths', () => {
  it('returns isEmpty=true for zero entities', () => {
    const out = buildScopeSummary([], RATE_CARD);
    expect(out.isEmpty).toBe(true);
    expect(out.totalItems).toBe(0);
    expect(out.groups).toEqual([]);
  });

  it('drops entities below the confidence floor (default 0.6)', () => {
    const out = buildScopeSummary(
      [ent({ confidence: 0.5 }), ent({ confidence: 0.4, scopeValue: 5 })],
      RATE_CARD,
    );
    expect(out.isEmpty).toBe(true);
  });

  it('respects custom confidence floor', () => {
    const out = buildScopeSummary(
      [ent({ confidence: 0.5, scopeValue: 12 })],
      RATE_CARD,
      { confidenceFloor: 0.4 },
    );
    expect(out.isEmpty).toBe(false);
    expect(out.totalItems).toBe(1);
  });

  it('skips entities for slugs not in the rate card', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'totally_made_up' })],
      RATE_CARD,
    );
    expect(out.isEmpty).toBe(true);
  });
});

// ── Grouping by appId ─────────────────────────────────────────────────────

describe('buildScopeSummary — appId grouping', () => {
  it('collates same-appId entities into ONE item with multiple bullets', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 60, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_roles',         scopeValue: 3,  appId: 'web_app_1' }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    expect(out.groups).toHaveLength(1);
    const group = out.groups[0]!;
    expect(group.domain).toBe('web_app');
    expect(group.label).toBe('Web Applications');
    expect(group.items).toHaveLength(1);
    const item = group.items[0]!;
    expect(item.title).toBe('Web App 1');
    // 3 driver bullets, one per slug.
    expect(item.bullets).toHaveLength(3);
    expect(item.bullets.some((b) => b.includes('29'))).toBe(true);
    expect(item.bullets.some((b) => b.includes('60'))).toBe(true);
    expect(item.bullets.some((b) => b.includes('3'))).toBe(true);
  });

  it('emits separate items for separate appIds within the same domain', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, appId: 'web_app_2' }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    const group = out.groups[0]!;
    expect(group.items).toHaveLength(2);
    expect(group.items[0]!.title).toBe('Web App 1');
    expect(group.items[1]!.title).toBe('Web App 2');
  });

  it('sorts items by appId numerically (web_app_2 before web_app_10)', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 1, appId: 'web_app_10' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 1, appId: 'web_app_2'  }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 1, appId: 'web_app_1'  }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    const titles = out.groups[0]!.items.map((i) => i.title);
    expect(titles).toEqual(['Web App 1', 'Web App 2', 'Web App 10']);
  });

  it('shows API as the appId stem for api_N appIds', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, appId: 'api_1' }),
      ent({ serviceLineSlug: 'vapt_api_roles',     scopeValue: 2,  appId: 'api_1' }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    const group = out.groups[0]!;
    expect(group.label).toBe('APIs');
    expect(group.items[0]!.title).toBe('API 1');
    expect(group.items[0]!.bullets).toContain('23 endpoints');
  });
});

// ── Solo (no-appId) entities ──────────────────────────────────────────────

describe('buildScopeSummary — solo entities (no appId)', () => {
  it('emits one item per slug for network domain (each device class is solo)', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_network_firewalls', scopeValue: 5 }),
      ent({ serviceLineSlug: 'vapt_network_routers',   scopeValue: 12 }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.domain).toBe('network');
    expect(out.groups[0]!.items).toHaveLength(2);
    expect(out.groups[0]!.items[0]!.title).toBe('VAPT — Network / Firewalls');
    expect(out.groups[0]!.items[1]!.title).toBe('VAPT — Network / Routers');
  });

  it('emits one item per slug for cloud domain too', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_cloud_instances', scopeValue: 1 }),
      ent({ serviceLineSlug: 'vapt_cloud_iam',       scopeValue: 1 }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.domain).toBe('cloud');
    expect(out.groups[0]!.items).toHaveLength(2);
  });
});

// ── Mixed multi-domain ────────────────────────────────────────────────────

describe('buildScopeSummary — mixed engagement', () => {
  it('orders groups: web → api → mobile → network → cloud → other', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_cloud_instances',         scopeValue: 1 }),
      ent({ serviceLineSlug: 'vapt_network_firewalls',       scopeValue: 5 }),
      ent({ serviceLineSlug: 'vapt_api_endpoints',           scopeValue: 23, appId: 'api_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages',   scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_mobile_ios_screens',      scopeValue: 8,  appId: 'ios_app_1' }),
      ent({ serviceLineSlug: 'vapt_mobile_android_screens',  scopeValue: 8,  appId: 'android_app_1' }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    const domains = out.groups.map((g) => g.domain);
    expect(domains).toEqual(['web_app', 'api', 'mobile_ios', 'mobile_android', 'network', 'cloud']);
  });

  it('totalItems counts items across all groups', () => {
    const entities = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages',  scopeValue: 1, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_api_endpoints',          scopeValue: 1, appId: 'api_1' }),
      ent({ serviceLineSlug: 'vapt_network_firewalls',      scopeValue: 1 }),
      ent({ serviceLineSlug: 'vapt_network_routers',        scopeValue: 1 }),
    ];
    const out = buildScopeSummary(entities, RATE_CARD);
    expect(out.totalItems).toBe(4); // 1 web app + 1 api + 2 network items
  });
});

// ── Bullet formatting ─────────────────────────────────────────────────────

describe('buildScopeSummary — bullet text', () => {
  it('humanises the slash-suffix of displayName as the driver label', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' })],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.bullets[0]).toBe('29 dynamic pages');
  });

  it('singular bullet when scope=1', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 1, appId: 'web_app_1' })],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.bullets[0]).toBe('1 dynamic pages');
  });

  it('preserves already-pluralised driver labels (ends in s)', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'vapt_network_routers', scopeValue: 12 })],
      RATE_CARD,
    );
    // "VAPT — Network / Routers" → "Routers" → "12 routers"
    expect(out.groups[0]!.items[0]!.bullets[0]).toBe('12 routers');
  });
});

// ── Methodology subtitle ──────────────────────────────────────────────────

describe('buildScopeSummary — methodology subtitle', () => {
  it('renders methodology · customerType when methodology is set', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, methodology: 'black_box', appId: 'api_1' })],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.subtitle).toBe('black-box · external');
  });

  it('omits subtitle when methodology is null (single-axis lines)', () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'vapt_network_firewalls', scopeValue: 5, methodology: null })],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.subtitle).toBeUndefined();
  });

  it('uses first non-null methodology when collating mixed entries', () => {
    // A grouped item with one black_box and one null entity should
    // pick the black_box one for the subtitle.
    const out = buildScopeSummary(
      [
        ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 1, methodology: null,        appId: 'web_app_1' }),
        ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 1, methodology: 'black_box', appId: 'web_app_1' }),
      ],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.subtitle).toBe('black-box · external');
  });
});

// ── Source files ──────────────────────────────────────────────────────────

describe('buildScopeSummary — source file dedup', () => {
  it('lists each source file once even when multiple entities reference it', () => {
    const out = buildScopeSummary(
      [
        ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1', sourceFile: 'doc.xlsx' }),
        ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 60, appId: 'web_app_1', sourceFile: 'doc.xlsx' }),
      ],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.sourceFiles).toEqual(['doc.xlsx']);
  });

  it('lists multiple distinct source files', () => {
    const out = buildScopeSummary(
      [
        ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1', sourceFile: 'a.xlsx' }),
        ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 60, appId: 'web_app_1', sourceFile: 'b.xlsx' }),
      ],
      RATE_CARD,
    );
    expect(out.groups[0]!.items[0]!.sourceFiles).toEqual(['a.xlsx', 'b.xlsx']);
  });
});

// ── Cross-domain "other" fallback ─────────────────────────────────────────

describe('buildScopeSummary — non-cybersec rate cards', () => {
  it("classifies non-matching slugs as 'other' so nothing is silently dropped", () => {
    const out = buildScopeSummary(
      [ent({ serviceLineSlug: 'deep_clean_residential', scopeValue: 3500 })],
      RATE_CARD,
    );
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]!.domain).toBe('other');
    expect(out.groups[0]!.label).toBe('Other');
    expect(out.groups[0]!.items[0]!.title).toBe('Deep Clean — Residential');
  });
});
