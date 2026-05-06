/**
 * Scope Summary — client-facing rendering of the LLM mapper's output.
 *
 * The Layer-3 mapper produces `InferredEntity[]` with slugs, scope
 * values, methodology, confidence, sourceQuote etc. — all useful for
 * pricing but unreadable to a sales rep / external client. The Scope
 * Summary translates that into plain-English groups:
 *
 *   "We read 1 web application (29 dynamic pages, 60 input fields),
 *    1 API surface (23 endpoints, 2 roles), and detected AWS hosting."
 *
 * It's the bridge between the mapper's machine output and the client
 * Review UI. The client confirms the summary BEFORE the form opens —
 * fixing the 'half-empty form is hostile UX' bug.
 *
 * Pure: same inputs → same output. No I/O, no LLM. Used by both the
 * gathering API (server-side rendering into GatheringState) and the
 * opportunity detail page (manager view).
 */

import type { CustomerType, Methodology, RateCard } from './pricing.js';

/**
 * One Inferred entity surfaces in the summary if its confidence >=
 * the threshold caller passes (default 0.6, matching the priced quote
 * threshold). Below-threshold entities are dropped silently.
 */
export interface ScopeSummaryEntityInput {
  serviceLineSlug: string;
  scopeValue: number;
  methodology: Methodology | null;
  customerType: CustomerType;
  confidence: number;
  /** Multi-app grouping key the LLM emitted, e.g. "web_app_1", "api_1". */
  appId?: string;
  /** Verbatim source span — surfaced as "why this value?" tooltip. */
  sourceQuote?: string;
  /** Which file this came from. */
  sourceFile?: string;
}

export interface ScopeSummaryItem {
  /** Display title for this app/asset, e.g. "Web App 1" or "API surface". */
  title: string;
  /** Optional subtitle for context, e.g. "Hosted on AWS · Black-box test". */
  subtitle?: string;
  /** Plain-English bullets, one per driver — "29 dynamic pages",
   *  "23 endpoints", "Admin + Read-only roles". */
  bullets: string[];
  /** Average confidence across this item's entities, [0..1]. */
  confidence: number;
  /** File names this item was sourced from (de-duplicated). */
  sourceFiles: string[];
}

export interface ScopeSummaryGroup {
  /** Section heading shown in the Review UI. */
  label: string;
  /** Used by the UI to pick an icon / colour. */
  domain: 'web_app' | 'api' | 'mobile_ios' | 'mobile_android' | 'network' | 'cloud' | 'other';
  items: ScopeSummaryItem[];
}

export interface ScopeSummary {
  /** Domain-grouped items, sorted by domain priority + appId. */
  groups: ScopeSummaryGroup[];
  /** Total count of entities that made it into the summary. */
  totalItems: number;
  /** True when the summary is empty — UI should fall back to "We
   *  couldn't read anything from your document". */
  isEmpty: boolean;
}

/**
 * Build a Scope Summary from a flat list of inferred entities. Pure;
 * the rate card is used only for displayName lookups (which the LLM
 * doesn't carry in its output).
 *
 * Grouping rules:
 *   - Entities with the same `appId` cluster into one Item.
 *   - Entities without `appId` cluster by slug "domain root" — e.g.
 *     `vapt_network_*` slugs all roll into one Network group; their
 *     items are one per slug (one per device class).
 *   - Domain inference is heuristic on the slug name. Slugs we don't
 *     recognise land in 'other' so nothing is silently dropped.
 *
 * Confidence floor (param) defaults to 0.6 — same as the priced quote
 * threshold so the summary matches what the client sees in the price.
 */
