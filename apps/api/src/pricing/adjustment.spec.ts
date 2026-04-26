/**
 * Stage-3 adjustment kernel — pure function tests.
 *
 * The orchestrator's job is loading inputs + persisting the row; this
 * module proves the math is correct in isolation. Cold-start should
 * always be a no-op regardless of config; rules should pick the right
 * loyalty tier and stack manual modifiers in a stable order.
 */

import { describe, it, expect } from 'vitest';
import {
  composePrediction,
  computeAdjustment,
  selectRegime,
  type AdjustmentResult,
  type BasePriceResult,
  type ClientHistorySnapshot,
  type LoyaltyRule,
  type TenantPricingConfig,
} from '@rhud/shared';

const NO_HISTORY: ClientHistorySnapshot = {
  totalClosedDeals: 0,
  lifetimeValueCents: 0,
  lastCloseAt: null,
};

const HOT_HISTORY: ClientHistorySnapshot = {
  totalClosedDeals: 8,
  lifetimeValueCents: 750_000_00, // ₹7.5M
  lastCloseAt: '2025-12-01T00:00:00.000Z',
};

const baseConfig = (overrides?: Partial<TenantPricingConfig>): TenantPricingConfig => ({
  loyaltyRules: [],
  manualModifiers: [],
  coldStartUntilNClosed: 5,
  rulesUntilNClosed: 30,
  linearUntilNClosed: 100,
  retrainHourUtc: 2,
  ...overrides,
});

const fakeBase: BasePriceResult = {
  rateCardId: 'rc-test',
  rateCardVersion: 1,
  currency: 'INR',
  totalCents: 92_000_00,
  lines: [],
  hasManualQuoteRequired: false,
  hasUnmatched: false,
};

describe('computeAdjustment — cold_start regime', () => {
  it('returns zero adjustment regardless of any rules or history', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'strategic', minLifetimeValueCents: 0, discountPct: -0.20 },
      ],
      manualModifiers: [{ name: 'rush', multiplier: 1.5 }],
    });
    const r = computeAdjustment(fakeBase, 'cold_start', config, HOT_HISTORY);
    expect(r.regime).toBe('cold_start');
    expect(r.adjustmentPct).toBe(0);
    expect(r.drivers).toEqual([]);
  });
});

describe('computeAdjustment — rules regime', () => {
  it('returns zero when no rule matches the client lifetime value', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'strategic', minLifetimeValueCents: 1_000_000_00, discountPct: -0.10 },
      ],
    });
    const r = computeAdjustment(fakeBase, 'rules', config, NO_HISTORY);
    expect(r.adjustmentPct).toBe(0);
    expect(r.drivers).toEqual([]);
  });

  it('applies the matching loyalty rule and reports it as a driver', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'strategic', minLifetimeValueCents: 500_000_00, discountPct: -0.10 },
      ],
    });
    const r = computeAdjustment(fakeBase, 'rules', config, HOT_HISTORY);
    expect(r.adjustmentPct).toBeCloseTo(-0.10);
    expect(r.drivers).toHaveLength(1);
    expect(r.drivers[0]).toMatchObject({
      feature: 'loyalty_strategic',
      weight: -0.10,
      direction: 'discount',
    });
  });

  it('picks the highest-discount rule when multiple match', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'preferred',  minLifetimeValueCents: 100_000_00, discountPct: -0.05 },
        { tier: 'strategic',  minLifetimeValueCents: 500_000_00, discountPct: -0.10 },
        { tier: 'national',   minLifetimeValueCents: 250_000_00, discountPct: -0.07 },
      ],
    });
    const r = computeAdjustment(fakeBase, 'rules', config, HOT_HISTORY);
    expect(r.adjustmentPct).toBeCloseTo(-0.10);
    expect(r.drivers).toHaveLength(1);
    expect(r.drivers[0]!.feature).toBe('loyalty_strategic');
  });

  it('stacks manual modifiers multiplicatively after the loyalty rule', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'strategic', minLifetimeValueCents: 0, discountPct: -0.10 },
      ],
      manualModifiers: [
        { name: 'out_of_hours', multiplier: 1.25 },
      ],
    });
    const r = computeAdjustment(fakeBase, 'rules', config, NO_HISTORY);
    // (1 - 0.10) * 1.25 = 1.125 → +12.5%
    expect(r.adjustmentPct).toBeCloseTo(0.125);
    expect(r.drivers.map((d) => d.feature)).toEqual([
      'loyalty_strategic',
      'modifier_out_of_hours',
    ]);
    expect(r.drivers[1]!.direction).toBe('premium');
  });

  it('picks a premium rule only when no discount rule matches', () => {
    const config = baseConfig({
      loyaltyRules: [
        { tier: 'rush',      minLifetimeValueCents: 0,           discountPct: 0.15 },
        { tier: 'strategic', minLifetimeValueCents: 1_000_000_00, discountPct: -0.10 },
      ],
    });
    const r = computeAdjustment(fakeBase, 'rules', config, NO_HISTORY);
    expect(r.adjustmentPct).toBeCloseTo(0.15);
    expect(r.drivers[0]!.direction).toBe('premium');
  });
});

