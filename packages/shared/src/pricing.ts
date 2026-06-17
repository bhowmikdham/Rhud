import type { NodeBinding, TemplateWithNodes } from './templates.js';
import type { Answer } from './engine.js';

// Rhud Pricing Engine — Stage 1 + Stage 2 contracts.
//
// See Rhud_Pricing_Engine.pdf §2.2, §3.2-3.3.
//
//   Stage 1 (scope normalisation): gathering form answers → flat list of
//     priceable entities, each tagged with a service_line slug + the
//     dimension(s) needed to price it.
//   Stage 2 (base price computation): pure walk over a RateCard. Pick
//     matching tier per entity, sum into a line-item ledger.
//
// This module is shared so both api (computes the price server-side
// inside the engagement flow) and web (preview a quote in the editor)
// can run the same math against the same types.

// ── Dimensions / methodology / customer type ────────────────────────────────

export const SCOPE_UNITS = ['pages', 'screens', 'apis', 'loc', 'devices', 'hours', 'other'] as const;
export type ScopeUnit = (typeof SCOPE_UNITS)[number];

/**
 * Free-form per-service-line — different rate cards subdivide differently
 * (Web App: grey/black box; Network: VA/PT; APIs: none). Modelled as a
 * string so a rate card from a different shape doesn't force schema work.
 */
export type Methodology = string | null;

export const CUSTOMER_TYPES = ['internal', 'external'] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export const PRICING_MODELS = ['tier_lookup', 'per_unit', 'flat', 'hourly'] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const RATE_CARD_STATUSES = ['draft', 'published', 'archived'] as const;
export type RateCardStatus = (typeof RATE_CARD_STATUSES)[number];

// ── Canonical RateCard ──────────────────────────────────────────────────────

export interface RateCardTier {
  id: string;
  /** inclusive lower bound on the dimension value */
  rangeMin: number;
  /** inclusive upper bound; null = open-ended ("200 & Above"). */
  rangeMax: number | null;
  methodology: Methodology;
  customerType: CustomerType;
  /** ×100 in the rate card's currency. */
  priceCents: number;
  /** Original label from source for traceability ("Upto 50", "200 & Above"). */
  displayLabel?: string | null;
}

export interface RateCardServiceLine {
  id: string;
  slug: string;
  displayName: string;
  scopeUnit: ScopeUnit;
  pricingModel: PricingModel;
  position: number;
  tiers: RateCardTier[];
  /**
   * Inference ontology — when (and how) the Layer-3 mapper LLM should
   * emit this slug. Authored alongside the rate card; the mapper composes
   * its system prompt from these fields so it never needs domain
   * knowledge baked into code. ~200 chars, plain English.
   *
   * Example for `vapt_web_app_dynamic_pages`:
   *   "Emit when the doc names a count of dynamic pages for a web app.
   *    If only a URL list is present, count distinct paths on the same
   *    hostname (group by hostname into separate web-app entities)."
   *
   * Optional. Mapper falls back to `synthesizeDefaultHint(sl)` when
   * absent. Existing rate cards keep working without a migration step.
   */
  inferenceHint?: string | null;
  /** 0–3 worked examples ("23 endpoints" → scope=23) shown to the LLM. */
  inferenceExamples?: string[];
  /**
   * When true and this is a `per_unit` line, multiple application instances
   * (entities with the same slug + methodology + customerType but different
   * appId) are priced on their COMBINED scope — one volume tier for the
   * whole opportunity — instead of each app hitting its own tier. The line
   * is still emitted per app at the pooled unit rate, so per-app scope stays
   * visible and editable. Off by default → single-app + non-poolable lines
   * are unaffected. Only meaningful for `per_unit` volume-tiered slugs.
   */
  poolAcrossEntities?: boolean;
}

export interface RateCardOpenPricedService {
  id: string;
  slug: string;
  displayName: string;
  category?: string | null;
  position: number;
}

