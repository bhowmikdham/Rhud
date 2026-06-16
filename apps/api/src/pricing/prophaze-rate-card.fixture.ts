/**
 * Prophaze rate card — Private/Enterprise sector.
 *
 * Source: pricing notes captured 2026-04-28 (meeting). Modelled with
 * **driver-level service lines** — every priceable dimension (input
 * fields, dynamic pages, screens, firewalls, instances, …) is its own
 * slug so the existing tier_lookup / per_unit kernel can price each one
 * independently. The mapper emits one ScopedEntity per driver per
 * application; computeBasePrice sums them.
 *
 * Conventions:
 *   - All numbers below are in INR rupees; the fixture multiplies ×100
 *     to land in price_cents.
 *   - `pricingModel: 'per_unit'`  → tier.priceCents is the rate per unit;
 *     line item = rate × scope_value.
 *   - `pricingModel: 'tier_lookup'` (default) → tier.priceCents is the
 *     flat fee for that bracket (used for "step-function" pricing like
 *     source-code review and SCA).
 *   - Customer-type → methodology rule (Private/Enterprise sector):
 *       External → black_box, Internal → grey_box. Both are seeded with
 *       identical prices for service lines that don't actually vary by
 *       methodology (Network, Cloud, Mobile) so the auto-pick doesn't
 *       hit "no_matching_tier".
 *   - Brackets that are explicitly ranged in the source ("Highest
 *     250-300", "negotiation with bulking") get the displayLabel suffix
 *     "(advisory)" so the proposal UI can render them with a hint.
 */

import type {
  CustomerType,
  Methodology,
  RateCard,
  RateCardOpenPricedService,
  RateCardServiceLine,
  RateCardTier,
} from '@rhud/shared';

interface FixtureServiceLine {
  slug: string;
  displayName: string;
  scopeUnit: RateCardServiceLine['scopeUnit'];
  pricingModel: RateCardServiceLine['pricingModel'];
  position: number;
  /** Layer-3 mapper LLM hint — when (and how) to emit this slug. */
  inferenceHint?: string;
  /** 0–3 worked examples shown to the LLM under the slug. */
  inferenceExamples?: string[];
  tiers: Array<{
    rangeMin: number;
    rangeMax: number | null;
    methodology: Methodology;
    customerType: CustomerType;
    /** In rupees — fixture multiplies ×100 to land in price_cents. */
    priceRupees: number;
    displayLabel?: string | null;
  }>;
}

const PROPHAZE_INFERENCE_CONTEXT =
  'B2B cybersecurity penetration-testing engagements (VAPT). A single engagement ' +
  'commonly covers MULTIPLE applications across different domains — web apps, REST/SOAP ' +
  'APIs, mobile (iOS/Android) apps — plus discrete infrastructure layers (network, cloud). ' +
  'Each application is its own iteration and emits its own driver entities; infrastructure ' +
  'layers are single-occurrence (no appId). The LLM\'s job is to read the client\'s ' +
  'security questionnaire and emit one entity per priceable driver per application.';

const PROPHAZE_DEFAULT_METHODOLOGY_RULE =
  'Default methodology depends on the customer\'s relationship to the asset:\n' +
  '  • customerType=external → black_box (default for public-facing apps / public-access docs)\n' +
  '  • customerType=internal → grey_box (default when the doc states the test is internal)\n' +
  'White-box service lines (slugs containing "source_code" or ending in "_sca") are ALWAYS ' +
  'opt-in: emit them only when the document explicitly requests source-code review or SCA ' +
  '("source code review: yes", "lines of code: 250000", "SCA in scope"). Network/Cloud/IAM ' +
  'lines have no methodology axis — leave methodology=null for those.';

const PROPHAZE_TENANT_EXAMPLES: string[] = [
  'Doc says "29 dynamic pages" + "23 API endpoints" + "Admin, Read-only" + "Hosted on Cloud — AWS" → ' +
    'emit vapt_web_app_dynamic_pages(scope=29, appId=web_app_1, black_box) + ' +
    'vapt_api_endpoints(scope=23, appId=api_1, black_box) + ' +
    'vapt_api_roles(scope=2, appId=api_1, grey_box) [count comma-separated items]. ' +
    'Cloud hosting is metadata, NOT a separate cloud_instances entity unless the doc lists ' +
    'distinct cloud assets to scan.',
  'Doc has 12 URLs, all on staging.example.com → ONE web_app instance (appId=web_app_1) with ' +
    'vapt_web_app_dynamic_pages(scope=12). Same hostname = same app.',
  'Doc has 5 URLs across 3 distinct hostnames (a.com, b.com, c.com) → THREE web_app instances ' +
    '(appId=web_app_1/2/3), each with its own dynamic_pages count.',
  'Doc says "Source code review: Not applicable" / "Penetration test type: Black Box" → ' +
    'DO NOT emit any *_source_code_* or *_sca slug. Add them to `considered` with ' +
    'reason="negated".',
];

