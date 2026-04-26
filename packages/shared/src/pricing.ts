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
  scopeUnit: ScopeUnit;
  scopeValue: number;
  methodology: Methodology;
  customerType: CustomerType;
  tierId: string | null;
  tierLabel: string | null;
  priceCents: number;
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

  for (const e of entities) {
    if (openPricedSlugs.has(e.serviceLineSlug)) {
      const op = rateCard.openPricedServices.find((s) => s.slug === e.serviceLineSlug)!;
      lines.push({
        entityId: e.entityId,
        serviceLineSlug: e.serviceLineSlug,
        serviceLineName: op.displayName,
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

    const tier = pickTier(sl.tiers, {
      scopeValue,
      methodology: e.methodology ?? null,
      customerType: e.customerType,
    });
    if (!tier) {
      lines.push({
        entityId: e.entityId,
        serviceLineSlug: e.serviceLineSlug,
        serviceLineName: sl.displayName,
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

    lines.push({
      entityId: e.entityId,
      serviceLineSlug: e.serviceLineSlug,
      serviceLineName: sl.displayName,
      scopeUnit: sl.scopeUnit,
      scopeValue,
      methodology: tier.methodology,
      customerType: tier.customerType,
      tierId: tier.id,
      tierLabel: tier.displayLabel ?? formatTierLabel(tier),
      priceCents: tier.priceCents,
    });
    totalCents += tier.priceCents;
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
 * Walk every loop in the template that has a `serviceLineSlug` set, and
 * for each fully-answered iteration emit one ScopedEntity. Top-level
 * (non-loop) nodes are ignored for scope today — single-application
 * templates can still be modelled as a one-iteration loop. That keeps
 * Stage 1 simple and removes a class of "what if the user mixed loops
 * with top-level scope?" edge cases until the demand is real.
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

  for (const node of tmpl.nodes) {
    if (node.nodeType !== 'loop') continue;
    const slug = node.loopConfig?.serviceLineSlug;
    if (!slug) continue;
    const sl = slBySlug.get(slug);
    if (!sl) continue;
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
      const dimensions: ScopedEntity['dimensions'] = {};
      let methodology: Methodology = defaultMethod;
      let customerType: CustomerType = defaultCustomer;

      for (const child of body) {
        const ans = answers.get(child.id)?.get(iter);
        if (ans === undefined || ans === null || ans === '') continue;
        const binding = (child.binding ?? null) as NodeBinding | null;
        if (!binding?.field) continue;
        const mapped = mapBoundAnswer(ans, binding);

        if (binding.field === 'scope_value') {
          const num = typeof mapped === 'number' ? mapped : Number(mapped);
          if (Number.isFinite(num)) {
            dimensions[sl.scopeUnit] = num;
          }
          continue;
        }
        if (binding.field === 'methodology') {
          methodology = String(mapped);
          continue;
        }
        if (binding.field === 'customer_type') {
          if (mapped === 'internal' || mapped === 'external') {
            customerType = mapped;
          }
          continue;
        }
      }

      out.push({
        entityId: `loop:${node.id}:${iter}`,
        serviceLineSlug: slug,
        dimensions,
        methodology,
        customerType,
      });
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