export interface RateCard {
  id: string;
  tenantId: string;
  name: string;
  version: number;
  status: RateCardStatus;
  /** ISO 4217 — INR / USD / EUR / GBP. */
  currency: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  serviceLines: RateCardServiceLine[];
  openPricedServices: RateCardOpenPricedService[];
  /**
   * Domain framing for the whole card — the LLM mapper drops this verbatim
   * into its system prompt as the "DOMAIN CONTEXT" block. This is what
   * lets the mapper handle a cleaning-services rate card without any
   * cybersec vocabulary leaking from code: the rate card describes its
   * own world.
   *
   * Example (Prophaze):
   *   "B2B cybersecurity penetration-testing engagements. Each engagement
   *    can cover multiple applications (web apps, APIs, mobile apps) and
   *    discrete infrastructure layers (network, cloud)."
   */
  inferenceContext?: string | null;
  /**
   * Customer-type → methodology mapping rule, again in plain English.
   * The mapper renders this verbatim under "DEFAULT METHODOLOGY:" so the
   * LLM can apply the rule for THIS rate card without the mapper
   * hardcoding it.
   *
   * Example (Prophaze):
   *   "If customerType is 'external' → black_box; if 'internal' → grey_box.
   *    White-box service lines are opt-in: emit only when the doc
   *    explicitly requests source-code review or SCA."
   */
  defaultMethodologyRule?: string | null;
  /**
   * 1–3 input/output worked examples specific to this rate card. The
   * mapper appends them to the prompt as few-shot anchors so the LLM
   * sees domain-specific shape before it tries to read the actual doc.
   *
   * Each example is a self-contained string (markdown rendered into the
   * prompt as-is); kept simple so authors can paste real anonymised
   * examples without us building a structured form yet.
   */
  inferenceExamples?: string[];
  /**
   * Drives the DETERMINISTIC heuristic fallback (used when the LLM mapper is
   * unavailable / rate-limited / returns bad JSON) the same way inferenceHint
   * drives the LLM prompt. WITHOUT this, the fallback uses built-in VAPT
   * defaults — which are inert for a non-VAPT card (they key on the card's own
   * slugs/tokens) but give a non-VAPT tenant no offline coverage. Authoring it
   * makes the offline path domain-correct for ANY industry: each field, when
   * present, REPLACES the corresponding VAPT default wholesale. All pattern
   * fields are regex source strings (case-insensitive); invalid regex is
   * treated as a literal. See rate-card-mapper.service.ts resolveHeuristicConfig.
   */
  heuristicConfig?: RateCardHeuristicConfig | null;
}

/** Per-rate-card configuration for the deterministic heuristic fallback. Every
 *  field is optional; an omitted field falls back to the built-in VAPT default.
 *  This is what makes "all domain knowledge lives in the rate card" true on the
 *  fallback path, not only the LLM-happy path. */
export interface RateCardHeuristicConfig {
  /** token (matched against a service line's slug+displayName) → answer aliases
   *  that count as "this line is mentioned". `domain: true` marks a broad token
   *  that may only gate a slug carrying no driver-specific token. */
  keywordTokens?: Array<{ token: string; aliases: string[]; domain?: boolean }>;
  /** scopeUnit → regex sources that identify the point carrying a line's count. */
  scopeUnitPatterns?: Record<string, string[]>;
  /** Flat/binary lines emitted on an affirmative mention (not a count). */
  binaryTriggers?: Array<{ slug: string; patterns: string[]; positiveValues?: string }>;
  /** Short aliases matched as whole tokens only (avoid substring false hits). */
  ambiguousAliases?: string[];
  /** Service-line slug emitted from a URL-count signal (cloud-instance style). */
  urlCountSlug?: string | null;
  /** Regex sources marking a "strong" (e.g. cloud-provider) URL host. */
  urlStrongHostPatterns?: string[];
  /** Regex sources on the filename that allow generic URLs to count. */
  urlFilenameHintPatterns?: string[];
  /** customerType → methodology fallback when the doc doesn't state one. */
  customerTypeMethodology?: { external?: string; internal?: string };
}

// ── Stage 1: scope normalisation ────────────────────────────────────────────

export interface ScopedEntity {
  /** Stable id within this engagement — e.g. `loop:<loopNodeId>:0` for iter 0. */
  entityId: string;
  /** Slug into the rate card's service_lines. */
  serviceLineSlug: string;
  /** Dimensions used to pick the tier. The pricing engine reads the
   *  one matching the service_line's scope_unit. Extras are ignored. */
  dimensions: {
    pages?: number;
    screens?: number;
    apis?: number;
    loc?: number;
    devices?: number;
    hours?: number;
    other?: number;
  };
  methodology?: Methodology;
  customerType: CustomerType;
  /** Application instance this scope belongs to (wide multi-app
   *  questionnaires). Carried so the priced quote can group + label lines
   *  per application and pool volume across same-slug apps. */
  appId?: string;
}

// ── Stage 2: base price ────────────────────────────────────────────────────

/**
 * One line in the proposal's price table. Every base price has full
 * provenance — the rate-card row picked, the original tier label, and
 * the dimension value that landed there.
 */