// Helper: emit (black_box, grey_box) × (internal, external) tier rows from
// a single per-customer table. Customer-type → methodology is an
// auto-pick rule, but we materialise the rows so the kernel's exact-match
// pickTier can still short-circuit with both axes.
function symmetric(
  rows: Array<{
    rangeMin: number;
    rangeMax: number | null;
    priceRupees: number;
    displayLabel?: string | null;
  }>,
  methodologies: ReadonlyArray<Methodology>,
): FixtureServiceLine['tiers'] {
  const out: FixtureServiceLine['tiers'] = [];
  for (const m of methodologies) {
    for (const cust of ['internal', 'external'] as const) {
      for (const r of rows) out.push({ ...r, methodology: m, customerType: cust });
    }
  }
  return out;
}

// Single-axis: methodology=null (wildcard), both customer types same price.
function flatBoth(
  rows: Array<{
    rangeMin: number;
    rangeMax: number | null;
    priceRupees: number;
    displayLabel?: string | null;
  }>,
): FixtureServiceLine['tiers'] {
  const out: FixtureServiceLine['tiers'] = [];
  for (const cust of ['internal', 'external'] as const) {
    for (const r of rows) out.push({ ...r, methodology: null, customerType: cust });
  }
  return out;
}

const BB_GB: ReadonlyArray<Methodology> = ['black_box', 'grey_box'];
const GB_ONLY: ReadonlyArray<Methodology> = ['grey_box'];
const WB_ONLY: ReadonlyArray<Methodology> = ['white_box'];

// Source-code review LOC step function: 60k for first lakh, +10k per
// additional lakh. Materialised as 50 brackets so any project up to
// 50 lakh LOC prices deterministically. Beyond 50 lakh the line shows
// "no_matching_tier" — the manager card will prompt for a manual quote.
function sourceCodeLocTiers(): Array<{
  rangeMin: number;
  rangeMax: number | null;
  priceRupees: number;
  displayLabel?: string | null;
}> {
  const tiers: Array<{
    rangeMin: number;
    rangeMax: number | null;
    priceRupees: number;
    displayLabel?: string | null;
  }> = [];
  for (let lakh = 1; lakh <= 50; lakh++) {
    const min = (lakh - 1) * 100_000 + 1;
    const max = lakh * 100_000;
    const price = 60_000 + (lakh - 1) * 10_000;
    const label =
      lakh === 1
        ? 'upto 1 lakh LOC'
        : `${(lakh - 1) * 100_000 + 1}–${lakh * 100_000} LOC`;
    tiers.push({ rangeMin: min, rangeMax: max, priceRupees: price, displayLabel: label });
  }
  return tiers;
}

