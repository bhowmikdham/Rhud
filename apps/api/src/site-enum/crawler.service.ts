/**
 * Same-origin web crawler used by the site-enumeration feature.
 *
 * MVP shape: pure-Node `fetch`, no headless browser, no JS execution.
 * Sitemap-first (`/sitemap.xml` and `Sitemap:` directives in robots.txt),
 * BFS fallback when no sitemap exists. Honours robots.txt disallows for
 * the same UA we send. Bounded by a max-pages cap (default 500, hard
 * cap 5000), max-depth, per-page timeout, and global timeout.
 *
 * The crawler is intentionally I/O-only: it discovers + fetches pages
 * and yields them. Classification (heuristic + LLM) lives in
 * classifier.service.ts so the crawler stays testable without spinning
 * up an LLM provider.
 */

import { Injectable, Logger } from '@nestjs/common';

import { safeFetch, SsrfError } from './ssrf-guard';

/** Polite UA so server logs can identify and contact us. */
const CRAWLER_UA =
  'RhudSiteEnumerator/1.0 (+https://rhud.app/site-enumeration; contact=support@rhud.app)';

/** Per-request fetch timeout. */
const PAGE_TIMEOUT_MS = 10_000;
/** Whole-crawl timeout — protects against pathological sites with
 *  enormous link graphs. */
const CRAWL_TIMEOUT_MS = 10 * 60 * 1_000;
/** Default crawl budget. Locked to MVP-small per the design plan. */
const DEFAULT_MAX_PAGES = 500;
/** Hard upper bound regardless of caller-supplied options. */
const HARD_MAX_PAGES = 5_000;
/** Default BFS depth from the root. */
const DEFAULT_MAX_DEPTH = 4;
/** Concurrent in-flight HTTP requests per host. */
const CONCURRENCY = 8;
/** Minimum gap between consecutive requests to the same host. */
const MIN_HOST_GAP_MS = 100;
/** Cap on body bytes we'll read per page. Stops a single multi-MB asset
 *  from eating the whole crawl budget. */
const MAX_BODY_BYTES = 1_500_000;

/** Maximum retry attempts on transient (429/503) responses. */
const MAX_RETRIES = 3;

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  includePathRegex?: string;
  excludePathRegex?: string;
}

export interface DiscoveredPage {
  url: string;
  httpStatus: number;
  contentType: string | null;
  /** Page <title> if HTML, derived from filename for non-HTML. */
  title: string | null;
  /** <meta name="description"> or first paragraph snippet (≤300 chars). */
  description: string | null;
  /** Raw HTML body if Content-Type is HTML — passed through to the
   *  classifier, not persisted. Empty for non-HTML. */
  html: string;
  /** Found at this BFS depth from the root (root = 0). */
  depth: number;
  fetchedAt: Date;
  /** What kind of artifact this represents. Defaults to 'page'.
   *  - 'page'        : a fetchable HTML document
   *  - 'api'         : a backend HTTP endpoint discovered via XHR/fetch
   *                    (not navigated to; kept only for scope counting)
   *  - 'integration' : a third-party service detected from preconnect /
   *                    cross-origin script src / cross-origin XHR */
  kind?: 'page' | 'api' | 'integration';
  /** For 'api' kind: HTTP method (GET/POST/...). Empty otherwise. */
  httpMethod?: string;
  /** Number of input controls on the rendered page (`input`, `textarea`,
   *  `select`). Counted by the JS crawler only — for VAPT scoping each
   *  field is a potential injection point. Undefined for non-page kinds
   *  and for the static crawler. */
  formFieldCount?: number;
}