export interface BasePriceLine {
  entityId: string;
  serviceLineSlug: string;
  serviceLineName: string;
  /** Application instance, when this line came from a multi-app
   *  questionnaire. Lets the price table group + label rows per app. */
  appId?: string;
  /** Set when this line's tier was chosen on the COMBINED scope of N
   *  pooled application instances (see RateCardServiceLine.poolAcrossEntities):
   *  the number of apps pooled. Lets the UI show a "volume-pooled across N
   *  apps" hint. Absent for normally-priced lines. */
  pooledAcross?: number;
  scopeUnit: ScopeUnit;
  scopeValue: number;
  methodology: Methodology;
  /** Distinct non-null methodology strings this service line's rate-card tiers offer, for an editable picker. Empty ⇒ wildcard/no choice. */
  allowedMethodologies?: string[];
  customerType: CustomerType;
  tierId: string | null;
  tierLabel: string | null;
  priceCents: number;
  /** Pricing model used for this line — same values as the service
   *  line's `pricingModel`. Surfaced so callers (UI, justification)
   *  can show the math correctly: `tier_lookup`/`flat` = bracket flat
   *  fee; `per_unit` = `unitPriceCents × scopeValue`. */
  pricingModel?: PricingModel;
  /** When `pricingModel === 'per_unit'`: the per-unit rate from the
   *  matched tier. Lets the UI render `49 × ₹1,300 = ₹63,700`. Null
   *  for tier_lookup / flat lines (the line price IS the unit price). */
  unitPriceCents?: number | null;
  /** Set when the entity hit an open-priced service slug. */
  manualQuoteRequired?: boolean;
  /** Set when a tier could not be matched. */
  unmatched?: { reason: string };
}

export interface BasePriceResult {
  rateCardId: string;
  rateCardVersion: number;
  currency: string;
  lines: BasePriceLine[];
  /** Sum of priced lines (manual-quote-required + unmatched lines contribute 0). */
  totalCents: number;
  hasManualQuoteRequired: boolean;
  hasUnmatched: boolean;
}

// ── Pure compute function ───────────────────────────────────────────────────

/**
 * Walk each scoped entity through the rate card. For each one:
 *   1. Find the matching service_line by slug.
 *   2. Read the dimension value matching scope_unit.
 *   3. Filter tiers by methodology + customer_type, then by range.
 *   4. Emit a line item with full provenance.
 *
 * No ML, no fuzzy matching, no fallbacks beyond the explicit rules in
 * the rate card. If a tier can't be matched the line is emitted with
 * `unmatched: { reason }` — the manager surface will flag it for human
 * resolution rather than silently zeroing the price.
 */
