import { describe, it, expect } from 'vitest';
import { applyTransform, buildEngagementPatch } from './odoo.mapping.js';

describe('applyTransform — money transforms have a correct inverse', () => {
  it('cents_to_currency divides by 100 (outbound)', () => {
    expect(applyTransform(5_000_000n, 'cents_to_currency')).toBe(50_000);
    expect(applyTransform(5_000_000, 'cents_to_currency')).toBe(50_000);
  });

  it('currency_to_cents multiplies by 100 (inbound inverse)', () => {
    expect(applyTransform(50_000, 'currency_to_cents')).toBe(5_000_000);
    expect(applyTransform('50000.00', 'currency_to_cents')).toBe(5_000_000);
    expect(applyTransform('not-a-number', 'currency_to_cents')).toBe(0);
  });
});

describe('buildEngagementPatch — inbound money mapping cannot corrupt', () => {
  const pullRow = (transform: string | null) => ({
    rhudEntity: 'engagement',
    rhudField: 'approvedPriceCents',
    odooModel: 'crm.lead',
    odooField: 'expected_revenue',
    transform,
    direction: 'both' as const,
  });

  it('SKIPS an outbound-only cents_to_currency on a pull/both row (no 100x divide)', () => {
    // Odoo gives whole currency 50000; cents_to_currency would corrupt it to 500.
    const patch = buildEngagementPatch([pullRow('cents_to_currency')], { expected_revenue: 50_000 }, 'crm.lead');
    expect('approvedPriceCents' in patch).toBe(false); // skipped, not corrupted
  });

  it('applies currency_to_cents correctly on a pull/both row', () => {
    const patch = buildEngagementPatch([pullRow('currency_to_cents')], { expected_revenue: 50_000 }, 'crm.lead');
    expect(patch.approvedPriceCents).toBe(5_000_000);
  });
});
