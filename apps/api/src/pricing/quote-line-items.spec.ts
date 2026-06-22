import { describe, it, expect } from 'vitest';
import { effectiveLineItemCents } from './quote-line-items.service.js';

describe('effectiveLineItemCents — percentage discounts track the live base', () => {
  it('recomputes a percentage discount against the CURRENT base, ignoring the stale snapshot', () => {
    // "10% off" stored as -5000 when the base was 50,000. After a re-quote grows
    // the base to 100,000 the discount must become -10,000, not stay -5,000.
    const row = { amountCents: -5000n, percentageBps: 1000 }; // 1000 bps = 10%
    expect(effectiveLineItemCents(row, 100_000)).toBe(-10_000);
    expect(effectiveLineItemCents(row, 50_000)).toBe(-5_000);
  });

  it('returns the stored cents for a fixed-amount row (no percentage)', () => {
    expect(effectiveLineItemCents({ amountCents: 2500n, percentageBps: null }, 100_000)).toBe(2500);
    expect(effectiveLineItemCents({ amountCents: -1234, percentageBps: null }, 100_000)).toBe(-1234);
  });

  it('a percentage discount is always negative regardless of bps sign', () => {
    expect(effectiveLineItemCents({ amountCents: 0n, percentageBps: 2500 }, 80_000)).toBe(-20_000);
    expect(effectiveLineItemCents({ amountCents: 0n, percentageBps: -2500 }, 80_000)).toBe(-20_000);
  });
});
