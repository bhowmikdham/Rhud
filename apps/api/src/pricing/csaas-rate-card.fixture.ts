/**
 * Canonical encoding of the sample "Rate Card (Template) — CSaaS Partner.xlsx".
 *
 * Used as:
 *   • A test fixture so the pricing-engine math is verifiable against
 *     the same numbers the partner's pricing team works from.
 *   • A seed for new tenants in development — handy when you want a
 *     real-world-shaped rate card without going through the upload
 *     pipeline (which lands in a follow-up sprint).
 *
 * Anything that's not present in the source xlsx (slugs, scope_unit,
 * methodology codes) was chosen here. Keep the codes stable: templates
 * reference service_line.slug + methodology to bridge gathering answers
 * to tier lookup, so renaming a slug breaks every template that uses it.
 */

import type {
  CustomerType,
  Methodology,
  RateCard,
  RateCardOpenPricedService,
  RateCardServiceLine,
  RateCardTier,
} from '@rhud/shared';

const tier = (
  partial: Omit<RateCardTier, 'id'> & { id?: string },
): Omit<RateCardTier, 'id'> & { id?: string } => partial;

interface FixtureServiceLine {
  slug: string;
  displayName: string;
  scopeUnit: RateCardServiceLine['scopeUnit'];
  position: number;
  tiers: Array<{
    rangeMin: number;
    rangeMax: number | null;
    methodology: Methodology;
    customerType: CustomerType;
    /** In rupees — the fixture multiplies ×100 to land in price_cents. */
    priceRupees: number;
    displayLabel?: string | null;
  }>;
}