describe('computeAdjustment — sprint-2 regimes', () => {
  it('throws for linear (not implemented)', () => {
    expect(() =>
      computeAdjustment(fakeBase, 'linear', baseConfig(), NO_HISTORY),
    ).toThrow(/regime_not_implemented/);
  });
  it('throws for boosted (not implemented)', () => {
    expect(() =>
      computeAdjustment(fakeBase, 'boosted', baseConfig(), NO_HISTORY),
    ).toThrow(/regime_not_implemented/);
  });
});

describe('selectRegime', () => {
  const cfg = { coldStartUntilNClosed: 5, rulesUntilNClosed: 30, linearUntilNClosed: 100 };
  it.each([
    [0,   'cold_start'],
    [4,   'cold_start'],
    [5,   'rules'],
    [29,  'rules'],
    [30,  'linear'],
    [99,  'linear'],
    [100, 'boosted'],
    [9999,'boosted'],
  ] as const)('count %i → %s', (count, expected) => {
    expect(selectRegime(count, cfg)).toBe(expected);
  });
});

describe('composePrediction', () => {
  it('cold-start collapses the band onto the base', () => {
    const adj: AdjustmentResult = { regime: 'cold_start', adjustmentPct: 0, drivers: [] };
    const out = composePrediction(fakeBase, adj);
    expect(out.predictedPriceCents).toBe(92_000_00);
    expect(out.bandLowCents).toBe(92_000_00);
    expect(out.bandHighCents).toBe(92_000_00);
    expect(out.adjustmentPct).toBe(0);
  });

  it('rules-mode applies the adjustment and a 10% default band', () => {
    const adj: AdjustmentResult = {
      regime: 'rules',
      adjustmentPct: -0.10,
      drivers: [{ feature: 'loyalty_strategic', weight: -0.10, direction: 'discount' }],
    };
    const out = composePrediction(fakeBase, adj);
    // 92,000 * 0.9 = 82,800; band ±10% of predicted → low 74,520, high 91,080.
    expect(out.predictedPriceCents).toBe(82_800_00);
    expect(out.bandLowCents).toBe(74_520_00);
    expect(out.bandHighCents).toBe(91_080_00);
  });

  it('respects bandPctOverride when caller knows better (e.g. rate-card lock)', () => {
    const adj: AdjustmentResult = { regime: 'rules', adjustmentPct: 0, drivers: [] };
    const out = composePrediction(fakeBase, adj, { bandPctOverride: 0 });
    expect(out.bandLowCents).toBe(out.predictedPriceCents);
    expect(out.bandHighCents).toBe(out.predictedPriceCents);
  });
});