export interface CrawlResult {
  rootUrl: string;
  pages: DiscoveredPage[];
  /** Set when the crawl ended early (cap, timeout, etc.). */
  truncated: boolean;
  /** Sources that contributed seed URLs, useful for diagnostics. */
  seedSources: Array<'sitemap' | 'robots_sitemap' | 'root_bfs' | 'spa_probe'>;
  /** True when the root looks like a JavaScript SPA (empty <div id="root"|"app">
   *  + no anchor tags). When set, the rep should know that crawl coverage is
   *  inherently incomplete for this site. */
  looksLikeSpa: boolean;
  /** True when probe paths were tried but every one of them returned the
   *  exact same body as the root — a SPA catch-all server. In that case
   *  there's only one distinct page at the static layer; pricing should
   *  treat the site as a single SPA-rewrite, not as N pages. */
  spaCatchAll: boolean;
  /** Number of probe paths that were tried (regardless of outcome). */
  probesTried: number;
  /** Number of probe paths whose response was byte-identical to the root
   *  and therefore dropped from `pages`. */
  probesDroppedAsDuplicate: number;
  /** Distinct same-origin JS bundles loaded during the crawl. JS-render
   *  only; the static crawler reports 0. Surfaced in the UI as a
   *  static-asset metric so the rep can see the build's bundle count
   *  (relevant for source-code-review scope on a VAPT). */
  jsBundleCount?: number;
  /** Distinct same-origin CSS files loaded during the crawl. */
  cssFileCount?: number;
  /** Sum of input/select/textarea elements across every rendered page.
   *  Each is a potential VAPT injection point. */
  totalFormFields?: number;
  /** Detected tech stack (WordPress / Shopify / Next.js / Odoo / etc.)
   *  + secondary signals (Razorpay, Supabase, Google OAuth, ...).
   *  JS-render path only. */
  techFingerprint?: {
    platform: string;
    signals: string[];
    generator?: string;
  };
  /** Parsed PWA manifest summary (start_url, scope, shortcuts), when
   *  one was found and parsed. */
  manifest?: {
    name?: string;
    startUrl?: string;
    scope?: string;
    shortcuts: string[];
  } | null;
  /** Spec endpoints actually fetched + parsed (OpenAPI / Swagger /
   *  GraphQL introspection). For audit / "where did this come from". */
  specsFound?: string[];
  /** Service worker URLs that were successfully fetched + harvested. */
  serviceWorkersFound?: string[];
}

/** Common URL paths probed when the BFS yields almost nothing (typical for
 *  SPAs that render all links client-side). Each probe is a single GET; only
 *  ones that return 200 + HTML are kept. The list is intentionally short —
 *  every probe is a real HTTP request to a stranger's server. */
const COMMON_SPA_PROBE_PATHS = [
  '/about', '/about-us',
  '/pricing', '/plans',
  '/blog', '/blogs', '/news',
  '/contact', '/contact-us',
  '/login', '/signin', '/sign-in',
  '/signup', '/register', '/sign-up',
  '/dashboard', '/app',
  '/products', '/features',
  '/docs', '/documentation', '/help', '/faq', '/support',
  '/terms', '/privacy', '/legal',
  '/careers', '/jobs',
  '/portfolio', '/work',
  '/api',
];

@Injectable()
export class CrawlerService {
  private readonly logger = new Logger(CrawlerService.name);