const SERVICE_LINES: FixtureServiceLine[] = [
  {
    slug: 'vapt_web_app',
    displayName: 'VAPT — Web Application',
    scopeUnit: 'pages',
    position: 0,
    tiers: [
      // Grey Box · internal
      { rangeMin: 0,   rangeMax: 30,   methodology: 'grey_box',  customerType: 'internal', priceRupees: 10000, displayLabel: '0 - 30' },
      { rangeMin: 31,  rangeMax: 50,   methodology: 'grey_box',  customerType: 'internal', priceRupees: 15000, displayLabel: '31-50' },
      { rangeMin: 51,  rangeMax: 100,  methodology: 'grey_box',  customerType: 'internal', priceRupees: 20000, displayLabel: '51-100' },
      { rangeMin: 101, rangeMax: 150,  methodology: 'grey_box',  customerType: 'internal', priceRupees: 25000, displayLabel: '101-150' },
      { rangeMin: 151, rangeMax: 200,  methodology: 'grey_box',  customerType: 'internal', priceRupees: 30000, displayLabel: '151-200' },
      { rangeMin: 201, rangeMax: null, methodology: 'grey_box',  customerType: 'internal', priceRupees: 35000, displayLabel: '200 & Above' },
      // Grey Box · external
      { rangeMin: 0,   rangeMax: 30,   methodology: 'grey_box',  customerType: 'external', priceRupees: 15000, displayLabel: '0-30' },
      { rangeMin: 31,  rangeMax: 50,   methodology: 'grey_box',  customerType: 'external', priceRupees: 20000, displayLabel: '31-50' },
      { rangeMin: 51,  rangeMax: 100,  methodology: 'grey_box',  customerType: 'external', priceRupees: 25000, displayLabel: '51-100' },
      { rangeMin: 101, rangeMax: 150,  methodology: 'grey_box',  customerType: 'external', priceRupees: 30000, displayLabel: '101-150' },
      { rangeMin: 151, rangeMax: 200,  methodology: 'grey_box',  customerType: 'external', priceRupees: 35000, displayLabel: '151-200' },
      { rangeMin: 201, rangeMax: null, methodology: 'grey_box',  customerType: 'external', priceRupees: 40000, displayLabel: '200 & Above' },
      // Black Box · internal
      { rangeMin: 0,   rangeMax: 30,   methodology: 'black_box', customerType: 'internal', priceRupees: 5000,  displayLabel: '0 - 30' },
      { rangeMin: 31,  rangeMax: 50,   methodology: 'black_box', customerType: 'internal', priceRupees: 10000, displayLabel: '31-50' },
      { rangeMin: 51,  rangeMax: 100,  methodology: 'black_box', customerType: 'internal', priceRupees: 15000, displayLabel: '51-100' },
      { rangeMin: 101, rangeMax: 150,  methodology: 'black_box', customerType: 'internal', priceRupees: 20000, displayLabel: '101-150' },
      { rangeMin: 151, rangeMax: 200,  methodology: 'black_box', customerType: 'internal', priceRupees: 25000, displayLabel: '151-200' },
      { rangeMin: 201, rangeMax: null, methodology: 'black_box', customerType: 'internal', priceRupees: 30000, displayLabel: '200 & Above' },
      // Black Box · external
      { rangeMin: 0,   rangeMax: 30,   methodology: 'black_box', customerType: 'external', priceRupees: 7000,  displayLabel: '0-30' },
      { rangeMin: 31,  rangeMax: 50,   methodology: 'black_box', customerType: 'external', priceRupees: 12000, displayLabel: '31-50' },
      { rangeMin: 51,  rangeMax: 100,  methodology: 'black_box', customerType: 'external', priceRupees: 17000, displayLabel: '51-100' },
      { rangeMin: 101, rangeMax: 150,  methodology: 'black_box', customerType: 'external', priceRupees: 22000, displayLabel: '101-150' },
      { rangeMin: 151, rangeMax: 200,  methodology: 'black_box', customerType: 'external', priceRupees: 27000, displayLabel: '151-200' },
      { rangeMin: 201, rangeMax: null, methodology: 'black_box', customerType: 'external', priceRupees: 32000, displayLabel: '200 & Above' },
    ],
  },
  {
    slug: 'vapt_mobile_android',
    displayName: 'VAPT — Mobile App (Android)',
    scopeUnit: 'screens',
    position: 1,
    tiers: [
      { rangeMin: 0,  rangeMax: 50,   methodology: 'grey_box_apk',  customerType: 'internal', priceRupees: 20000, displayLabel: '0-50' },
      { rangeMin: 51, rangeMax: null, methodology: 'grey_box_apk',  customerType: 'internal', priceRupees: 30000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'grey_box_apk',  customerType: 'external', priceRupees: 25000, displayLabel: 'Upto 50' },
      { rangeMin: 51, rangeMax: null, methodology: 'grey_box_apk',  customerType: 'external', priceRupees: 35000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'black_box_apk', customerType: 'internal', priceRupees: 15000, displayLabel: '0-50' },
      { rangeMin: 51, rangeMax: null, methodology: 'black_box_apk', customerType: 'internal', priceRupees: 20000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'black_box_apk', customerType: 'external', priceRupees: 17000, displayLabel: 'Upto 50' },
      { rangeMin: 51, rangeMax: null, methodology: 'black_box_apk', customerType: 'external', priceRupees: 27000, displayLabel: '50 & Above' },
    ],
  },
  {
    slug: 'vapt_mobile_ios',
    displayName: 'VAPT — Mobile App (iOS)',
    scopeUnit: 'screens',
    position: 2,
    tiers: [
      { rangeMin: 0,  rangeMax: 50,   methodology: 'grey_box_ipa',  customerType: 'internal', priceRupees: 30000, displayLabel: '0-50' },
      { rangeMin: 51, rangeMax: null, methodology: 'grey_box_ipa',  customerType: 'internal', priceRupees: 40000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'grey_box_ipa',  customerType: 'external', priceRupees: 35000, displayLabel: 'Upto 50' },
      { rangeMin: 51, rangeMax: null, methodology: 'grey_box_ipa',  customerType: 'external', priceRupees: 45000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'black_box_ipa', customerType: 'internal', priceRupees: 25000, displayLabel: '0-50' },
      { rangeMin: 51, rangeMax: null, methodology: 'black_box_ipa', customerType: 'internal', priceRupees: 35000, displayLabel: '50 & Above' },
      { rangeMin: 0,  rangeMax: 50,   methodology: 'black_box_ipa', customerType: 'external', priceRupees: 27000, displayLabel: 'Upto 50' },
      { rangeMin: 51, rangeMax: null, methodology: 'black_box_ipa', customerType: 'external', priceRupees: 37000, displayLabel: '50 & Above' },
    ],
  },
  {
    slug: 'vapt_api',
    displayName: 'VAPT — APIs',
    scopeUnit: 'apis',
    position: 3,
    tiers: [
      // APIs is single-methodology: methodology stays null. The pricing
      // engine treats null as a wildcard match against caller intent.
      { rangeMin: 0,    rangeMax: 20,   methodology: null, customerType: 'internal', priceRupees: 10000, displayLabel: '0-20' },
      { rangeMin: 21,   rangeMax: 50,   methodology: null, customerType: 'internal', priceRupees: 20000, displayLabel: '21-50' },
      { rangeMin: 51,   rangeMax: 100,  methodology: null, customerType: 'internal', priceRupees: 30000, displayLabel: '51-100' },
      { rangeMin: 101,  rangeMax: 200,  methodology: null, customerType: 'internal', priceRupees: 40000, displayLabel: '101-200' },
      { rangeMin: 201,  rangeMax: 1000, methodology: null, customerType: 'internal', priceRupees: 50000, displayLabel: '201-1000' },
      { rangeMin: 1001, rangeMax: null, methodology: null, customerType: 'internal', priceRupees: 60000, displayLabel: '1000 & above' },
      { rangeMin: 0,    rangeMax: 20,   methodology: null, customerType: 'external', priceRupees: 15000, displayLabel: '0-20' },
      { rangeMin: 21,   rangeMax: 50,   methodology: null, customerType: 'external', priceRupees: 25000, displayLabel: '21-50' },
      { rangeMin: 51,   rangeMax: 100,  methodology: null, customerType: 'external', priceRupees: 35000, displayLabel: '51-100' },
      { rangeMin: 101,  rangeMax: 200,  methodology: null, customerType: 'external', priceRupees: 45000, displayLabel: '101-200' },
      { rangeMin: 201,  rangeMax: 1000, methodology: null, customerType: 'external', priceRupees: 55000, displayLabel: '201-1000' },
      { rangeMin: 1001, rangeMax: null, methodology: null, customerType: 'external', priceRupees: 65000, displayLabel: '1000 & above' },
    ],
  },
  {
    slug: 'source_code_review',
    displayName: 'Source Code Review',
    scopeUnit: 'loc',
    position: 4,
    tiers: [
      // Source listing's last tier is "100001 & Above" with a free-form
      // formula ("40000 upto exceding next 99K LOC"). We capture the
      // base price; the surcharge path will live behind a follow-up
      // pricing_model: 'per_unit' once the importer materialises it.
      { rangeMin: 0,      rangeMax: 1000,    methodology: null, customerType: 'internal', priceRupees: 30000, displayLabel: 'upto 1000' },
      { rangeMin: 1001,   rangeMax: 5000,    methodology: null, customerType: 'internal', priceRupees: 30000, displayLabel: '1001 to 5000' },
      { rangeMin: 5001,   rangeMax: 10000,   methodology: null, customerType: 'internal', priceRupees: 30000, displayLabel: '5001 to 10000' },
      { rangeMin: 10001,  rangeMax: 100000,  methodology: null, customerType: 'internal', priceRupees: 30000, displayLabel: '10000 to 100000' },
      { rangeMin: 100001, rangeMax: null,    methodology: null, customerType: 'internal', priceRupees: 40000, displayLabel: '100001 & Above' },
      { rangeMin: 0,      rangeMax: 1000,    methodology: null, customerType: 'external', priceRupees: 40000, displayLabel: 'upto 1000' },
      { rangeMin: 1001,   rangeMax: 5000,    methodology: null, customerType: 'external', priceRupees: 40000, displayLabel: '1001 to 5000' },
      { rangeMin: 5001,   rangeMax: 10000,   methodology: null, customerType: 'external', priceRupees: 40000, displayLabel: '5001 to 10000' },
      { rangeMin: 10001,  rangeMax: 100000,  methodology: null, customerType: 'external', priceRupees: 40000, displayLabel: '10000 to 100000' },
      { rangeMin: 100001, rangeMax: null,    methodology: null, customerType: 'external', priceRupees: 50000, displayLabel: '100001 & Above' },
    ],
  },
  // Network / Infra audits use a per-device row; we model each
  // (device class, VA/PT) combo as its own service line so the
  // template's gathering question can resolve directly to a slug.
  ...netInfraServiceLines(),
  {
    slug: 'vapt_thick_client',
    displayName: 'VAPT — Thick Client App',
    scopeUnit: 'pages',
    position: 100,
    tiers: [
      // From the source: only the first six rows we observed; full set
      // (151-200, 200 & Above) follows the same shape and would land in
      // the importer once we wire the parser. For the fixture we keep
      // the rows we can verify in the xlsx text.
      { rangeMin: 0,   rangeMax: 30,  methodology: 'grey_box',  customerType: 'internal', priceRupees: 40000, displayLabel: '0-30' },
      { rangeMin: 31,  rangeMax: 50,  methodology: 'grey_box',  customerType: 'internal', priceRupees: 45000, displayLabel: '31-50' },
      { rangeMin: 0,   rangeMax: 30,  methodology: 'grey_box',  customerType: 'external', priceRupees: 47000, displayLabel: '0-30' },
      { rangeMin: 31,  rangeMax: 50,  methodology: 'grey_box',  customerType: 'external', priceRupees: 52000, displayLabel: '31-50' },
    ],
  },
];

