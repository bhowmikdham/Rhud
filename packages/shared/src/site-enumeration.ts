// Site enumeration — shared contracts for the crawler/classifier feature.
//
// The feature crawls a prospect's existing website (sitemap-first, BFS
// fallback for same-origin links), classifies discovered URLs into the
// canonical category list below, and lets the existing pricing engine
// produce a quote against any rate card by mapping each category onto
// a service-line slug. See apps/api/src/site-enum for the
// implementation; this file holds the wire / persistence shape both API
// and web import.

import type { ScopedEntity, RateCard } from './pricing.js';

/// Canonical URL categories. Stable strings — both the persisted
/// `site_enumeration_pages.category` column and the heuristic /
/// LLM classifier output use these. Add a new category in three places
/// (here, the heuristic table, the rate-card mapper) when extending.
export const SITE_URL_CATEGORIES = [
  'product',         // product/catalog page (e.g. /products/widget-x)
  'ecommerce',       // cart/checkout/listing/payment (e.g. /shop, /cart)
  'blog',            // blog post / news article (e.g. /blog/why-x-matters)
  'cms',             // generic CMS page (about, contact, landing pages)
  'form',            // form-driven page (contact form, lead capture, survey)
  'knowledge_base',  // KB / docs / help center
  'attachment',      // downloadable file (PDF/DOCX/ZIP/etc.)
  'members',         // members-only / portal / account area
  'media',           // image / video gallery
  'module',          // app-specific module (CRM/inventory/accounting screens)
  /// Backend HTTP endpoint discovered via XHR/fetch during JS render or
  /// recognised by URL pattern. Critical for VAPT pricing — APIs are
  /// usually the highest-cost scope item per unit.
  'api',
  /// Third-party service the app integrates with — payment processors,
  /// auth providers, BaaS platforms (Supabase, Firebase). Detected from
  /// preconnect / dns-prefetch / cross-origin script src / cross-origin
  /// XHR. Each integration usually carries its own testing scope (PCI
  /// for payments, OAuth flow for auth, etc.).
  'integration',
  'other',           // didn't fit the above; flagged for human review
] as const;

export type SiteUrlCategory = (typeof SITE_URL_CATEGORIES)[number];

/// Lifecycle of a single enumeration record. Mirrors the Prisma enum
/// constraint in `apps/api/prisma/migrations/.../site_enumeration`.
export type SiteEnumerationStatus =
  | 'pending'
  | 'crawling'
  | 'classifying'
  | 'ready'
  | 'failed'
  | 'retry_queued';

/// Crawl options — passed at kickoff time, snapshotted on the row so a
/// re-crawl reproduces. Hard-cap defaults live alongside the crawler in
/// apps/api/src/site-enum/crawler.service.ts (max 5000 pages).
export interface SiteEnumerationOptions {
  /** Max URLs to crawl + classify. Default 500, hard cap 5000. */
  maxPages?: number;
  /** Max BFS depth from the root. Default 4. */
  maxDepth?: number;
  /** Optional regex (string form). Only paths matching are kept. */
  includePathRegex?: string;
  /** Optional regex (string form). Paths matching are skipped. */
  excludePathRegex?: string;
  /** When true, render every page in headless Chromium (Playwright)
   *  before extracting links. Required for JavaScript SPAs whose link
   *  graph isn't in the static HTML. Slower + heavier — defaults to
   *  false; the UI offers it as a "Re-crawl with JavaScript rendering"
   *  button when SPA catch-all is detected on a static crawl. Tighter
   *  budget caps apply (default 50 pages, hard cap 200). */
  useJsRendering?: boolean;
}

/// One row in the per-category table the UI shows. `count` is the total
/// pages classified into this bucket; `examples` is up to 3 sample
/// `(url, title)` pairs so the rep can sanity-check the classification.
export interface SiteEnumerationCategorySummary {
  category: SiteUrlCategory;
  count: number;
  examples: Array<{ url: string; title: string | null }>;
}

/// Per-rate-card snapshot of the mapper output. Stored under
/// `inferred_entities[rateCardId]` so re-pricing against a different
/// card is instant — same caching pattern as
/// `engagement_files.inferred_entities`.
export interface SiteEnumerationMappedSnapshot {
  rateCardId: string;
  rateCardVersion: number;
  computedAt: string; // ISO 8601
  entities: ScopedEntity[];
}