  /** Crawl `rootUrl`, return all same-origin pages discovered up to the
   *  effective cap. Pure I/O — no DB writes, no LLM. */
  async crawl(rootUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
    const start = Date.now();
    const root = this.normaliseUrl(rootUrl);
    const origin = new URL(root).origin;
    const host = new URL(root).host;

    const maxPages = clamp(opts.maxPages ?? DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
    const maxDepth = clamp(opts.maxDepth ?? DEFAULT_MAX_DEPTH, 0, 20);
    const includeRe = compileRegex(opts.includePathRegex);
    const excludeRe = compileRegex(opts.excludePathRegex);

    const robots = await this.fetchRobots(origin).catch(() => null);
    const isAllowed = (path: string): boolean => {
      if (!robots) return true;
      // Deny if any disallow prefix matches. We respect rules for our UA
      // *or* the wildcard group — same as a polite real-world bot.
      for (const rule of robots.disallow) {
        if (rule.length > 0 && path.startsWith(rule)) return false;
      }
      return true;
    };

    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [];
    const pages: DiscoveredPage[] = [];
    const seedSources: CrawlResult['seedSources'] = [];

    // ── Seed: sitemap-first ─────────────────────────────────────────
    const sitemapUrls = await this.discoverSitemapUrls(origin, robots);
    if (sitemapUrls.length > 0) {
      seedSources.push(robots?.sitemaps?.length ? 'robots_sitemap' : 'sitemap');
      for (const u of sitemapUrls) {
        if (visited.has(u)) continue;
        if (new URL(u).host !== host) continue; // same-origin only
        visited.add(u);
        queue.push({ url: u, depth: 0 });
      }
    }
    // Always seed root regardless — sitemap may be incomplete.
    if (!visited.has(root)) {
      visited.add(root);
      queue.push({ url: root, depth: 0 });
      seedSources.push('root_bfs');
    }

    // Per-host pacing — only one host in MVP (same-origin), but the
    // structure is here in case we extend.
    let nextEarliestFetch = 0;
    const inFlight: Set<Promise<void>> = new Set();
    let truncated = false;

    const fetchAndExpand = async (item: { url: string; depth: number }): Promise<void> => {
      // Politeness gap.
      const wait = Math.max(0, nextEarliestFetch - Date.now());
      if (wait > 0) await sleep(wait);
      nextEarliestFetch = Date.now() + MIN_HOST_GAP_MS;

      // Global timeout guard — abort cleanly if we've blown the budget.
      if (Date.now() - start > CRAWL_TIMEOUT_MS) {
        truncated = true;
        return;
      }

      let res: Response;
      try {
        res = await this.fetchWithRetry(item.url);
      } catch (e) {
        this.logger.warn(`crawl fetch failed url=${item.url}: ${(e as Error).message}`);
        // Record the failure as a "page" with status 0 so the rep can
        // see it in the tally — keeps the math honest.
        pages.push({
          url: item.url,
          httpStatus: 0,
          contentType: null,
          title: null,
          description: null,
          html: '',
          depth: item.depth,
          fetchedAt: new Date(),
        });
        return;
      }

      const contentType = res.headers.get('content-type');
      const isHtml = (contentType ?? '').toLowerCase().includes('text/html');

      // Non-HTML resources still count as a discovered URL — they show
      // up in the `attachment` / `media` categories. Read enough body
      // to extract metadata without slurping huge files.
      let body = '';
      if (isHtml) {
        body = await this.readBodyCapped(res, MAX_BODY_BYTES);
      }

      const title = isHtml ? extractTitle(body) : filenameFromUrl(item.url);
      const description = isHtml ? extractDescription(body) : null;

      pages.push({
        url: item.url,
        httpStatus: res.status,
        contentType,
        title,
        description,
        html: body,
        depth: item.depth,
        fetchedAt: new Date(),
      });

      // Expand BFS frontier from this page (HTML only, within depth).
      if (isHtml && item.depth < maxDepth && pages.length < maxPages) {
        const links = extractLinks(body, item.url);
        for (const link of links) {
          if (visited.has(link)) continue;
          const u = new URL(link);
          if (u.host !== host) continue; // same-origin only
          if (!isAllowed(u.pathname)) continue;
          if (includeRe && !includeRe.test(u.pathname)) continue;
          if (excludeRe && excludeRe.test(u.pathname)) continue;
          visited.add(link);
          queue.push({ url: link, depth: item.depth + 1 });
        }
      }
    };

    // BFS loop with a small concurrency window.
    while ((queue.length > 0 || inFlight.size > 0) && pages.length < maxPages) {
      while (queue.length > 0 && inFlight.size < CONCURRENCY && pages.length + inFlight.size < maxPages) {
        const item = queue.shift()!;
        const path = new URL(item.url).pathname;
        if (!isAllowed(path)) continue;
        if (includeRe && !includeRe.test(path)) continue;
        if (excludeRe && excludeRe.test(path)) continue;

        const p = fetchAndExpand(item).finally(() => {
          inFlight.delete(p);
        });
        inFlight.add(p);
      }
      if (inFlight.size > 0) await Promise.race(inFlight);

      // Global timeout guard at the loop level too — we may still have
      // in-flight requests running.
      if (Date.now() - start > CRAWL_TIMEOUT_MS) {
        truncated = true;
        break;
      }
    }
    // Drain any remaining in-flight before returning.
    if (inFlight.size > 0) await Promise.allSettled([...inFlight]);

    if (queue.length > 0 || pages.length >= maxPages) truncated = true;

    // SPA fallback: if the BFS yielded almost nothing AND the root page
    // looks like a JS-rendered SPA, probe a curated list of common
    // routes. We DON'T blindly trust 200 responses — many SPA hosts use
    // a catch-all that returns index.html for any path, which would
    // give us 25 phantom URLs. We compare each probe's response to the
    // root's body fingerprint and DROP byte-identical ones.
    const rootPage = pages.find((p) => p.url === root);
    const looksLikeSpa = rootPage ? detectSpa(rootPage) : false;
    let probesTried = 0;
    let probesDroppedAsDuplicate = 0;
    if (looksLikeSpa && pages.length <= 3 && pages.length < maxPages) {
      seedSources.push('spa_probe');
      const rootSig = rootPage ? bodyFingerprint(rootPage.html) : null;
      const remainingBudget = Math.max(0, maxPages - pages.length);
      const probes = COMMON_SPA_PROBE_PATHS.slice(0, remainingBudget).filter(
        (path) => !visited.has(`${origin}${path}`) && isAllowed(path),
      );
      for (const path of probes) {
        const url = `${origin}${path}`;
        visited.add(url);
        probesTried++;
        const wait = Math.max(0, nextEarliestFetch - Date.now());
        if (wait > 0) await sleep(wait);
        nextEarliestFetch = Date.now() + MIN_HOST_GAP_MS;
        if (Date.now() - start > CRAWL_TIMEOUT_MS) {
          truncated = true;
          break;
        }
        let res: Response;
        try {
          res = await this.fetchWithRetry(url);
        } catch {
          continue;
        }
        if (res.status < 200 || res.status >= 300) continue;
        const ct = (res.headers.get('content-type') ?? '').toLowerCase();
        if (!ct.includes('text/html')) continue;
        const body = await this.readBodyCapped(res, MAX_BODY_BYTES);
        // SPA catch-all guard: identical body to the root means this
        // URL doesn't actually represent a distinct page on the
        // server. Drop it rather than fabricate scope.
        const sig = bodyFingerprint(body);
        if (rootSig && fingerprintsEqual(rootSig, sig)) {
          probesDroppedAsDuplicate++;
          continue;
        }
        pages.push({
          url,
          httpStatus: res.status,
          contentType: res.headers.get('content-type'),
          title: extractTitle(body) ?? path,
          description: extractDescription(body),
          html: body,
          depth: 1,
          fetchedAt: new Date(),
        });
      }
    }

    // SPA catch-all: detected when we tried probes, the site looks SPA-y,
    // and EVERY probe collapsed into the root.
    const spaCatchAll = looksLikeSpa && probesTried > 0 && probesDroppedAsDuplicate === probesTried;

    return {
      rootUrl: root,
      pages,
      truncated,
      seedSources,
      looksLikeSpa,
      spaCatchAll,
      probesTried,
      probesDroppedAsDuplicate,
    };
  }

  /** Fetch + parse robots.txt. Returns null if not present / 404. */
  private async fetchRobots(
    origin: string,
  ): Promise<{ disallow: string[]; sitemaps: string[] } | null> {
    const url = `${origin}/robots.txt`;
    let res: Response;
    try {
      res = await this.fetchWithRetry(url);
    } catch {
      return null;
    }
    if (!res.ok) return null;
    const text = await res.text();
    return parseRobots(text);
  }

  /** Best-effort sitemap discovery. Tries:
   *    1) Sitemap: directives in robots.txt (preferred, source of truth)
   *    2) /sitemap.xml at the root
   *    3) /sitemap_index.xml at the root
   *  Returns a flat list of de-duplicated page URLs.
   */
  private async discoverSitemapUrls(
    origin: string,
    robots: { sitemaps: string[] } | null,
  ): Promise<string[]> {
    const sitemapUrls = new Set<string>();
    const candidates: string[] = [];
    for (const sm of robots?.sitemaps ?? []) candidates.push(sm);
    candidates.push(`${origin}/sitemap.xml`);
    candidates.push(`${origin}/sitemap_index.xml`);

    for (const sm of candidates) {
      const urls = await this.fetchSitemap(sm).catch(() => [] as string[]);
      for (const u of urls) sitemapUrls.add(u);
      if (sitemapUrls.size >= HARD_MAX_PAGES) break;
    }
    return [...sitemapUrls].slice(0, HARD_MAX_PAGES);
  }

  /** Parse a single sitemap or sitemap-index. Recurses one level deep
   *  through index files. Returns the discovered <loc> URLs. */
  private async fetchSitemap(url: string): Promise<string[]> {
    let res: Response;
    try {
      res = await this.fetchWithRetry(url);
    } catch {
      return [];
    }
    if (!res.ok) return [];
    const xml = await this.readBodyCapped(res, MAX_BODY_BYTES);
    const isIndex = /<sitemapindex[\s>]/i.test(xml);
    const locs = extractSitemapLocs(xml);
    if (!isIndex) return locs;
    // Sitemap index — recurse one level only to avoid runaway fetches.
    const out: string[] = [];
    for (const childUrl of locs.slice(0, 20)) {
      const childLocs = await this.fetchSitemap(childUrl).catch(() => []);
      for (const u of childLocs) out.push(u);
      if (out.length >= HARD_MAX_PAGES) break;
    }
    return out;
  }

  /** GET with timeout + retry on 429/503. Throws on non-retriable
   *  network errors after retries are exhausted. */
  private async fetchWithRetry(url: string): Promise<Response> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), PAGE_TIMEOUT_MS);
        try {
          // safeFetch validates the target host (and every redirect hop) is
          // public before connecting — blocks SSRF to metadata/internal IPs.
          const res = await safeFetch(url, {
            method: 'GET',
            headers: { 'user-agent': CRAWLER_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' },
            signal: ctrl.signal,
          });
          if (res.status === 429 || res.status === 503) {
            // Honour Retry-After when present, else exponential backoff.
            const ra = parseInt(res.headers.get('retry-after') ?? '', 10);
            const wait = Number.isFinite(ra) && ra > 0
              ? Math.min(ra * 1000, 5_000)
              : 200 * 2 ** attempt;
            await sleep(wait);
            continue;
          }
          return res;
        } finally {
          clearTimeout(t);
        }
      } catch (e) {
        // A blocked (private/internal) target will never become public — fail
        // immediately rather than burning the retry budget.
        if (e instanceof SsrfError) throw e;
        lastErr = e;
        // Network error — back off and retry unless we've blown attempts.
        if (attempt === MAX_RETRIES) break;
        await sleep(150 * 2 ** attempt);
      }
    }
    throw new Error(
      `fetch_failed_after_${MAX_RETRIES + 1}_attempts: ${(lastErr as Error)?.message ?? 'unknown'}`,
    );
  }

  /** Read response body up to `cap` bytes. Discards anything past so a
   *  pathological asset doesn't OOM the worker. */
  private async readBodyCapped(res: Response, cap: number): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) return await res.text(); // small enough or no streaming
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        if (total + value.length > cap) {
          // Truncate to cap; cancel the rest so the connection closes.
          chunks.push(value.subarray(0, Math.max(0, cap - total)));
          total = cap;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        total += value.length;
      }
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(concatChunks(chunks));
  }

  /** Add scheme if missing, drop fragment, lowercase host. */
  private normaliseUrl(raw: string): string {
    const trimmed = raw.trim();
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const u = new URL(withScheme);
    u.hash = '';
    u.host = u.host.toLowerCase();
    return u.toString();
  }
}

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Compile a regex string from caller input. Invalid regexes return null
 *  rather than throwing — caller behaves as if no filter was supplied. */