function netInfraServiceLines(): FixtureServiceLine[] {
  // device class × {VA, PT} → 6 service lines. Same structure as the source.
  const rates: Array<{
    slug: string;
    displayName: string;
    methodology: 'va' | 'pt';
    internal: number;
    external: number;
  }> = [
    { slug: 'net_servers_va',   displayName: 'Network — Servers (VA)',                  methodology: 'va', internal: 2500, external: 3000 },
    { slug: 'net_fw_va',        displayName: 'Network — Firewalls / Routers / Switches (VA)', methodology: 'va', internal: 2000, external: 2500 },
    { slug: 'net_desktops_va',  displayName: 'Network — Desktops (VA)',                 methodology: 'va', internal: 150,  external: 200 },
    { slug: 'net_servers_pt',   displayName: 'Network — Servers (PT)',                  methodology: 'pt', internal: 3000, external: 3500 },
    { slug: 'net_fw_pt',        displayName: 'Network — Firewalls / Routers / Switches (PT)', methodology: 'pt', internal: 3500, external: 4000 },
    { slug: 'net_desktops_pt',  displayName: 'Network — Desktops (PT)',                 methodology: 'pt', internal: 500,  external: 700 },
  ];
  return rates.map((r, i) => ({
    slug: r.slug,
    displayName: r.displayName,
    scopeUnit: 'devices' as const,
    position: 10 + i,
    tiers: [
      // Device-priced service lines are linear: every device costs the
      // same. We model a single tier with no upper bound so any count
      // hits it. Real-world rate cards may add discounts at higher
      // volumes — fold those in when the source has them.
      { rangeMin: 1, rangeMax: null, methodology: r.methodology, customerType: 'internal', priceRupees: r.internal, displayLabel: 'per device' },
      { rangeMin: 1, rangeMax: null, methodology: r.methodology, customerType: 'external', priceRupees: r.external, displayLabel: 'per device' },
    ],
  }));
}