export function computeBasePrice(
  rateCard: RateCard,
  entities: ScopedEntity[],
): BasePriceResult {
  const linesByService = new Map(rateCard.serviceLines.map((s) => [s.slug, s]));
  const openPricedSlugs = new Set(rateCard.openPricedServices.map((s) => s.slug));

  const lines: BasePriceLine[] = [];
  let totalCents = 0;
  let hasManualQuoteRequired = false;
  let hasUnmatched = false;

  // ── Volume pooling pre-pass (opt-in per slug via poolAcrossEntities) ──
  // When several application instances share a per_unit, volume-tiered
  // service line, price their COMBINED scope at one tier so a multi-app
  // opportunity earns the same volume discount a single large app would.
  // We still emit one line PER app (allocating the pooled unit rate back),
  // so per-app scope stays visible + editable. Pool key includes
  // methodology + customerType because pickTier filters on both — mixing
  // them would price against a tier that matches neither.
  const pooledByEntity = new Map<string, { tier: RateCardTier; count: number }>();
  {
    const groups = new Map<string, ScopedEntity[]>();
    for (const e of entities) {
      const sl = linesByService.get(e.serviceLineSlug);
      if (!sl || sl.pricingModel !== 'per_unit' || !sl.poolAcrossEntities) continue;
      const key = `${e.serviceLineSlug}::${e.methodology ?? ''}::${e.customerType}`;
      const g = groups.get(key);
      if (g) g.push(e);
      else groups.set(key, [e]);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue; // singletons price normally
      const sl = linesByService.get(group[0]!.serviceLineSlug)!;
      const pooledScope = group.reduce((s, e) => s + (e.dimensions[sl.scopeUnit] ?? 0), 0);
      const tier = pickTier(sl.tiers, {
        scopeValue: pooledScope,
        methodology: group[0]!.methodology ?? null,
        customerType: group[0]!.customerType,
      });
      if (!tier) continue; // no pooled tier → each app falls through to its own pricing
      for (const e of group) pooledByEntity.set(e.entityId, { tier, count: group.length });
    }
  }

  for (const e of entities) {
    if (openPricedSlugs.has(e.serviceLineSlug)) {
      const op = rateCard.openPricedServices.find((s) => s.slug === e.serviceLineSlug)!;
      lines.push({
        entityId: e.entityId,
        serviceLineSlug: e.serviceLineSlug,
        serviceLineName: op.displayName,
        ...(e.appId ? { appId: e.appId } : {}),
        scopeUnit: 'other',
        scopeValue: 0,
        methodology: e.methodology ?? null,
        customerType: e.customerType,
        tierId: null,
        tierLabel: null,
        priceCents: 0,
        manualQuoteRequired: true,
      });
      hasManualQuoteRequired = true;
      continue;
    }

    const sl = linesByService.get(e.serviceLineSlug);
    if (!sl) {
      lines.push(unmatchedLine(e, `unknown service line "${e.serviceLineSlug}"`));
      hasUnmatched = true;
      continue;
    }

    const scopeValue = e.dimensions[sl.scopeUnit] ?? 0;

    // When pooled, this app uses the COMBINED-volume tier (so a small app
    // benefits from the opportunity's total scope); otherwise it picks its
    // own tier on its own scope.
    const pooled = pooledByEntity.get(e.entityId);
    const tier = pooled
      ? pooled.tier
      : pickTier(sl.tiers, {
          scopeValue,
          methodology: e.methodology ?? null,
          customerType: e.customerType,
        });
    if (!tier) {
      lines.push({
        entityId: e.entityId,
        serviceLineSlug: e.serviceLineSlug,
        serviceLineName: sl.displayName,
        ...(e.appId ? { appId: e.appId } : {}),
        scopeUnit: sl.scopeUnit,
        scopeValue,
        methodology: e.methodology ?? null,
        customerType: e.customerType,
        tierId: null,
        tierLabel: null,
        priceCents: 0,
        unmatched: { reason: 'no_matching_tier' },
      });
      hasUnmatched = true;
      continue;
    }

    // Pricing-model branches:
    //   tier_lookup → tier.priceCents is the FLAT total for the bracket.
    //   per_unit    → tier.priceCents is the PER-UNIT rate; line = rate × scope.
    //   flat        → tier.priceCents is a single bracket-independent fee.
    //   hourly      → reserved; falls through as flat for now.
    const linePriceCents =
      sl.pricingModel === 'per_unit'
        ? Math.round(tier.priceCents * scopeValue)
        : tier.priceCents;

    lines.push({
      entityId: e.entityId,
      serviceLineSlug: e.serviceLineSlug,
      serviceLineName: sl.displayName,
      ...(e.appId ? { appId: e.appId } : {}),
      ...(pooled ? { pooledAcross: pooled.count } : {}),
      scopeUnit: sl.scopeUnit,
      scopeValue,
      methodology: tier.methodology,
      customerType: tier.customerType,
      tierId: tier.id,
      tierLabel: tier.displayLabel ?? formatTierLabel(tier),
      priceCents: linePriceCents,
      pricingModel: sl.pricingModel,
      unitPriceCents: sl.pricingModel === 'per_unit' ? tier.priceCents : null,
    });
    totalCents += linePriceCents;
  }

  return {
    rateCardId: rateCard.id,
    rateCardVersion: rateCard.version,
    currency: rateCard.currency,
    lines,
    totalCents,
    hasManualQuoteRequired,
    hasUnmatched,
  };
}

function unmatchedLine(e: ScopedEntity, reason: string): BasePriceLine {
  return {
    entityId: e.entityId,
    serviceLineSlug: e.serviceLineSlug,
    serviceLineName: e.serviceLineSlug,
    ...(e.appId ? { appId: e.appId } : {}),
    scopeUnit: 'other',
    scopeValue: 0,
    methodology: e.methodology ?? null,
    customerType: e.customerType,
    tierId: null,
    tierLabel: null,
    priceCents: 0,
    unmatched: { reason },
  };
}

function pickTier(
  tiers: RateCardTier[],
  q: { scopeValue: number; methodology: Methodology; customerType: CustomerType },
): RateCardTier | null {
  for (const t of tiers) {
    if (t.customerType !== q.customerType) continue;
    // Methodology match: rate cards may store null methodology for
    // single-axis service lines (APIs, source code review). Treat null
    // on either side as a wildcard so callers don't have to special-case.
    if (t.methodology !== null && q.methodology !== null && t.methodology !== q.methodology) continue;
    if (q.scopeValue < t.rangeMin) continue;
    if (t.rangeMax !== null && q.scopeValue > t.rangeMax) continue;
    return t;
  }
  return null;
}

function formatTierLabel(t: RateCardTier): string {
  if (t.rangeMax === null) return `${t.rangeMin} & above`;
  if (t.rangeMin === t.rangeMax) return `${t.rangeMin}`;
  return `${t.rangeMin}–${t.rangeMax}`;
}

