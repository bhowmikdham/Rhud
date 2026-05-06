/**
 * Map a categorised site enumeration onto the existing pricing engine
 * by emitting a list of `ScopedEntity` records that satisfy
 * `computeBasePrice()`.
 *
 * The rate card is the source of truth. We never invent slugs — every
 * emitted entity targets a slug that genuinely exists on the card.
 * Selection is rate-card-aware:
 *
 *   1. Per-category preference table → first slug from a curated list
 *      of slug names typical for VAPT rate cards.
 *   2. Fallback to substring matching against slug + display name.
 *   3. SPA detection upgrades CMS pages to *dynamic* page tier (higher
 *      per-unit price; reflects that JS-rendered routes carry more
 *      attack surface than truly static pages).
 *   4. Per-slug methodology auto-pick — when a service line's tiers
 *      are all `grey_box` (e.g. login modules), we use grey_box
 *      automatically since black_box would never match.
 *   5. Derived entities for signals not in the category table:
 *        - totalFormFields → vapt_web_app_input_fields
 *        - apiEndpointCount × 1.5 → vapt_api_input_fields (estimated)
 *        - SPA + JS bundles → optional source-code-review hint
 *      Each derived entity is tagged so the UI shows "estimated".
 */

import { Injectable } from '@nestjs/common';
import {
  defaultCategoryToServiceLineSlug,
  type CustomerType,
  type Methodology,
  type RateCard,
  type RateCardServiceLine,
  type ScopedEntity,
  type ScopeUnit,
  type SiteEnumerationCategorySummary,
  type SiteUrlCategory,
} from '@rhud/shared';

/** Signals collected by the crawler that aren't captured in the
 *  per-category counts but still affect VAPT scope. Optional, so
 *  callers from older code paths still work. */
export interface SiteEnumPricingSignals {
  /** Total `<input>` / `<select>` / `<textarea>` across all rendered
   *  pages. Each is a potential injection point. */
  totalFormFields?: number;
  /** Set when the root looks like an SPA — flips CMS page mapping
   *  from static to dynamic. */
  looksLikeSpa?: boolean;
  /** Avg input fields per discovered API endpoint. Used to derive
   *  the estimated `vapt_api_input_fields` count. Default 1.5 — keeps
   *  estimates conservative (many endpoints take just an id + 1 body
   *  field; some take none). */
  apiInputFieldsPerEndpoint?: number;
  /** Customer type to assume. Defaults to 'external' (cold prospect). */
  customerType?: CustomerType;
}

/** Curated preference order per category. The first slug that exists
 *  on the rate card wins. Falls through to substring matching when
 *  none match (so the mapper keeps working on rate cards that use
 *  different naming conventions). */
const PREFERRED_SLUGS_BY_CATEGORY: Record<SiteUrlCategory, string[]> = {
  product:        ['vapt_web_app_dynamic_pages', 'vapt_web_app_static_pages'],
  ecommerce:      ['vapt_web_app_dynamic_pages'],
  blog:           ['vapt_web_app_dynamic_pages', 'vapt_web_app_static_pages'],
  cms:            ['vapt_web_app_static_pages', 'vapt_web_app_dynamic_pages'],
  form:           ['vapt_web_app_dynamic_pages', 'vapt_web_app_static_pages'],
  knowledge_base: ['vapt_web_app_static_pages'],
  attachment:     [], // not usually a VAPT scope item
  members:        ['vapt_web_app_login_modules'],
  media:          [], // images/video usually skipped in VAPT scoping
  module:         ['vapt_web_app_dynamic_pages'],
  api:            ['vapt_api_endpoints'],
  integration:    [], // no good slug on a typical card; surface unmatched
  other:          [],
};