const OPEN_PRICED: Array<Pick<RateCardOpenPricedService, 'slug' | 'displayName' | 'category'>> = [
  { slug: 'sebi_cscr',          displayName: 'SEBI CSCR',                                  category: 'compliance' },
  { slug: 'systems_audit',      displayName: 'Systems audit',                              category: 'audit' },
  { slug: 'sar_npci_rbi',       displayName: 'SAR — NPCI/RBI',                             category: 'audit' },
  { slug: 'irdai_cscr',         displayName: 'IRDAI — CSCR',                               category: 'compliance' },
  { slug: 'irdai_isnp',         displayName: 'IRDAI — ISNP',                               category: 'compliance' },
  { slug: 'isa',                displayName: 'ISA',                                        category: 'audit' },
  { slug: 'aua_kua',            displayName: 'AUA/KUA',                                    category: 'audit' },
  { slug: 'sub_aua_kua',        displayName: 'Sub AUA/KUA',                                category: 'audit' },
  { slug: 'asa',                displayName: 'ASA',                                        category: 'audit' },
  { slug: 'opv_nsdl',           displayName: 'OPV — NSDL',                                 category: 'audit' },
  { slug: 'esign_nsdl',         displayName: 'ESIGN — NSDL/CDSL/etc',                      category: 'audit' },
  { slug: 'rbi_circulars',      displayName: 'RBI — Various Circulars',                    category: 'audit' },
  { slug: 'sbi_vscc',           displayName: 'SBI — VSCC Audit',                           category: 'audit' },
  { slug: 'other_regulatory',   displayName: 'Other Regulatory Audits',                    category: 'audit' },
  { slug: 'iso_27001',          displayName: 'ISO 27001:2022',                             category: 'compliance' },
  { slug: 'soc_ii',             displayName: 'SOC II',                                     category: 'compliance' },
  { slug: 'hipaa',              displayName: 'HIPAA',                                      category: 'compliance' },
  { slug: 'dpdp',               displayName: 'DPDP',                                       category: 'compliance' },
  { slug: 'sbi_annexure_c',     displayName: 'SBI — Annexure C',                           category: 'audit' },
  { slug: 'secure_config',      displayName: 'Secure Configuration Review',                category: 'audit' },
  { slug: 'aws_config',         displayName: 'AWS Configuration Review',                   category: 'audit' },
  { slug: 'azure_config',       displayName: 'Azure Configuration Review',                 category: 'audit' },
  { slug: 'gcp_config',         displayName: 'GCP Configuration Review',                   category: 'audit' },
  { slug: 'oracle_config',      displayName: 'Oracle Configuration Review',                category: 'audit' },
  { slug: 'phishing_200',       displayName: 'Phishing Assessment (upto 200)',             category: 'red_team' },
  { slug: 'phishing_500',       displayName: 'Phishing Assessment (upto 500)',             category: 'red_team' },
  { slug: 'phishing_1000',      displayName: 'Phishing Assessment (upto 1000)',            category: 'red_team' },
  { slug: 'red_team_50_subs',   displayName: 'Red Teaming Assessment (upto 50 Sub-Domains)', category: 'red_team' },
];