// ── Stage 1 normaliser ──────────────────────────────────────────────────────

/**
 * Map of (nodeId, iterationIndex) → answer. The gathering service holds
 * answers in this shape already; the normaliser just consumes it.
 */
export type AnswersByIter = Map<string, Map<number, Answer>>;

export interface NormaliseScopeOpts {
  /** Default when no node binds 'customer_type'. Most rate cards bias external. */
  defaultCustomerType?: CustomerType;
  /** Default methodology when no node binds it. Null → null (wildcard match). */
  defaultMethodology?: Methodology;
}

/**
 * Stage 1: walk the template + answers and emit a flat list of
 * ScopedEntities ready for `computeBasePrice`.
 *
 *   1. Top-level nodes with `binding.serviceLineSlug` + `field='scope_value'`
 *      produce ONE entity each (used for "single occurrence" sections —
 *      Network, Cloud — that are not in a loop).
 *   2. Top-level nodes with `field='methodology'` or `field='customer_type'`
 *      set the iteration-wide defaults the loops below inherit.
 *   3. Each loop iteration produces:
 *      a. ONE main entity for the loop's `loopConfig.serviceLineSlug`
 *         (if set), filled by body bindings WITHOUT `serviceLineSlug`.
 *      b. ADDITIONAL entities, one per body node that carries
 *         `binding.serviceLineSlug` — each gets its own scope dimension
 *         from that node's answer. This is what enables Prophaze-shape
 *         multi-driver intake (one Web App loop iteration → 5 driver
 *         entities, one each for dynamic_pages, static_pages, input_fields,
 *         roles, login_modules).
 *
 * The function is pure: same inputs → same scope vector. No DB reads,
 * no IO. Ideal for both the API submit-on-finish path and the editor's
 * "preview a quote with these answers" affordance.
 */