const SERVICE_LINES: FixtureServiceLine[] = [
  // ── Web Application ──────────────────────────────────────────────────
  {
    slug: 'vapt_web_app_input_fields',
    displayName: 'VAPT — Web App / Input Fields',
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 0,
    inferenceHint:
      'Emit when the doc names a count of input fields / form fields / form inputs for a web app. ' +
      'If the doc gives no field count but lists distinct forms, count forms × ~5 as a rough estimate ' +
      'with confidence 0.5. Group with the same appId as the rest of that web app\'s drivers.',
    inferenceExamples: ['"~60 input fields across 12 forms" → scope=60, appId=web_app_1'],
    tiers: symmetric(
      [
        { rangeMin: 1,  rangeMax: 14,   priceRupees: 50, displayLabel: '1–15 fields' },
        { rangeMin: 15, rangeMax: 19,   priceRupees: 60, displayLabel: '15–20 fields' },
        { rangeMin: 20, rangeMax: 24,   priceRupees: 70, displayLabel: '20–25 fields' },
        { rangeMin: 25, rangeMax: null, priceRupees: 70, displayLabel: '25+ (advisory: +10/5 fields)' },
      ],
      BB_GB,
    ),
  },
  {
    slug: 'vapt_web_app_dynamic_pages',
    displayName: 'VAPT — Web App / Dynamic Pages',
    scopeUnit: 'pages',
    pricingModel: 'per_unit',
    position: 1,
    inferenceHint:
      'Emit when the doc names a count of dynamic pages (pages that render server-side data, change ' +
      'per user, or carry forms). If the doc only provides a URL list without an explicit count, ' +
      'use the synthetic point _derived_url_analysis: count distinct paths under each hostname — ' +
      'that count is this slug for that hostname. Each distinct hostname is a separate web_app_N. ' +
      'Static / marketing pages go to *_static_pages, NOT here.',
    inferenceExamples: [
      '"How many dynamic pages: 29" → scope=29, appId=web_app_1, confidence 0.9',
      '"_derived_url_analysis: 12 URLs across 1 distinct hostname: staging.example.com (12 paths)" → scope=12, appId=web_app_1, confidence 0.75',
    ],
    tiers: symmetric(
      [
        { rangeMin: 1,   rangeMax: 49,   priceRupees: 100, displayLabel: 'Low (15–20)' },
        { rangeMin: 50,  rangeMax: 99,   priceRupees: 70,  displayLabel: 'Mid (50–80)' },
        { rangeMin: 100, rangeMax: 249,  priceRupees: 50,  displayLabel: 'High (100–150)' },
        { rangeMin: 250, rangeMax: null, priceRupees: 32,  displayLabel: 'Highest (250–300, advisory)' },
      ],
      BB_GB,
    ),
  },
  {
    slug: 'vapt_web_app_static_pages',
    displayName: 'VAPT — Web App / Static Pages',
    scopeUnit: 'pages',
    pricingModel: 'per_unit',
    position: 2,
    inferenceHint:
      'Emit ONLY when the doc names a count of static / marketing / brochure pages explicitly. ' +
      'Do NOT split a generic "29 pages" answer between dynamic and static — in that case the count ' +
      'is dynamic. Negation phrases like "no static pages" / "0 static" → DO NOT emit, add to ' +
      'considered with reason="negated".',
    inferenceExamples: ['"Static pages: 8" → scope=8, appId=web_app_1'],
    tiers: symmetric(
      [
        { rangeMin: 1,   rangeMax: 10,   priceRupees: 30, displayLabel: '1–10 pages' },
        { rangeMin: 11,  rangeMax: 19,   priceRupees: 20, displayLabel: '11–20 pages' },
        { rangeMin: 20,  rangeMax: 49,   priceRupees: 20, displayLabel: 'Low (20–50)' },
        { rangeMin: 50,  rangeMax: 99,   priceRupees: 11, displayLabel: 'Mid (50–100)' },
        { rangeMin: 100, rangeMax: null, priceRupees: 6,  displayLabel: 'High (>100, advisory)' },
      ],
      BB_GB,
    ),
  },
  {
    slug: 'vapt_web_app_roles',
    displayName: 'VAPT — Web App / Roles (Grey Box only)',
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 3,
    inferenceHint:
      'Emit ONLY when (a) the test methodology is grey_box AND (b) the doc names roles for a web app. ' +
      'Count comma-separated lists ("Admin, User, Auditor" = 3). Phrases like "Not applicable" / ' +
      '"None defined" → DO NOT emit. This slug is grey_box only — for an external/black_box ' +
      'engagement, do not emit even if roles are mentioned.',
    inferenceExamples: ['"Roles: Admin, Read-only" with grey_box test → scope=2, appId=web_app_1, methodology=grey_box'],
    tiers: symmetric(
      [
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 5_000, displayLabel: '1–2 roles' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 4_000, displayLabel: '5–8 roles' },
        { rangeMin: 10, rangeMax: 46,   priceRupees: 2_500, displayLabel: '10–25 roles' },
        { rangeMin: 47, rangeMax: null, priceRupees: 1_750, displayLabel: '47+ (advisory)' },
      ],
      GB_ONLY,
    ),
  },
  {
    slug: 'vapt_web_app_login_modules',
    displayName: 'VAPT — Web App / Login Modules (Grey Box only)',
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 4,
    inferenceHint:
      'Emit when (a) methodology is grey_box AND (b) the doc enumerates login flows / SSO / ' +
      'auth modules. SSO + a separate password login = 2 modules. "Single sign-on only" = 1. ' +
      '"No authentication" → DO NOT emit.',
    tiers: symmetric(
      [
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 10_000, displayLabel: '1–2 modules' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 7_000,  displayLabel: '5–8 modules' },
        { rangeMin: 10, rangeMax: 19,   priceRupees: 5_000,  displayLabel: '10–15 modules' },
        { rangeMin: 20, rangeMax: null, priceRupees: 3_650,  displayLabel: '20+ (advisory)' },
      ],
      GB_ONLY,
    ),
  },
  {
    slug: 'vapt_web_app_source_code_backend',
    displayName: 'VAPT — Web App / Source Code Review (Backend)',
    scopeUnit: 'loc',
    pricingModel: 'tier_lookup',
    position: 5,
    inferenceHint:
      'White-box ONLY. Emit only when the doc explicitly requests source-code / SAST review for the ' +
      'BACKEND with a lines-of-code count. Phrases that DISQUALIFY: "source code review: no", ' +
      '"black box only", "not applicable for source code". Scope is total backend LOC.',
    tiers: symmetric(sourceCodeLocTiers(), WB_ONLY),
  },
  {
    slug: 'vapt_web_app_source_code_frontend',
    displayName: 'VAPT — Web App / Source Code Review (Frontend)',
    scopeUnit: 'loc',
    pricingModel: 'tier_lookup',
    position: 6,
    inferenceHint:
      'White-box ONLY. Like *_source_code_backend but for the frontend codebase. Emit only when the ' +
      'doc explicitly requests frontend source review with a LOC count.',
    tiers: symmetric(sourceCodeLocTiers(), WB_ONLY),
  },
  {
    slug: 'vapt_web_app_sca',
    displayName: 'VAPT — Web App / API Code Review (SCA)',
    scopeUnit: 'pages',
    pricingModel: 'tier_lookup',
    position: 7,
    inferenceHint:
      'White-box ONLY. Software Composition Analysis. Emit only when the doc explicitly requests SCA ' +
      'or component-level dependency analysis. The substring "sca" alone is NOT enough — it must be ' +
      'in the context of "SCA", "source component analysis", or equivalent. Do NOT match "scope" or ' +
      '"scan" as evidence.',
    tiers: symmetric(
      [
        { rangeMin: 1,   rangeMax: 70,   priceRupees: 100_000, displayLabel: 'Low (≤70 pages)' },
        { rangeMin: 71,  rangeMax: 180,  priceRupees: 200_000, displayLabel: 'Mid (71–180)' },
        { rangeMin: 181, rangeMax: null, priceRupees: 400_000, displayLabel: 'High (>180)' },
      ],
      WB_ONLY,
    ),
  },

  // ── API ──────────────────────────────────────────────────────────────
  {
    slug: 'vapt_api_endpoints',
    displayName: 'VAPT — API / Endpoints',
    scopeUnit: 'apis',
    pricingModel: 'per_unit',
    position: 10,
    inferenceHint:
      'Emit when the doc names a count of API endpoints / routes / paths. Group all endpoints of one ' +
      'API surface under one appId (api_1, api_2, …). REST/SOAP/GraphQL all count. Where the doc ' +
      'lists endpoints individually, count distinct paths. "API: Yes" without a count → scope=1, ' +
      'confidence 0.5.',
    inferenceExamples: ['"Total API endpoints: 23" → scope=23, appId=api_1', '"API: Yes" without count → scope=1 confidence 0.5'],
    tiers: symmetric(
      [
        { rangeMin: 1,   rangeMax: 15,   priceRupees: 1_500, displayLabel: '1–15 endpoints' },
        { rangeMin: 16,  rangeMax: 49,   priceRupees: 1_300, displayLabel: '16–25 endpoints' },
        { rangeMin: 50,  rangeMax: 149,  priceRupees: 1_000, displayLabel: '50–100 endpoints' },
        { rangeMin: 150, rangeMax: null, priceRupees: 800,   displayLabel: '150+ (advisory)' },
      ],
      BB_GB,
    ),
  },
  {
    slug: 'vapt_api_input_fields',
    displayName: 'VAPT — API / Input Fields',
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 11,
    inferenceHint:
      'Emit when the doc names a count of API request parameters / body fields. ' +
      'Distinguished from vapt_api_endpoints — endpoints are paths, input_fields are the parameters ' +
      'across them. "23 endpoints" alone is NOT enough to emit input_fields; the doc must mention ' +
      'parameter / field counts explicitly.',
    tiers: symmetric(
      [
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 300, displayLabel: '1–5 fields' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 400, displayLabel: '5–10 fields' },
        { rangeMin: 10, rangeMax: 34,   priceRupees: 500, displayLabel: '10–15 fields' },
        { rangeMin: 35, rangeMax: null, priceRupees: 700, displayLabel: '35+ (advisory: negotiation)' },
      ],
      BB_GB,
    ),
  },
  {
    slug: 'vapt_api_roles',
    displayName: 'VAPT — API / Roles (Grey Box only)',
    scopeUnit: 'other',
    pricingModel: 'per_unit',
    position: 12,
    inferenceHint:
      'Emit ONLY when (a) methodology is grey_box AND (b) the doc names roles for an API. Count ' +
      'comma-separated lists ("Admin, Read-only" = 2). For external/black_box engagements, do not ' +
      'emit even if roles are mentioned.',
    inferenceExamples: ['"API roles: Admin, Read-only" with grey_box → scope=2, appId=api_1, methodology=grey_box'],
    tiers: symmetric(
      [
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 5_000, displayLabel: '1–2 roles' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 4_000, displayLabel: '5–8 roles' },
        { rangeMin: 10, rangeMax: 46,   priceRupees: 2_500, displayLabel: '10–25 roles' },
        { rangeMin: 47, rangeMax: null, priceRupees: 1_750, displayLabel: '47+ (advisory)' },
      ],
      GB_ONLY,
    ),
  },
  {
    slug: 'vapt_api_source_code_backend',
    displayName: 'VAPT — API / Source Code Review (Backend)',
    scopeUnit: 'loc',
    pricingModel: 'tier_lookup',
    position: 13,
    inferenceHint:
      'White-box ONLY. Emit only when the doc explicitly requests source-code review of API backend ' +
      'with a LOC count.',
    tiers: symmetric(sourceCodeLocTiers(), WB_ONLY),
  },
  {
    slug: 'vapt_api_source_code_frontend',
    displayName: 'VAPT — API / Source Code Review (Frontend)',
    scopeUnit: 'loc',
    pricingModel: 'tier_lookup',
    position: 14,
    inferenceHint:
      'White-box ONLY. Like vapt_api_source_code_backend but for the API\'s frontend (rare for pure ' +
      'API offerings; usually only emit when the doc names a separate frontend codebase).',
    tiers: symmetric(sourceCodeLocTiers(), WB_ONLY),
  },
  {
    slug: 'vapt_api_sca',
    displayName: 'VAPT — API / Source Component Analysis (SCA)',
    scopeUnit: 'pages',
    pricingModel: 'tier_lookup',
    position: 15,
    inferenceHint:
      'White-box ONLY. SCA = Source Component Analysis (dependency / library scanning). Emit only when ' +
      'the doc explicitly requests SCA. The substring "sca" inside other words ("scope", "scan", ' +
      '"scale") is NOT evidence.',
    tiers: symmetric(
      [
        { rangeMin: 1,   rangeMax: 70,   priceRupees: 100_000, displayLabel: 'Low (≤70 pages)' },
        { rangeMin: 71,  rangeMax: 180,  priceRupees: 200_000, displayLabel: 'Mid (71–180)' },
        { rangeMin: 181, rangeMax: null, priceRupees: 400_000, displayLabel: 'High (>180)' },
      ],
      WB_ONLY,
    ),
  },

  // ── Mobile App (iOS, Android) — Black Box only ────────────────────────
  ...mobilePlatformLines('ios', 'iOS', 20),
  ...mobilePlatformLines('android', 'Android', 30),

  // ── Network — single methodology axis ────────────────────────────────
  {
    slug: 'vapt_network_firewalls',
    displayName: 'VAPT — Network / Firewalls',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 40,
    inferenceHint:
      'Emit when the doc names a count of firewalls in scope (perimeter / internal). A "Web ' +
      'Application Firewall" mentioned as a TEST CONDITION (e.g. "WAF in place") is NOT a firewall ' +
      'to scope — that\'s a noise-source affecting the test, not a target. Only emit when the firewall ' +
      'IS the target.',
    tiers: flatBoth([
      { rangeMin: 1, rangeMax: null, priceRupees: 5_000, displayLabel: 'per firewall (no negotiation)' },
    ]),
  },
  {
    slug: 'vapt_network_routers',
    displayName: 'VAPT — Network / Routers',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 41,
    tiers: flatBoth([
      { rangeMin: 1,  rangeMax: 9,    priceRupees: 3_500, displayLabel: '1–10 routers' },
      { rangeMin: 10, rangeMax: 34,   priceRupees: 2_500, displayLabel: '10–15 routers' },
      { rangeMin: 35, rangeMax: null, priceRupees: 2_000, displayLabel: '35+ (advisory)' },
    ]),
  },
  {
    slug: 'vapt_network_endpoints',
    displayName: 'VAPT — Network / Endpoint Devices',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 42,
    inferenceHint:
      'End-user / host computing devices that are themselves the test targets — desktops, ' +
      'laptops, PCs, notebooks, workstations, and end-user/host servers ALL count as endpoint ' +
      'devices, however the doc phrases them (e.g. "Windows PCs", "MacBooks", "user machines"). ' +
      'Emit with the TOTAL device count, summing across types/OSes if the doc lists several ' +
      '(e.g. "PC/Laptop windows (8)" → 8; "40 desktops + 10 laptops" → 50). Network APPLIANCES ' +
      'are NOT endpoints — firewalls, routers, switches, IDS/IPS/DLP each have their own line; ' +
      'do not double-count them here.',
    inferenceExamples: [
      '"PC/Laptop windows (8)" → vapt_network_endpoints scope=8',
      '"approx 250 desktops and laptops across 3 offices" → vapt_network_endpoints scope=250',
    ],
    tiers: flatBoth([
      { rangeMin: 1,    rangeMax: 49,    priceRupees: 1_500, displayLabel: '1–50 devices' },
      { rangeMin: 50,   rangeMax: 99,    priceRupees: 1_000, displayLabel: '50–100 devices' },
      { rangeMin: 100,  rangeMax: 199,   priceRupees: 800,   displayLabel: '100–200 devices' },
      { rangeMin: 200,  rangeMax: 499,   priceRupees: 500,   displayLabel: '200–500 devices' },
      { rangeMin: 500,  rangeMax: 999,   priceRupees: 400,   displayLabel: '500–1000 devices' },
      { rangeMin: 1000, rangeMax: 1999,  priceRupees: 250,   displayLabel: '1000–2000 devices' },
      { rangeMin: 2000, rangeMax: null,  priceRupees: 100,   displayLabel: '2000+ (advisory)' },
    ]),
  },
  {
    slug: 'vapt_network_switches',
    displayName: 'VAPT — Network / Switches',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 43,
    tiers: flatBoth([
      { rangeMin: 1,  rangeMax: 4,    priceRupees: 2_000, displayLabel: '1–5 switches' },
      { rangeMin: 5,  rangeMax: 9,    priceRupees: 1_800, displayLabel: '5–10 switches' },
      { rangeMin: 10, rangeMax: 14,   priceRupees: 1_500, displayLabel: '10–15 switches' },
      { rangeMin: 15, rangeMax: 19,   priceRupees: 1_200, displayLabel: '15–20 switches' },
      { rangeMin: 20, rangeMax: null, priceRupees: 800,   displayLabel: '20+ (advisory)' },
    ]),
  },
  {
    slug: 'vapt_network_antivirus',
    displayName: 'VAPT — Network / Antivirus',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 44,
    tiers: flatBoth([
      { rangeMin: 1,  rangeMax: 4,    priceRupees: 7_000, displayLabel: '1–5 AV instances' },
      { rangeMin: 5,  rangeMax: 9,    priceRupees: 6_000, displayLabel: '5–10 AV instances' },
      { rangeMin: 10, rangeMax: 14,   priceRupees: 5_000, displayLabel: '10–15 AV instances' },
      { rangeMin: 15, rangeMax: 19,   priceRupees: 4_000, displayLabel: '15–20 AV instances' },
      { rangeMin: 20, rangeMax: 24,   priceRupees: 3_000, displayLabel: '20–25 AV instances' },
      { rangeMin: 25, rangeMax: null, priceRupees: 2_500, displayLabel: '25+ (floor, advisory)' },
    ]),
  },
  {
    slug: 'vapt_network_ids',
    displayName: 'VAPT — Network / IDS',
    scopeUnit: 'devices',
    pricingModel: 'flat',
    position: 45,
    inferenceHint:
      'Binary toggle. Emit scope=1 when the doc says "IDS: Yes" / "Intrusion detection: Enabled" / ' +
      'IDS-as-target. Match "ids" only as a whole word — don\'t match it inside "credentials" or other ' +
      'words. "IDS: No" / "Not in scope" → DO NOT emit.',
    tiers: flatBoth([
      { rangeMin: 1, rangeMax: null, priceRupees: 10_000, displayLabel: 'flat (single IDS)' },
    ]),
  },
  {
    slug: 'vapt_network_ips',
    displayName: 'VAPT — Network / IPS',
    scopeUnit: 'devices',
    pricingModel: 'flat',
    position: 46,
    inferenceHint:
      'Binary toggle. Emit scope=1 when the doc says "IPS: Yes" / "Intrusion prevention: Enabled" / ' +
      'IPS-as-target. Match "ips" only as a whole word.',
    tiers: flatBoth([
      { rangeMin: 1, rangeMax: null, priceRupees: 10_000, displayLabel: 'flat (single IPS)' },
    ]),
  },
  {
    slug: 'vapt_network_dlp',
    displayName: 'VAPT — Network / DLP',
    scopeUnit: 'devices',
    pricingModel: 'flat',
    position: 47,
    inferenceHint:
      'Binary toggle. Emit scope=1 when the doc says "DLP: Yes" / "Data Loss Prevention: Enabled" / ' +
      'DLP-as-target.',
    tiers: flatBoth([
      { rangeMin: 1, rangeMax: null, priceRupees: 50_000, displayLabel: 'flat (single DLP)' },
    ]),
  },

  // ── Cloud ────────────────────────────────────────────────────────────
  {
    slug: 'vapt_cloud_instances',
    displayName: 'VAPT — Cloud / Instances',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 50,
    inferenceHint:
      'Emit when the doc evidences cloud-hosted infrastructure to scan. Three triggers: (1) doc lists ' +
      'discrete cloud instances (EC2, VMs, GCP instances, Azure VMs) with a count → scope=count, ' +
      'confidence 0.85; (2) doc gives a URL list with N distinct hostnames → scope=N, confidence 0.8; ' +
      '(3) the synthetic point _derived_cloud_hosting OR a categorical answer like "Hosted on Cloud — ' +
      'AWS" / "Cloud: Azure" with no instance count → scope=1, confidence 0.7 (above the 0.6 priced ' +
      'threshold so the rep sees it). Multiple distinct hostnames in a URL list = N instances. URLs ' +
      'all on the same hostname = 1 instance.',
    inferenceExamples: [
      '"Hosting: AWS — 5 EC2 instances" → scope=5, confidence 0.85',
      '"URL list across 3 distinct hostnames" → scope=3, confidence 0.8',
      '"Hosted on Cloud — AWS" with no instance count → scope=1, confidence 0.7',
    ],
    tiers: flatBoth([
      { rangeMin: 1,  rangeMax: 4,    priceRupees: 12_000, displayLabel: '1–5 instances' },
      { rangeMin: 5,  rangeMax: 9,    priceRupees: 10_000, displayLabel: '5–10 instances' },
      { rangeMin: 10, rangeMax: 14,   priceRupees: 8_000,  displayLabel: '10–15 instances' },
      { rangeMin: 15, rangeMax: 19,   priceRupees: 7_000,  displayLabel: '15–20 instances' },
      { rangeMin: 20, rangeMax: 24,   priceRupees: 6_000,  displayLabel: '20–25 instances' },
      { rangeMin: 25, rangeMax: 69,   priceRupees: 5_000,  displayLabel: '25–30 instances' },
      { rangeMin: 70, rangeMax: null, priceRupees: 3_500,  displayLabel: '70+ (cap, advisory)' },
    ]),
  },
  {
    slug: 'vapt_cloud_databases',
    displayName: 'VAPT — Cloud / Databases',
    scopeUnit: 'devices',
    pricingModel: 'per_unit',
    position: 51,
    tiers: flatBoth([
      { rangeMin: 1,  rangeMax: 4,    priceRupees: 12_000, displayLabel: '1–5 DBs' },
      { rangeMin: 5,  rangeMax: 9,    priceRupees: 10_000, displayLabel: '5–10 DBs' },
      { rangeMin: 10, rangeMax: 14,   priceRupees: 8_000,  displayLabel: '10–15 DBs' },
      { rangeMin: 15, rangeMax: 19,   priceRupees: 7_000,  displayLabel: '15–20 DBs' },
      { rangeMin: 20, rangeMax: 24,   priceRupees: 6_000,  displayLabel: '20–25 DBs' },
      { rangeMin: 25, rangeMax: 69,   priceRupees: 5_000,  displayLabel: '25–30 DBs' },
      { rangeMin: 70, rangeMax: null, priceRupees: 3_500,  displayLabel: '70+ (cap, advisory)' },
    ]),
  },
  {
    slug: 'vapt_cloud_iam',
    displayName: 'VAPT — Cloud / IAM',
    scopeUnit: 'other',
    pricingModel: 'flat',
    position: 52,
    inferenceHint:
      'Binary flat-priced. Emit scope=1 ONLY when the doc explicitly requests an IAM (Identity & ' +
      'Access Management) review of cloud roles/policies. The substring "iam" by itself is NOT ' +
      'evidence — it must be in the context of "IAM review", "Identity & Access", "cloud IAM ' +
      'policies", etc. Mentions of cloud hosting alone do NOT trigger this slug.',
    tiers: flatBoth([
      { rangeMin: 1, rangeMax: null, priceRupees: 30_000, displayLabel: 'flat (binary)' },
    ]),
  },
];