/**
 * Build an in-memory canonical RateCard matching the sample. The ids on
 * tiers/service-lines/etc are stable per-instance but generated each
 * call; pass `ids: 'deterministic'` if you need stable ones for
 * snapshot tests.
 */
export function buildCsaasRateCardFixture(opts: {
  rateCardId: string;
  tenantId: string;
  /** When 'deterministic', uses synthetic ids derived from slug+index. */
  ids?: 'random' | 'deterministic';
} = { rateCardId: 'rc-csaas', tenantId: 'tenant-x', ids: 'deterministic' }): RateCard {
  const det = opts.ids !== 'random';
  let counter = 0;
  const id = (label: string) => det ? `${label}-${counter++}` : crypto.randomUUID();

  const serviceLines: RateCardServiceLine[] = SERVICE_LINES.map((sl, slIdx) => ({
    id: det ? `sl-${sl.slug}` : crypto.randomUUID(),
    slug: sl.slug,
    displayName: sl.displayName,
    scopeUnit: sl.scopeUnit,
    pricingModel: 'tier_lookup',
    position: sl.position ?? slIdx,
    tiers: sl.tiers.map((t, tIdx): RateCardTier => ({
      id: det ? `t-${sl.slug}-${tIdx}` : crypto.randomUUID(),
      rangeMin: t.rangeMin,
      rangeMax: t.rangeMax,
      methodology: t.methodology,
      customerType: t.customerType,
      priceCents: t.priceRupees * 100,
      displayLabel: t.displayLabel ?? null,
    })),
  }));

  const openPricedServices: RateCardOpenPricedService[] = OPEN_PRICED.map((o, i) => ({
    id: det ? `op-${o.slug}` : crypto.randomUUID(),
    slug: o.slug,
    displayName: o.displayName,
    category: o.category ?? null,
    position: i,
  }));

  // Touch the helper so unused-warnings stay quiet across compilers.
  void tier; void id;

  return {
    id: opts.rateCardId,
    tenantId: opts.tenantId,
    name: 'CSaaS Partner — Rate Card',
    version: 1,
    status: 'published',
    currency: 'INR',
    effectiveFrom: null,
    effectiveTo: null,
    serviceLines,
    openPricedServices,
  };
}