export function compileRegex(src?: string): RegExp | null {
  if (!src) return null;
  try {
    return new RegExp(src);
  } catch {
    return null;
  }
}

export function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal robots.txt parser — Disallow + Sitemap directives only. We
 *  collapse all UA groups into a single disallow set since the MVP
 *  doesn't differentiate between them; if a path is disallowed for any
 *  group it counts as off-limits. Conservative on purpose. */
export function parseRobots(text: string): { disallow: string[]; sitemaps: string[] } {
  const disallow: string[] = [];
  const sitemaps: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.replace(/#.*$/, '').trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const directive = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (directive === 'disallow' && value.length > 0) {
      disallow.push(value);
    } else if (directive === 'sitemap' && value.length > 0) {
      sitemaps.push(value);
    }
  }
  return { disallow, sitemaps };
}

/** Pull <loc>…</loc> values out of a sitemap (urlset OR sitemapindex). */
export function extractSitemapLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1]!.trim();
    if (url) locs.push(url);
  }
  return locs;
}

/** Extract <title>…</title>. Returns null when absent. */
export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return decodeHtmlEntities(m[1]!.trim()).slice(0, 300) || null;
}

/** Extract <meta name="description"> or og:description; falls back to
 *  the first paragraph text. Capped to 300 chars. */
