/**
 * Pricing engine spec — runs the pure `computeBasePrice` function against
 * the canonical CSaaS rate card fixture and asserts every line item.
 *
 * The PDF's worked example (§3.3) is the load-bearing case here:
 *   Web App — 75 pages, grey box, external          → 25,000
 *   Web App — 22 pages, black box, external         →  7,000
 *   Mobile Android — 60 screens, grey APK, external → 35,000
 *   APIs — 35, external                             → 25,000
 *                                                    ───────
 *   Base total                                       92,000
 *
 * Plus boundary cases the design has to get right or the proposal lies:
 *   • range_min boundary (a value of 31 lands in 31-50, not 0-30)
 *   • methodology axis (grey vs black box on same dimension)
 *   • customer_type axis (internal vs external)
 *   • open-ended top tier (1500 APIs lands in "1000 & above")
 *   • open-priced services emit manual_quote_required without a number
 *   • unknown service lines emit `unmatched`, not silently zero
 */

import { describe, it, expect } from 'vitest';
import { computeBasePrice, type ScopedEntity } from '@rhud/shared';
import { buildCsaasRateCardFixture } from './csaas-rate-card.fixture.js';

const RATE_CARD = buildCsaasRateCardFixture({
  rateCardId: 'rc-csaas-test',
  tenantId: 'tenant-test',
  ids: 'deterministic',
});

describe('computeBasePrice (CSaaS rate card)', () => {
  it('matches the PDF §3.3 worked example to the rupee', () => {
    const scope: ScopedEntity[] = [
      { entityId: 'wa_1', serviceLineSlug: 'vapt_web_app',         dimensions: { pages: 75 },    methodology: 'grey_box',     customerType: 'external' },
      { entityId: 'wa_2', serviceLineSlug: 'vapt_web_app',         dimensions: { pages: 22 },    methodology: 'black_box',    customerType: 'external' },
      { entityId: 'ma_1', serviceLineSlug: 'vapt_mobile_android',  dimensions: { screens: 60 },  methodology: 'grey_box_apk', customerType: 'external' },
      { entityId: 'api_1', serviceLineSlug: 'vapt_api',            dimensions: { apis: 35 },     customerType: 'external' },
    ];
    const result = computeBasePrice(RATE_CARD, scope);

    expect(result.totalCents).toBe(92_000_00);
    expect(result.currency).toBe('INR');
    expect(result.hasManualQuoteRequired).toBe(false);
    expect(result.hasUnmatched).toBe(false);

    const byEntity = Object.fromEntries(result.lines.map((l) => [l.entityId, l]));
    expect(byEntity['wa_1']!.priceCents).toBe(25_000_00);
    expect(byEntity['wa_1']!.tierLabel).toBe('51-100');
    expect(byEntity['wa_2']!.priceCents).toBe(7_000_00);
    expect(byEntity['wa_2']!.tierLabel).toBe('0-30');
    expect(byEntity['ma_1']!.priceCents).toBe(35_000_00);
    expect(byEntity['ma_1']!.tierLabel).toBe('50 & Above');
    expect(byEntity['api_1']!.priceCents).toBe(25_000_00);
    expect(byEntity['api_1']!.tierLabel).toBe('21-50');
  });

  it('range_min boundary picks the higher tier (a 31-page web app costs 20k external grey)', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'wa_b',
      serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 31 },
      methodology: 'grey_box',
      customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(20_000_00);
    expect(r.lines[0]!.tierLabel).toBe('31-50');
  });

  it('methodology axis: same dimension, different methodology, different price', () => {
    const grey = computeBasePrice(RATE_CARD, [{
      entityId: 'g', serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 75 }, methodology: 'grey_box', customerType: 'external',
    }]);
    const black = computeBasePrice(RATE_CARD, [{
      entityId: 'b', serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 75 }, methodology: 'black_box', customerType: 'external',
    }]);
    expect(grey.lines[0]!.priceCents).toBe(25_000_00);
    expect(black.lines[0]!.priceCents).toBe(17_000_00);
  });

  it('customer_type axis: internal pricing comes back lower than external', () => {
    const internal = computeBasePrice(RATE_CARD, [{
      entityId: 'i', serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 75 }, methodology: 'grey_box', customerType: 'internal',
    }]);
    const external = computeBasePrice(RATE_CARD, [{
      entityId: 'e', serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 75 }, methodology: 'grey_box', customerType: 'external',
    }]);
    expect(internal.lines[0]!.priceCents).toBeLessThan(external.lines[0]!.priceCents);
    expect(internal.lines[0]!.priceCents).toBe(20_000_00);
  });

  it('open-ended top tier: 1500 APIs → "1000 & above" external price', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'apis_huge', serviceLineSlug: 'vapt_api',
      dimensions: { apis: 1500 }, customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(65_000_00);
    expect(r.lines[0]!.tierLabel).toBe('1000 & above');
  });

  it('null methodology in tier acts as a wildcard (APIs single-axis)', () => {
    // The caller didn't specify methodology and tiers store null → match.
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'apis_no_method', serviceLineSlug: 'vapt_api',
      dimensions: { apis: 35 }, customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(25_000_00);
  });

  it('open-priced services emit manual_quote_required, no price', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'soc2', serviceLineSlug: 'soc_ii',
      dimensions: {}, customerType: 'external',
    }]);
    expect(r.totalCents).toBe(0);
    expect(r.hasManualQuoteRequired).toBe(true);
    expect(r.lines[0]!.manualQuoteRequired).toBe(true);
    expect(r.lines[0]!.serviceLineName).toBe('SOC II');
  });

  it('unknown service line emits unmatched rather than silently zeroing', () => {
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'mystery', serviceLineSlug: 'made_up',
      dimensions: { pages: 5 }, methodology: 'grey_box', customerType: 'external',
    }]);
    expect(r.totalCents).toBe(0);
    expect(r.hasUnmatched).toBe(true);
    expect(r.lines[0]!.unmatched?.reason).toContain('unknown service line');
  });

  it('emits no_matching_tier when the dimension lands outside any range (e.g. methodology mismatch)', () => {
    // Tiers exist for grey_box and black_box only on web app; ask for a
    // bogus methodology and expect a clean unmatched line.
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'bogus', serviceLineSlug: 'vapt_web_app',
      dimensions: { pages: 75 }, methodology: 'red_team', customerType: 'external',
    }]);
    expect(r.lines[0]!.unmatched?.reason).toBe('no_matching_tier');
    expect(r.hasUnmatched).toBe(true);
  });

  it('network device service line: per-device rate × N is implicit (one tier per service line)', () => {
    // Today the device-priced service lines have a single open-ended
    // tier — the price returned is the per-device rate. Stage 1 will
    // pre-multiply by count when the gathering form provides one;
    // until then this asserts the unit price flows through cleanly.
    const r = computeBasePrice(RATE_CARD, [{
      entityId: 'srv1', serviceLineSlug: 'net_servers_pt',
      dimensions: { devices: 12 }, methodology: 'pt', customerType: 'external',
    }]);
    expect(r.lines[0]!.priceCents).toBe(3_500_00);
    expect(r.lines[0]!.tierLabel).toBe('per device');
  });
});