export function buildScopeSummary(
  entities: ScopeSummaryEntityInput[],
  rateCard: RateCard,
  opts: { confidenceFloor?: number } = {},
): ScopeSummary {
  const floor = opts.confidenceFloor ?? 0.6;
  const surviving = entities.filter((e) => e.confidence >= floor);
  if (surviving.length === 0) {
    return { groups: [], totalItems: 0, isEmpty: true };
  }

  const slugMeta = buildSlugMetaIndex(rateCard);

  // Buckets keyed by (domain, appId|null). Within a bucket, multiple
  // entities for different drivers (dynamic_pages, input_fields, …)
  // collate into one Item; each driver becomes a bullet.
  type BucketKey = string;
  const bucketKey = (domain: string, appId: string | undefined): BucketKey =>
    `${domain}::${appId ?? '__solo__'}`;

  const buckets = new Map<BucketKey, {
    domain: ScopeSummaryGroup['domain'];
    appId?: string;
    entries: Array<{
      e: ScopeSummaryEntityInput;
      driverLabel: string;
      domainRoot: string;
    }>;
  }>();

  for (const e of surviving) {
    const meta = slugMeta.get(e.serviceLineSlug);
    if (!meta) continue; // unknown slug — skip silently
    const key = bucketKey(meta.domain, e.appId);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { domain: meta.domain, ...(e.appId ? { appId: e.appId } : {}), entries: [] };
      buckets.set(key, bucket);
    }
    bucket.entries.push({ e, driverLabel: meta.driverLabel, domainRoot: meta.domainRoot });
  }

  // Group buckets by domain so the UI renders one section per domain.
  const groupsByDomain = new Map<ScopeSummaryGroup['domain'], ScopeSummaryGroup>();
  // Sorted appIds so multi-app docs render web_app_1 before web_app_2.
  const bucketsByDomain = new Map<ScopeSummaryGroup['domain'], typeof buckets>();
  for (const [, b] of buckets) {
    const existing = bucketsByDomain.get(b.domain) ?? new Map();
    existing.set(b.appId ?? '__solo__', b);
    bucketsByDomain.set(b.domain, existing);
  }

  // Domain rendering order — web > api > mobile > network > cloud > other.
  // Most engagements lead with apps; infrastructure follows.
  const domainOrder: ScopeSummaryGroup['domain'][] = [
    'web_app', 'api', 'mobile_ios', 'mobile_android', 'network', 'cloud', 'other',
  ];

  for (const domain of domainOrder) {
    const domainBuckets = bucketsByDomain.get(domain);
    if (!domainBuckets || domainBuckets.size === 0) continue;
    const items: ScopeSummaryItem[] = [];

    // Sort items inside the group: appId-bearing items first by appId,
    // solo items by their first slug.
    const sortedKeys = [...domainBuckets.keys()].sort((a, b) => {
      if (a === '__solo__' && b === '__solo__') return 0;
      if (a === '__solo__') return 1;
      if (b === '__solo__') return -1;
      return a.localeCompare(b, 'en', { numeric: true });
    });

    // For solo (__solo__) buckets: emit ONE item per slug rather than
    // collating. e.g. Network: firewalls, routers, switches each get
    // their own Item — no shared appId means no grouping intent.
    for (const key of sortedKeys) {
      const bucket = domainBuckets.get(key)!;
      if (key === '__solo__') {
        for (const entry of bucket.entries) {
          const subtitleParts = methodologySubtitle(entry.e);
          items.push({
            title: rateCard.serviceLines.find((s) => s.slug === entry.e.serviceLineSlug)?.displayName
              ?? entry.driverLabel,
            ...(subtitleParts ? { subtitle: subtitleParts } : {}),
            bullets: [scopeBullet(entry.driverLabel, entry.e.scopeValue)],
            confidence: entry.e.confidence,
            sourceFiles: dedupSourceFiles([entry.e]),
          });
        }
      } else {
        // Grouped bucket — emit ONE Item collating all drivers.
        const item = collateGroupedItem(bucket.entries, bucket.appId!, domain);
        items.push(item);
      }
    }

    groupsByDomain.set(domain, {
      label: GROUP_LABELS[domain],
      domain,
      items,
    });
  }

  const groups = [...groupsByDomain.values()];
  const totalItems = groups.reduce((sum, g) => sum + g.items.length, 0);
  return { groups, totalItems, isEmpty: totalItems === 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────────

const GROUP_LABELS: Record<ScopeSummaryGroup['domain'], string> = {
  web_app:        'Web Applications',
  api:            'APIs',
  mobile_ios:     'iOS Mobile Applications',
  mobile_android: 'Android Mobile Applications',
  network:        'Network Infrastructure',
  cloud:          'Cloud',
  other:          'Other',
};

interface SlugMeta {
  domain: ScopeSummaryGroup['domain'];
  /** Last segment of the slug, used as a driver label fallback. */
  driverLabel: string;
  /** Domain root, e.g. "web_app", "api", "network". Used for grouping
   *  items within domains when appId is absent. */
  domainRoot: string;
}

/**
 * Build a slug → SlugMeta index from the rate card. Domain inference
 * is heuristic on slug shape, not on rate-card metadata — so it works
 * for any rate card whose authors used reasonable naming.
 */
function buildSlugMetaIndex(rateCard: RateCard): Map<string, SlugMeta> {
  const out = new Map<string, SlugMeta>();
  for (const sl of rateCard.serviceLines) {
    out.set(sl.slug, classifySlug(sl.slug, sl.displayName));
  }
  return out;
}

function classifySlug(slug: string, displayName: string): SlugMeta {
  const driverLabel = humaniseDriver(slug, displayName);
  // Match longest-prefix rules first — order matters here so
  // `mobile_ios` doesn't get classified as `mobile`.
  if (/(^|_)mobile_ios(_|$)/.test(slug) || /(\W|^)ios(\W|$)/i.test(displayName)) {
    return { domain: 'mobile_ios', driverLabel, domainRoot: 'mobile_ios' };
  }
  if (/(^|_)mobile_android(_|$)/.test(slug) || /(\W|^)android(\W|$)/i.test(displayName)) {
    return { domain: 'mobile_android', driverLabel, domainRoot: 'mobile_android' };
  }
  if (/(^|_)web_app(_|$)/.test(slug) || /(\W|^)web app(\W|$)/i.test(displayName)) {
    return { domain: 'web_app', driverLabel, domainRoot: 'web_app' };
  }
  if (/(^|_)api(_|$)/.test(slug) || /(\W|^)api(\W|$)/i.test(displayName)) {
    return { domain: 'api', driverLabel, domainRoot: 'api' };
  }
  if (/(^|_)network(_|$)/.test(slug) || /(\W|^)network(\W|$)/i.test(displayName)) {
    return { domain: 'network', driverLabel, domainRoot: 'network' };
  }
  if (/(^|_)cloud(_|$)/.test(slug) || /(\W|^)cloud(\W|$)/i.test(displayName)) {
    return { domain: 'cloud', driverLabel, domainRoot: 'cloud' };
  }
  return { domain: 'other', driverLabel, domainRoot: slug.split('_')[0] ?? 'other' };
}

/**
 * Pull a human driver label out of a slug. "vapt_web_app_dynamic_pages"
 * → "dynamic pages"; "deep_clean_residential" → "deep clean residential".
 * The last 1-2 segments of the slug typically describe the driver.
 */
function humaniseDriver(slug: string, displayName: string): string {
  // Prefer the slash-suffix in displayName when present — that's
  // typically the driver. "VAPT — Web App / Dynamic Pages" → "Dynamic Pages".
  const slashIdx = displayName.lastIndexOf('/');
  if (slashIdx >= 0) {
    return displayName.slice(slashIdx + 1).trim();
  }
  // Fallback: last segment of the slug, with underscores → spaces.
  const segs = slug.split('_');
  // Drop common prefixes like "vapt_", "service_", etc., and use the
  // last 2 meaningful segments.
  const meaningful = segs.filter((s) => s !== 'vapt' && s !== 'service');
  const tail = meaningful.slice(-2).join(' ');
  return tail || slug;
}

function methodologySubtitle(e: ScopeSummaryEntityInput): string | undefined {
  if (!e.methodology) return undefined;
  const meth = e.methodology.replace(/_/g, '-');
  return `${meth} · ${e.customerType}`;
}

/**
 * Compose a "29 dynamic pages" bullet from (driverLabel, scope). Tries
 * to pluralise sensibly when the unit name is plural already.
 */
function scopeBullet(driverLabel: string, scope: number): string {
  const labelLower = driverLabel.trim().toLowerCase();
  // If the label already ends in 's', leave it; otherwise pluralise
  // when scope > 1.
  const pluralised = scope === 1 || labelLower.endsWith('s')
    ? labelLower
    : `${labelLower}s`;
  return `${scope} ${pluralised}`;
}

function dedupSourceFiles(entries: ScopeSummaryEntityInput[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    if (!e.sourceFile) continue;
    if (seen.has(e.sourceFile)) continue;
    seen.add(e.sourceFile);
    out.push(e.sourceFile);
  }
  return out;
}

function collateGroupedItem(
  entries: Array<{ e: ScopeSummaryEntityInput; driverLabel: string; domainRoot: string }>,
  appId: string,
  domain: ScopeSummaryGroup['domain'],
): ScopeSummaryItem {
  const bullets = entries.map((entry) => scopeBullet(entry.driverLabel, entry.e.scopeValue));
  const avgConfidence =
    entries.reduce((sum, entry) => sum + entry.e.confidence, 0) / entries.length;

  // Pull the first non-null methodology + customerType as the subtitle.
  const withMeth = entries.find((entry) => entry.e.methodology != null);
  const subtitle = withMeth
    ? methodologySubtitle(withMeth.e)
    : entries[0]
      ? methodologySubtitle(entries[0].e)
      : undefined;

  return {
    title: appIdToTitle(appId, domain),
    ...(subtitle ? { subtitle } : {}),
    bullets,
    confidence: avgConfidence,
    sourceFiles: dedupSourceFiles(entries.map((entry) => entry.e)),
  };
}

/**
 * "web_app_1" → "Web App 1"; "api_1" → "API 1"; "ios_app_2" → "iOS App 2".
 * Falls back to the appId verbatim when we can't derive a nicer label.
 */
function appIdToTitle(appId: string, domain: ScopeSummaryGroup['domain']): string {
  const m = appId.match(/^([a-z_]+?)_(\d+)$/i);
  if (!m) return appId;
  const stem = m[1]!;
  const n = m[2]!;
  if (stem === 'web_app' || domain === 'web_app') return `Web App ${n}`;
  if (stem === 'api' || domain === 'api') return `API ${n}`;
  if (stem === 'ios_app' || domain === 'mobile_ios') return `iOS App ${n}`;
  if (stem === 'android_app' || domain === 'mobile_android') return `Android App ${n}`;
  // Generic: capitalise stem.
  return `${stem.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())} ${n}`;
}