@Injectable()
export class SiteScopeMapperService {
  /** Map per-category counts + crawler signals onto ScopedEntity rows
   *  for `computeBasePrice`. Pure — no DB, no LLM. */
  map(
    summaries: SiteEnumerationCategorySummary[],
    rateCard: RateCard,
    signals: SiteEnumPricingSignals = {},
  ): ScopedEntity[] {
    const customerType: CustomerType = signals.customerType ?? 'external';
    const out: ScopedEntity[] = [];
    const apiEndpointCount = summaries.find((s) => s.category === 'api')?.count ?? 0;

    // ── Per-category direct mapping ───────────────────────────────
    for (const s of summaries) {
      if (s.count <= 0) continue;
      const slug = pickSlugForCategory(s.category, rateCard, signals);
      if (!slug) {
        // Surface as an explicit `other` entity so the rep sees the
        // unmapped count rather than it silently disappearing.
        out.push({
          entityId: `site-enum:${s.category}`,
          serviceLineSlug: 'other',
          dimensions: { other: s.count },
          methodology: null,
          customerType,
        });
        continue;
      }
      const sl = rateCard.serviceLines.find((x) => x.slug === slug);
      if (!sl) continue;
      out.push({
        entityId: `site-enum:${s.category}`,
        serviceLineSlug: slug,
        dimensions: dimensionFor(sl.scopeUnit, s.count),
        methodology: pickMethodology(sl),
        customerType,
      });
    }

    // ── Derived entity: web-app input fields ──────────────────────
    if ((signals.totalFormFields ?? 0) > 0) {
      const sl = findServiceLine(rateCard, ['vapt_web_app_input_fields'])
        ?? findByPattern(rateCard, /input.?field/i, /web|app|frontend/i);
      if (sl) {
        out.push({
          entityId: 'site-enum:web_input_fields',
          serviceLineSlug: sl.slug,
          dimensions: dimensionFor(sl.scopeUnit, signals.totalFormFields!),
          methodology: pickMethodology(sl),
          customerType,
        });
      }
    }

    // ── Derived entity: estimated API input fields ────────────────
    // Honest VAPT scoping: each discovered endpoint usually takes
    // 1-3 input fields (id, body params, query params). We default to
    // 1.5 to stay conservative; the rep can override. The estimate
    // is tagged in entityId so the UI can render it as "estimated".
    if (apiEndpointCount > 0) {
      const factor = signals.apiInputFieldsPerEndpoint ?? 1.5;
      const estimated = Math.max(1, Math.round(apiEndpointCount * factor));
      const sl = findServiceLine(rateCard, ['vapt_api_input_fields'])
        ?? findByPattern(rateCard, /input.?field/i, /api|endpoint|backend/i);
      if (sl) {
        out.push({
          entityId: 'site-enum:api_input_fields:estimated',
          serviceLineSlug: sl.slug,
          dimensions: dimensionFor(sl.scopeUnit, estimated),
          methodology: pickMethodology(sl),
          customerType,
        });
      }
    }

    return out;
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Choose the best rate-card slug for a given category. Tries the
 *  curated PREFERRED_SLUGS list first, then the shared substring
 *  helper as a fallback. SPA detection swaps static_pages → dynamic_pages. */
export function pickSlugForCategory(
  category: SiteUrlCategory,
  rateCard: RateCard,
  signals: SiteEnumPricingSignals,
): string | null {
  let candidates = [...(PREFERRED_SLUGS_BY_CATEGORY[category] ?? [])];
  // SPA upgrade: a "CMS" route on a SPA is dynamic — flip the
  // preferred order so dynamic wins.
  if (signals.looksLikeSpa && (category === 'cms' || category === 'knowledge_base')) {
    candidates = ['vapt_web_app_dynamic_pages', ...candidates];
  }
  for (const slug of candidates) {
    if (rateCard.serviceLines.some((s) => s.slug === slug)) return slug;
  }
  // Fallback to the shared substring helper.
  return defaultCategoryToServiceLineSlug(category, rateCard);
}

/** Pick the right methodology for a service line. When the line has
 *  tiers ONLY for one methodology (e.g. login_modules is grey_box-only),
 *  use that — otherwise null (wildcard, picks any matching tier). */
export function pickMethodology(sl: RateCardServiceLine): Methodology {
  const methodologies = new Set(sl.tiers.map((t) => t.methodology));
  methodologies.delete(null);
  if (methodologies.size === 1) {
    return [...methodologies][0]!;
  }
  // Multiple methodologies present (or none) — let the pricing engine
  // pick the cheapest matching tier by leaving methodology=null.
  return null;
}

/** Find the first service line matching one of the supplied slugs. */
export function findServiceLine(rateCard: RateCard, slugs: string[]): RateCardServiceLine | null {
  for (const slug of slugs) {
    const sl = rateCard.serviceLines.find((s) => s.slug === slug);
    if (sl) return sl;
  }
  return null;
}

/** Find a service line whose slug+name matches BOTH patterns.
 *  Used as a fallback when the preferred slug isn't on the card. */
export function findByPattern(rateCard: RateCard, ...patterns: RegExp[]): RateCardServiceLine | null {
  for (const sl of rateCard.serviceLines) {
    const haystack = `${sl.slug} ${sl.displayName}`.toLowerCase();
    if (patterns.every((re) => re.test(haystack))) return sl;
  }
  return null;
}

/** Build the dimensions object so the value lands on the field the
 *  service line's `scopeUnit` reads. */
function dimensionFor(scopeUnit: ScopeUnit, count: number): ScopedEntity['dimensions'] {
  switch (scopeUnit) {
    case 'pages':   return { pages: count };
    case 'screens': return { screens: count };
    case 'apis':    return { apis: count };
    case 'loc':     return { loc: count };
    case 'devices': return { devices: count };
    case 'hours':   return { hours: count };
    case 'other':   return { other: count };
    default:        return { pages: count };
  }
}
