/**
 * Prophaze rate card smoke tests.
 *
 * Anchors the per-unit pricing math against worked examples that match
 * the source pricing notes. If any of these break, either the fixture
 * has drifted from the notes or `computeBasePrice` lost its per_unit
 * branch.
 */

import { describe, it, expect } from 'vitest';
import { computeBasePrice, type ScopedEntity } from '@rhud/shared';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';

const RATE_CARD = buildProphazeRateCardFixture({
  rateCardId: 'rc-prophaze-test',
  tenantId: 'tenant-test',
  ids: 'deterministic',
});

describe('Prophaze rate card — per-unit drivers', () => {
  it('web app dynamic pages: 29 pages × ₹100 = ₹2,900 (Low bracket)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'wa_dyn',
      serviceLineSlug: 'vapt_web_app_dynamic_pages',
      dimensions: { pages: 29 },
      methodology: 'black_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(2_900_00);
    expect(r.lines[0]!.tierLabel).toBe('Low (15–20)');
  });

  it('api endpoints: 23 endpoints × ₹1,300 = ₹29,900 (16–25 bracket)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'api_eps',
      serviceLineSlug: 'vapt_api_endpoints',
      dimensions: { apis: 23 },
      methodology: 'black_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(29_900_00);
    expect(r.lines[0]!.tierLabel).toBe('16–25 endpoints');
  });

  it('Prophaze xlsx-shaped scope (29 web pages + 23 api endpoints) totals ₹32,800', () => {
    const r = computeBasePrice(RATE_CARD, [
      {
        entityId: 'web_pages', serviceLineSlug: 'vapt_web_app_dynamic_pages',
        dimensions: { pages: 29 }, methodology: 'black_box', customerType: 'external',
      },
      {
        entityId: 'api_eps', serviceLineSlug: 'vapt_api_endpoints',
        dimensions: { apis: 23 }, methodology: 'black_box', customerType: 'external',
      },
    ]);
    expect(r.totalCents).toBe(32_800_00);
    expect(r.hasManualQuoteRequired).toBe(false);
    expect(r.hasUnmatched).toBe(false);
  });

  it('grey-box internal: 8 roles × ₹4,000 = ₹32,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'roles',
      serviceLineSlug: 'vapt_web_app_roles',
      dimensions: { other: 8 },
      methodology: 'grey_box',
      customerType: 'internal',
    }]);
    expect(r.lines[0]!.priceCents).toBe(32_000_00);
  });

  it('mobile screens: 12 screens × ₹1,800 = ₹21,600 (10–15 bracket)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'mob',
      serviceLineSlug: 'vapt_mobile_ios_screens',
      dimensions: { screens: 12 },
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(21_600_00);
  });
});

describe('Prophaze rate card — flat drivers', () => {
  it('IDS: scope=1 → flat ₹10,000 (price independent of scope)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'ids',
      serviceLineSlug: 'vapt_network_ids',
      dimensions: { devices: 1 },
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(10_000_00);
  });

  it('DLP: flat ₹50,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'dlp',
      serviceLineSlug: 'vapt_network_dlp',
      dimensions: { devices: 1 },
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(50_000_00);
  });

  it('IAM: binary, flat ₹30,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'iam',
      serviceLineSlug: 'vapt_cloud_iam',
      dimensions: { other: 1 },
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(30_000_00);
  });
});

describe('Prophaze rate card — source code review (LOC step function)', () => {
  it('1 lakh LOC → ₹60,000 base', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'src',
      serviceLineSlug: 'vapt_web_app_source_code_backend',
      dimensions: { loc: 100_000 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(60_000_00);
  });

  it('2 lakh LOC → ₹70,000 (60k + 1×10k)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'src',
      serviceLineSlug: 'vapt_web_app_source_code_backend',
      dimensions: { loc: 200_000 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(70_000_00);
  });

  it('40 lakh LOC → ₹450,000 (60k + 39×10k)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'src',
      serviceLineSlug: 'vapt_web_app_source_code_backend',
      dimensions: { loc: 4_000_000 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(450_000_00);
  });
});

describe('Prophaze rate card — SCA / API code review', () => {
  it('Low bucket (≤70 pages) → ₹100,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'sca',
      serviceLineSlug: 'vapt_web_app_sca',
      dimensions: { pages: 50 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(100_000_00);
  });

  it('Mid bucket (71–180 pages) → ₹200,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'sca',
      serviceLineSlug: 'vapt_web_app_sca',
      dimensions: { pages: 120 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(200_000_00);
  });

  it('High bucket (>180 pages) → ₹400,000', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'sca',
      serviceLineSlug: 'vapt_web_app_sca',
      dimensions: { pages: 300 },
      methodology: 'white_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(400_000_00);
  });
});