export function extractDescription(html: string): string | null {
  const meta = html.match(
    /<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );
  if (meta) return decodeHtmlEntities(meta[1]!).slice(0, 300) || null;
  const og = html.match(
    /<meta\s+[^>]*property=["']og:description["'][^>]*content=["']([^"']*)["'][^>]*>/i,
  );
  if (og) return decodeHtmlEntities(og[1]!).slice(0, 300) || null;
  // First <p> body text.
  const p = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  if (p) {
    const txt = decodeHtmlEntities(stripTags(p[1]!)).trim();
    if (txt) return txt.slice(0, 300);
  }
  return null;
}

/** Extract absolute URLs for every <a href> in the document. Resolves
 *  relative URLs against the supplied base. */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1]!.trim();
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      continue;
    }
    try {
      const abs = new URL(href, baseUrl);
      abs.hash = '';
      out.add(abs.toString());
    } catch {
      // ignore malformed hrefs
    }
  }
  return [...out];
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

/** Decode the handful of HTML entities most commonly seen in titles /
 *  descriptions. Not a full HTML decoder — we don't need one for
 *  classification. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/** Cheap content fingerprint — size + first/last 256 chars + title.
 *  Two responses with the same fingerprint are almost certainly the
 *  same body (SPA catch-all). Avoids full SHA1 hashing for what's a
 *  hot path during the probe pass. */
export interface BodyFingerprint {
  size: number;
  head: string;
  tail: string;
  title: string;
}
export function bodyFingerprint(html: string): BodyFingerprint {
  const size = html.length;
  const head = html.slice(0, 256);
  const tail = size > 256 ? html.slice(size - 256) : '';
  const title = extractTitle(html) ?? '';
  return { size, head, tail, title };
}
export function fingerprintsEqual(a: BodyFingerprint, b: BodyFingerprint): boolean {
  return a.size === b.size && a.title === b.title && a.head === b.head && a.tail === b.tail;
}

/** Heuristic SPA detection — empty mount node + no anchor tags. */
export function detectSpa(rootPage: Pick<DiscoveredPage, 'html'>): boolean {
  const html = rootPage.html ?? '';
  if (!html) return false;
  const hasMount = /<div\s+id\s*=\s*["'](root|app|__next|svelte|qwik)["']/i.test(html);
  const anchorCount = (html.match(/<a\b[^>]*\bhref\s*=\s*["']/gi) ?? []).length;
  return hasMount && anchorCount === 0;
}

function filenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