export function normaliseScope(
  tmpl: TemplateWithNodes,
  rateCard: RateCard,
  answers: AnswersByIter,
  opts: NormaliseScopeOpts = {},
): ScopedEntity[] {
  const out: ScopedEntity[] = [];
  const defaultCustomer: CustomerType = opts.defaultCustomerType ?? 'external';
  const defaultMethod: Methodology = opts.defaultMethodology ?? null;

  // Index the rate card by slug so we know each service line's scope_unit.
  const slBySlug = new Map(rateCard.serviceLines.map((s) => [s.slug, s]));

  // Group body children by their parent loop so we walk one loop at a time.
  const bodyByLoop = new Map<string, typeof tmpl.nodes>();
  for (const n of tmpl.nodes) {
    if (!n.parentNodeId) continue;
    const list = bodyByLoop.get(n.parentNodeId) ?? [];
    list.push(n);
    bodyByLoop.set(n.parentNodeId, list);
  }
  for (const list of bodyByLoop.values()) list.sort((a, b) => a.position - b.position);

  // ── Pass 1: top-level methodology / customer_type defaults ──────────
  // These set the *iteration-wide* defaults that loops inherit. We
  // walk top-level (no parent) nodes once and look at iteration 0
  // since there's no loop iteration concept at the top level.
  let templateMethodology: Methodology = defaultMethod;
  let templateCustomerType: CustomerType = defaultCustomer;
  for (const node of tmpl.nodes) {
    if (node.parentNodeId) continue;
    if (node.nodeType === 'loop' || node.nodeType === 'section') continue;
    const binding = (node.binding ?? null) as NodeBinding | null;
    if (!binding?.field) continue;
    const ans = answers.get(node.id)?.get(0);
    if (ans === undefined || ans === null || ans === '') continue;
    const mapped = mapBoundAnswer(ans, binding);
    if (binding.field === 'methodology') {
      templateMethodology = String(mapped);
    } else if (binding.field === 'customer_type') {
      if (mapped === 'internal' || mapped === 'external') {
        templateCustomerType = mapped;
      }
    }
  }

  // ── Pass 2: top-level scope_value with binding.serviceLineSlug ──────
  // These are "single occurrence" entities — Network, Cloud, IDS/IPS/DLP,
  // IAM. Each emits ONE ScopedEntity, no iteration concept. Useful for
  // any intake where the engagement has at most one set of values for
  // that driver.
  for (const node of tmpl.nodes) {
    if (node.parentNodeId) continue;
    if (node.nodeType === 'loop' || node.nodeType === 'section') continue;
    const binding = (node.binding ?? null) as NodeBinding | null;
    if (!binding?.field || binding.field !== 'scope_value') continue;
    const slug = binding.serviceLineSlug;
    if (!slug) continue;
    const sl = slBySlug.get(slug);
    if (!sl) continue;
    const ans = answers.get(node.id)?.get(0);
    if (ans === undefined || ans === null || ans === '') continue;
    const mapped = mapBoundAnswer(ans, binding);
    const num = typeof mapped === 'number' ? mapped : Number(mapped);
    if (!Number.isFinite(num) || num <= 0) continue;
    const dimensions: ScopedEntity['dimensions'] = {};
    dimensions[sl.scopeUnit] = num;
    out.push({
      entityId: `top:${node.id}`,
      serviceLineSlug: slug,
      dimensions,
      methodology: templateMethodology,
      customerType: templateCustomerType,
    });
  }

  // ── Pass 3: loops + per-iteration entities ──────────────────────────
  for (const node of tmpl.nodes) {
    if (node.nodeType !== 'loop') continue;
    const loopMainSlug = node.loopConfig?.serviceLineSlug;
    const body = bodyByLoop.get(node.id) ?? [];
    if (body.length === 0) continue;

    // How many iterations did the responder fill? Read from the answers
    // map: any iteration that has at least one body answer counts.
    const itersFilled = new Set<number>();
    for (const child of body) {
      const inner = answers.get(child.id);
      if (!inner) continue;
      for (const it of inner.keys()) itersFilled.add(it);
    }
    const sortedIters = [...itersFilled].sort((a, b) => a - b);

    for (const iter of sortedIters) {
      // Iteration-wide bindings (methodology, customer_type) override
      // the template-wide defaults for this iteration's entities.
      let iterMethodology: Methodology = templateMethodology;
      let iterCustomerType: CustomerType = templateCustomerType;
      for (const child of body) {
        const ans = answers.get(child.id)?.get(iter);
        if (ans === undefined || ans === null || ans === '') continue;
        const binding = (child.binding ?? null) as NodeBinding | null;
        if (!binding?.field) continue;
        const mapped = mapBoundAnswer(ans, binding);
        if (binding.field === 'methodology') {
          iterMethodology = String(mapped);
        } else if (binding.field === 'customer_type') {
          if (mapped === 'internal' || mapped === 'external') {
            iterCustomerType = mapped;
          }
        }
      }

      // Main entity for the loop's slug (legacy behaviour) — fills
      // dimension from body nodes with `field='scope_value'` and NO
      // serviceLineSlug override.
      let mainScope: number | undefined;
      for (const child of body) {
        const ans = answers.get(child.id)?.get(iter);
        if (ans === undefined || ans === null || ans === '') continue;
        const binding = (child.binding ?? null) as NodeBinding | null;
        if (!binding?.field || binding.field !== 'scope_value') continue;
        if (binding.serviceLineSlug) continue;
        const mapped = mapBoundAnswer(ans, binding);
        const num = typeof mapped === 'number' ? mapped : Number(mapped);
        if (Number.isFinite(num)) {
          mainScope = num;
          break;
        }
      }
      if (loopMainSlug && mainScope !== undefined) {
        const sl = slBySlug.get(loopMainSlug);
        if (sl) {
          const dimensions: ScopedEntity['dimensions'] = {};
          dimensions[sl.scopeUnit] = mainScope;
          out.push({
            entityId: `loop:${node.id}:${iter}`,
            serviceLineSlug: loopMainSlug,
            dimensions,
            methodology: iterMethodology,
            customerType: iterCustomerType,
          });
        }
      }

      // Driver entities — one per body node with `binding.serviceLineSlug`.
      for (const child of body) {
        const ans = answers.get(child.id)?.get(iter);
        if (ans === undefined || ans === null || ans === '') continue;
        const binding = (child.binding ?? null) as NodeBinding | null;
        if (!binding?.field || binding.field !== 'scope_value') continue;
        const slug = binding.serviceLineSlug;
        if (!slug) continue;
        const sl = slBySlug.get(slug);
        if (!sl) continue;
        const mapped = mapBoundAnswer(ans, binding);
        const num = typeof mapped === 'number' ? mapped : Number(mapped);
        if (!Number.isFinite(num) || num <= 0) continue;
        const dimensions: ScopedEntity['dimensions'] = {};
        dimensions[sl.scopeUnit] = num;
        out.push({
          entityId: `loop:${node.id}:${iter}:${child.id}`,
          serviceLineSlug: slug,
          dimensions,
          methodology: iterMethodology,
          customerType: iterCustomerType,
        });
      }
    }
  }
  return out;
}

function mapBoundAnswer(answer: Answer, binding: NodeBinding): unknown {
  // Single-select / short text answers may need translation through the
  // valueMap to land in the rate card's vocabulary.
  if (binding.valueMap && typeof answer === 'string') {
    return binding.valueMap[answer] ?? answer;
  }
  return answer;
}