/// Wire shape returned by `GET /opportunities/:id/site-enumeration`.
/// What the UI consumes directly; null when no enumeration has run yet.
export interface SiteEnumerationStateView {
  id: string;
  engagementId: string;
  siteUrl: string;
  status: SiteEnumerationStatus;
  totalUrls: number;
  classifiedUrls: number;
  startedAt: string | null;
  completedAt: string | null;
  retryAt: string | null;
  attempts: number;
  error: string | null;
  /** Category breakdown, sorted by count desc. Empty array until `ready`. */
  categories: SiteEnumerationCategorySummary[];
  /** Per-rate-card mapped snapshots; empty array if mapper hasn't run. */
  mappedRateCards: SiteEnumerationMappedSnapshot[];
  /** Crawl options that this run used (or null for very old rows). */
  options: SiteEnumerationOptions | null;
  /** Set when the root page looked like a JavaScript SPA (no static
   *  links). The crawler falls back to probing common paths in this
   *  case, but coverage is still inherently incomplete — the UI surfaces
   *  this so the rep knows to scope the SPA as a single-app rewrite
   *  rather than as N pages. */
  looksLikeSpa: boolean;
  /** Set when the SPA fallback ran but EVERY probed path returned the
   *  same body as the root (textbook SPA catch-all routing). In that
   *  case there's exactly one distinct page at the static layer and
   *  we should price as a single SPA-rewrite. */
  spaCatchAll: boolean;
  /** Distinct same-origin JS bundles loaded during the crawl. JS-render
   *  only — 0 for static crawls. Surfaced as a build-size signal. */
  jsBundleCount: number;
  /** Distinct same-origin CSS files loaded during the crawl. */
  cssFileCount: number;
  /** Sum of input/select/textarea elements across every rendered page.
   *  Each is a potential VAPT injection point — directly affects scope. */
  totalFormFields: number;
  /** Detected platform (`wordpress` / `shopify` / `nextjs` / `odoo` /
   *  `vite_react` / `unknown`) + auxiliary signals (Razorpay, Supabase,
   *  Stripe, Google OAuth, …). Null for runs that didn't fingerprint. */
  techFingerprint: TechFingerprint | null;
  /** PWA manifest summary (start_url, scope, shortcuts) when one was
   *  fetched + parsed; null otherwise. */
  manifest: ManifestSummary | null;
  /** Spec endpoints actually fetched + parsed (OpenAPI / Swagger /
   *  GraphQL introspection). Surfaced for audit. */
  specsFound: string[];
  /** Service worker URLs successfully fetched + harvested. */
  serviceWorkersFound: string[];
}

export interface TechFingerprint {
  platform: string;
  signals: string[];
  generator?: string;
}

export interface ManifestSummary {
  name?: string;
  startUrl?: string;
  scope?: string;
  shortcuts: string[];
}

/// Deterministic fallback used when the LLM mapper hasn't run for a
/// given rate card. Walks the rate card's service lines and picks the
/// first slug whose name/slug contains a substring suggestive of the
/// category. Pure — no DB, no LLM. Returns `null` when no service line
/// is even loosely related; the caller (mapper.service) emits a single
/// "other" bucket for the unmapped categories instead of zeroing them.
///
/// The matching is intentionally fuzzy and conservative; the LLM-driven
/// path in `mapper.service.ts` produces better mappings when available.
export function defaultCategoryToServiceLineSlug(
  category: SiteUrlCategory,
  rateCard: Pick<RateCard, 'serviceLines'>,
): string | null {
  const haystack = (slug: string, name: string): string =>
    `${slug} ${name}`.toLowerCase();

  // Substring hints per category — match across slug + displayName.
  const HINTS: Record<SiteUrlCategory, string[]> = {
    product:        ['product', 'catalog', 'item', 'sku'],
    ecommerce:      ['ecommerce', 'shop', 'store', 'cart', 'checkout', 'commerce'],
    blog:           ['blog', 'news', 'article', 'post', 'content'],
    cms:            ['page', 'cms', 'website', 'site', 'web'],
    form:           ['form', 'lead', 'contact', 'survey'],
    knowledge_base: ['kb', 'knowledge', 'docs', 'help', 'support'],
    attachment:     ['attachment', 'document', 'file', 'download'],
    members:        ['members', 'portal', 'account', 'user', 'login'],
    media:          ['media', 'gallery', 'image', 'video', 'asset'],
    module:         ['module', 'app', 'crm', 'inventory', 'accounting', 'erp'],
    // VAPT rate cards typically have an "api" or "rest_api" or
    // "vapt_api" service line — match any slug with "api" in it.
    api:            ['api', 'rest', 'graphql', 'endpoint', 'backend'],
    // Integrations often map to a "third_party_integration" or
    // "integration_test" line. Falls back to 'other' if absent.
    integration:    ['integration', 'third_party', 'sdk', 'connector'],
    other:          [], // never auto-maps; falls through to caller's default
  };

  const wanted = HINTS[category];
  if (wanted.length === 0) return null;
  for (const sl of rateCard.serviceLines) {
    const h = haystack(sl.slug, sl.displayName);
    if (wanted.some((needle) => h.includes(needle))) return sl.slug;
  }
  return null;
}