function mobilePlatformLines(
  slugSuffix: 'ios' | 'android',
  displayName: 'iOS' | 'Android',
  positionBase: number,
): FixtureServiceLine[] {
  const platformQualifier = displayName === 'iOS' ? '(iOS / IPA / iPhone / Apple App Store)' : '(Android / APK / Google Play)';
  return [
    {
      slug: `vapt_mobile_${slugSuffix}_screens`,
      displayName: `VAPT — Mobile (${displayName}) / Screens`,
      scopeUnit: 'screens',
      pricingModel: 'per_unit',
      position: positionBase,
      inferenceHint:
        `Emit when the doc names a count of screens for a ${displayName} mobile app ${platformQualifier}. ` +
        `Cross-platform mention without ${displayName}-specific evidence → DO NOT emit; let the other ` +
        `mobile platform get it.`,
      tiers: flatBoth([
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 2_200, displayLabel: '1–5 screens' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 2_000, displayLabel: '5–10 screens' },
        { rangeMin: 10, rangeMax: 24,   priceRupees: 1_800, displayLabel: '10–15 screens' },
        { rangeMin: 25, rangeMax: null, priceRupees: 1_500, displayLabel: '25+ (advisory)' },
      ]),
    },
    {
      slug: `vapt_mobile_${slugSuffix}_static_analysis`,
      displayName: `VAPT — Mobile (${displayName}) / Static Analysis`,
      scopeUnit: 'screens',
      pricingModel: 'per_unit',
      position: positionBase + 1,
      inferenceHint:
        `Emit when the doc explicitly requests static analysis (SAST) of a ${displayName} mobile app. ` +
        `Default scope = same number of screens as vapt_mobile_${slugSuffix}_screens.`,
      tiers: flatBoth([
        { rangeMin: 1,  rangeMax: 4,    priceRupees: 20_000, displayLabel: '1–5 screens' },
        { rangeMin: 5,  rangeMax: 9,    priceRupees: 18_000, displayLabel: '5–10 screens' },
        { rangeMin: 10, rangeMax: 24,   priceRupees: 15_000, displayLabel: '10–15 screens' },
        { rangeMin: 25, rangeMax: null, priceRupees: 15_000, displayLabel: '25+ (advisory)' },
      ]),
    },
    {
      slug: `vapt_mobile_${slugSuffix}_classes`,
      displayName: `VAPT — Mobile (${displayName}) / Classes`,
      scopeUnit: 'other',
      pricingModel: 'tier_lookup',
      position: positionBase + 2,
      inferenceHint:
        `Emit when the doc names class / module / dex count for a ${displayName} mobile app. Rare to ` +
        `appear in client questionnaires; usually only present when SAST is requested with detailed ` +
        `architecture info.`,
      tiers: flatBoth([
        { rangeMin: 50,  rangeMax: 99,   priceRupees: 10_000, displayLabel: '50–100 classes' },
        { rangeMin: 100, rangeMax: null, priceRupees: 20_000, displayLabel: '100+ classes (advisory)' },
      ]),
    },
  ];
}