// ── Stage 3: adaptive adjustment (regime cascade) ───────────────────────────
//
// Built around a strict regime cascade keyed on the count of closed
// engagements for the tenant:
//
//   cold_start   (n_closed < cold_start_until_n_closed)  →  no modifier
//   rules        (n_closed < rules_until_n_closed)       →  loyalty rules
//   linear       (n_closed < linear_until_n_closed)      →  linear regression  [Sprint 2]
//   boosted      (n_closed >= linear_until_n_closed)     →  XGBoost           [Sprint 2]
//
// Sprint 1 implements cold_start + rules. The function shape is unchanged
// when linear/boosted ship — the orchestrator picks the regime, this
// module just executes it deterministically against the inputs.

export const PRICING_REGIMES = ['cold_start', 'rules', 'linear', 'boosted'] as const;
export type Regime = (typeof PRICING_REGIMES)[number];

/**
 * One rule in the loyalty ladder. The rules engine matches the highest-tier
 * rule whose `minLifetimeValueCents` is satisfied by the client snapshot.
 * `discountPct` is signed (negative = discount, positive = premium).
 */
export interface LoyaltyRule {
  /** Stable id used in driver attribution ("loyalty_strategic"). */
  tier: string;
  minLifetimeValueCents: number;
  /** Signed: -0.10 = 10% discount, +0.05 = 5% premium. */
  discountPct: number;
  /** Optional human label for the UI ("Strategic — 10% off"). */
  label?: string;
}

/**
 * Free-form per-tenant multiplier the rules engine can stack on top of
 * the loyalty discount. e.g. {name:"out_of_hours", multiplier:1.25}.
 * Multipliers are applied multiplicatively against the post-loyalty
 * adjustment factor; `appliesWhen` is left to the caller for now.
 */
export interface ManualModifier {
  name: string;
  multiplier: number;
  /** Optional UI hint. */
  label?: string;
}

export interface TenantPricingConfig {
  loyaltyRules: LoyaltyRule[];
  manualModifiers: ManualModifier[];
  coldStartUntilNClosed: number;
  rulesUntilNClosed: number;
  linearUntilNClosed: number;
  retrainHourUtc: number;
}

/**
 * Snapshot of the client's history with this tenant — what the rules
 * engine compares loyalty rules against. The orchestrator builds it
 * from prior closed engagements with the same client_email.
 */
export interface ClientHistorySnapshot {
  totalClosedDeals: number;
  lifetimeValueCents: number;
  /** ISO 8601 of the most recent close. Null if no priors. */
  lastCloseAt: string | null;
}

/**
 * One driver of the adjustment — surfaced in the approval card under
 * "What moved this number?" The shape mirrors what SHAP will output
 * for ML regimes, so the UI doesn't need a regime-specific renderer.
 */
export interface PredictionDriver {
  feature: string;
  /** Signed weight in the same units as adjustmentPct. */
  weight: number;
  direction: 'discount' | 'premium' | 'neutral';
  /** Optional human label ("Strategic loyalty tier · 10% off"). */
  label?: string;
}

export interface AdjustmentResult {
  regime: Regime;
  /** Signed (final/base − 1). 0 in cold_start. */
  adjustmentPct: number;
  drivers: PredictionDriver[];
}

/**
 * Pure adjustment computation. No I/O, no clocks — same inputs always
 * yield the same outputs. The orchestrator passes a `regime` it has
 * already chosen based on the closed-deal count vs tenant thresholds.
 *
 * cold_start: returns `{ adjustmentPct: 0, drivers: [] }` regardless of
 *             rule config or client history. This is explicit, not a
 *             fallback — the UI hides the adjustment tier in this regime.
 *
 * rules:      walks `config.loyaltyRules` for the highest-tier rule the
 *             client lifetime value satisfies, then stacks any matching
 *             `manualModifiers`. Each surviving multiplier emits a driver.
 *
 * linear/boosted: throw — Sprint 2.
 */
export function computeAdjustment(
  _base: BasePriceResult,
  regime: Regime,
  config: TenantPricingConfig,
  history: ClientHistorySnapshot,
): AdjustmentResult {
  if (regime === 'cold_start') {
    return { regime, adjustmentPct: 0, drivers: [] };
  }
  if (regime === 'rules') {
    return runRulesRegime(config, history);
  }
  // Sprint-2 regimes — the orchestrator should never select these yet,
  // but throw a clear error rather than silently returning zero so a
  // misconfigured threshold table doesn't ship a free model upgrade.
  throw new Error(`regime_not_implemented: ${regime}`);
}

