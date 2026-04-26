/**
 * Parser regression — confirms the structural pass over the CSaaS
 * sample produces tiers that price the PDF §3.3 worked example to the
 * same total as the hand-crafted fixture.
 *
 * The xlsx file lives at the repo root; this spec reads it directly so
 * we catch regressions if the source partner edits the rate card.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { computeBasePrice, type RateCard, type ScopedEntity } from '@rhud/shared';
import { parseCsaasRateCard } from './rate-card.parser.js';

const SAMPLE = resolve(__dirname, '../../../../Rate Card (Template)_CSaaS Partner.xlsx');

function loadMatrix(): string[][] {
  const wb = XLSX.read(readFileSync(SAMPLE), { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]!]!;
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1, raw: false, defval: '', blankrows: false,
  });
  return rows.map((r) => r.map((c) => String(c ?? '')));
}

function asRateCard(draftLines: ReturnType<typeof parseCsaasRateCard>['draft']): RateCard {
  return {
    id: 'parsed',
    tenantId: 't',
    name: draftLines.name,
    version: 1,
    status: 'draft',
    currency: 'INR',
    serviceLines: draftLines.serviceLines.map((sl: typeof draftLines.serviceLines[number], i: number) => ({
      id: `sl-${i}`,
      slug: sl.slug,
      displayName: sl.displayName,
      scopeUnit: sl.scopeUnit,
      pricingModel: 'tier_lookup' as const,
      position: sl.position ?? i,
      tiers: sl.tiers.map((t: typeof sl.tiers[number], j: number) => ({
        id: `t-${i}-${j}`,
        rangeMin: t.rangeMin,
        rangeMax: t.rangeMax ?? null,
        methodology: t.methodology ?? null,
        customerType: t.customerType,
        priceCents: t.priceCents,
        displayLabel: t.displayLabel ?? null,
      })),
    })),
    openPricedServices: (draftLines.openPricedServices ?? []).map(
      (o: NonNullable<typeof draftLines.openPricedServices>[number], i: number) => ({
        id: `op-${i}`,
        slug: o.slug,
        displayName: o.displayName,
        category: o.category ?? null,
        position: i,
      }),
    ),
  };
}

describe('parseCsaasRateCard (Phase 2 layer 1)', () => {
  const matrix = loadMatrix();
  const { draft, warnings } = parseCsaasRateCard(matrix, { name: 'CSaaS Partner — Rate Card' });
  const rateCard = asRateCard(draft);

  it('extracts the expected service lines', () => {
    const slugs = rateCard.serviceLines.map((s) => s.slug);
    expect(slugs).toContain('vapt_web_app');
    expect(slugs.some((s) => s.startsWith('vapt_mobile'))).toBe(true);
    expect(slugs).toContain('vapt_apis');
    expect(slugs).toContain('source_code_review');
    // Network lines are split per device-class × (VA|PT).
    expect(slugs.filter((s) => s.startsWith('net_')).length).toBeGreaterThan(0);
  });

  it('extracts open-priced services (SOC II / ISO 27001 / SEBI CSCR)', () => {
    const names = rateCard.openPricedServices.map((o) => o.displayName.toLowerCase());
    expect(names.some((n) => n.includes('soc ii'))).toBe(true);
    expect(names.some((n) => n.includes('iso 27001'))).toBe(true);
    expect(names.some((n) => n.includes('sebi cscr'))).toBe(true);
  });

  it('the parsed card prices the PDF §3.3 worked example to ₹92,000', () => {
    // The parser may name service-line slugs slightly differently from
    // the hand fixture (e.g. vapt_apis vs vapt_api). Look up by display
    // name to stay robust.
    const findSlug = (substr: string) =>
      rateCard.serviceLines.find((s) => s.displayName.toLowerCase().includes(substr))?.slug;

    const webSlug = findSlug('web app')!;
    const androidSlug = findSlug('android')!;
    const apiSlug = findSlug("api")!;
    expect(webSlug).toBeTruthy();
    expect(androidSlug).toBeTruthy();
    expect(apiSlug).toBeTruthy();

    const scope: ScopedEntity[] = [
      { entityId: 'wa_1', serviceLineSlug: webSlug,     dimensions: { pages: 75 },   methodology: 'grey_box',     customerType: 'external' },
      { entityId: 'wa_2', serviceLineSlug: webSlug,     dimensions: { pages: 22 },   methodology: 'black_box',    customerType: 'external' },
      { entityId: 'ma_1', serviceLineSlug: androidSlug, dimensions: { screens: 60 }, methodology: 'grey_box_apk', customerType: 'external' },
      { entityId: 'api_1', serviceLineSlug: apiSlug,    dimensions: { apis: 35 },                                  customerType: 'external' },
    ];
    const result = computeBasePrice(rateCard, scope);

    expect(result.hasUnmatched).toBe(false);
    expect(result.totalCents).toBe(92_000_00);
  });

  it('produces a finite warnings list rather than throwing on edge cells', () => {
    expect(Array.isArray(warnings)).toBe(true);
    // We allow a few warnings (the source has empty tier rows + the
    // thick-client section's last tier "200 & Above" has the same
    // shape). They should all be informational, not fatal.
    expect(warnings.length).toBeLessThan(50);
  });
});