const OPEN_PRICED: Array<Pick<RateCardOpenPricedService, 'slug' | 'displayName' | 'category'>> = [
  // Government-sector pricing is explicitly out of scope for this card —
  // any government-flagged engagement gets routed to the open-priced
  // table so a pricing manager hand-quotes it.
  { slug: 'government_engagement', displayName: 'Government Sector — Manual Quote', category: 'government' },
];

export function buildProphazeRateCardFixture(opts: {
  rateCardId: string;
  tenantId: string;
  ids?: 'random' | 'deterministic';
} = { rateCardId: 'rc-prophaze', tenantId: 'tenant-x', ids: 'deterministic' }): RateCard {
  const det = opts.ids !== 'random';

  const serviceLines: RateCardServiceLine[] = SERVICE_LINES.map((sl, slIdx) => ({
    id: det ? `sl-${sl.slug}` : crypto.randomUUID(),
    slug: sl.slug,
    displayName: sl.displayName,
    scopeUnit: sl.scopeUnit,
    pricingModel: sl.pricingModel,
    position: sl.position ?? slIdx,
    inferenceHint: sl.inferenceHint ?? null,
    inferenceExamples: sl.inferenceExamples ?? [],
    // Pool volume across application instances for the per-app, per_unit
    // volume-tiered lines (web app / API / mobile) so a multi-application
    // opportunity earns one combined volume discount instead of each app
    // hitting its own (smaller) tier. Network / cloud are infra-wide
    // (single instance, no appId) so they never pool in practice.
    poolAcrossEntities:
      sl.pricingModel === 'per_unit' && /^vapt_(web_app|api|mobile)_/.test(sl.slug),
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

  return {
    id: opts.rateCardId,
    tenantId: opts.tenantId,
    name: 'Prophaze — Private/Enterprise Rate Card',
    version: 1,
    status: 'published',
    currency: 'INR',
    effectiveFrom: null,
    effectiveTo: null,
    inferenceContext: PROPHAZE_INFERENCE_CONTEXT,
    defaultMethodologyRule: PROPHAZE_DEFAULT_METHODOLOGY_RULE,
    inferenceExamples: PROPHAZE_TENANT_EXAMPLES,
    serviceLines,
    openPricedServices,
  };
}