function runRulesRegime(
  config: TenantPricingConfig,
  history: ClientHistorySnapshot,
): AdjustmentResult {
  // Pick the highest matching loyalty rule. "Highest" = largest discount
  // (most negative discountPct). A tenant configuring a premium rule
  // (positive pct) gets it picked only when no discount rule matches —
  // matches design intent: loyalty discounts beat surcharges.
  const matching = (config.loyaltyRules ?? [])
    .filter((r) => history.lifetimeValueCents >= r.minLifetimeValueCents);

  const drivers: PredictionDriver[] = [];
  let factor = 1; // 1 + adjustmentPct in product form, easier to compose.

  if (matching.length > 0) {
    const winner = pickWinningLoyaltyRule(matching);
    const direction = winner.discountPct < 0
      ? 'discount'
      : winner.discountPct > 0 ? 'premium' : 'neutral';
    drivers.push({
      feature: `loyalty_${winner.tier}`,
      weight: winner.discountPct,
      direction,
      ...(winner.label ? { label: winner.label } : {}),
    });
    factor *= 1 + winner.discountPct;
  }

  // Manual modifiers are unconditional in this sprint — the rules engine
  // doesn't have enough context to evaluate `appliesWhen` predicates yet.
  // Tenants who wire one in get it on every rules-regime prediction;
  // they can clear the list in the config UI to disable.
  for (const m of config.manualModifiers ?? []) {
    const delta = m.multiplier - 1;
    if (delta === 0) continue;
    factor *= m.multiplier;
    drivers.push({
      feature: `modifier_${m.name}`,
      weight: delta,
      direction: delta < 0 ? 'discount' : 'premium',
      ...(m.label ? { label: m.label } : {}),
    });
  }

  return {
    regime: 'rules',
    adjustmentPct: factor - 1,
    drivers,
  };
}

function pickWinningLoyaltyRule(rules: LoyaltyRule[]): LoyaltyRule {
  // Lowest (most-negative) pct wins; tie-broken by highest threshold so
  // a more-targeted rule beats a generic catch-all.
  return [...rules].sort((a, b) => {
    if (a.discountPct !== b.discountPct) return a.discountPct - b.discountPct;
    return b.minLifetimeValueCents - a.minLifetimeValueCents;
  })[0]!;
}

// ── Regime selection ───────────────────────────────────────────────────────
//
// The orchestrator calls this; kept here so the cascade is one tested
// function instead of an `if/else` ladder duplicated in apps/api and
// (potentially) anywhere else that needs to render regime state.

export function selectRegime(
  closedCount: number,
  config: Pick<
    TenantPricingConfig,
    'coldStartUntilNClosed' | 'rulesUntilNClosed' | 'linearUntilNClosed'
  >,
): Regime {
  if (closedCount < config.coldStartUntilNClosed) return 'cold_start';
  if (closedCount < config.rulesUntilNClosed) return 'rules';
  if (closedCount < config.linearUntilNClosed) return 'linear';
  return 'boosted';
}

// ── Composer ───────────────────────────────────────────────────────────────
//
// Pulls Stage-2 base + Stage-3 adjustment into a single PredictionResult.
// Pure (no DB calls) so unit tests can exercise the full output shape
// without standing up the orchestrator. The orchestrator's only job on
// top of this is loading inputs + persisting the row.

export interface PredictionResult {
  regime: Regime;
  basePriceCents: number;
  predictedPriceCents: number;
  adjustmentPct: number;
  bandLowCents: number;
  bandHighCents: number;
  drivers: PredictionDriver[];
}

/**
 * Combine a deterministic base + an adjustment into a final prediction.
 * Band defaults: ±10% in rules regime (we have *some* signal),
 * ±0% in cold_start (band collapsed onto base — no honest spread to show).
 * Linear/boosted will replace the band heuristic with model-output quantiles.
 */
export function composePrediction(
  base: BasePriceResult,
  adjustment: AdjustmentResult,
  opts: { bandPctOverride?: number } = {},
): PredictionResult {
  const adj = adjustment.adjustmentPct;
  const predicted = Math.round(base.totalCents * (1 + adj));
  const bandPct = opts.bandPctOverride
    ?? (adjustment.regime === 'cold_start' ? 0 : 0.10);
  const spread = Math.round(predicted * bandPct);
  return {
    regime: adjustment.regime,
    basePriceCents: base.totalCents,
    predictedPriceCents: predicted,
    adjustmentPct: adj,
    bandLowCents: Math.max(0, predicted - spread),
    bandHighCents: predicted + spread,
    drivers: adjustment.drivers,
  };
}
