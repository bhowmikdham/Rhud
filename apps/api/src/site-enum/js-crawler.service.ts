/**
 * Headless-Chromium crawler — for sites where the static crawler comes
 * up empty because the link graph is rendered client-side (SPAs).
 *
 * Same `CrawlResult` shape as the static `CrawlerService`, so the
 * orchestrator can swap in this implementation transparently when the
 * caller asks for `useJsRendering`. Costs are dramatically higher
 * (each page is a real Chromium navigation + JS execution + network
 * idle wait), so the budget defaults are tighter and the concurrency
 * is lower.
 *
 * Dependency posture: Playwright is lazy-imported the first time we
 * actually crawl. That means the static path keeps working in
 * environments where `playwright install chromium` hasn't been run —
 * only the JS-rendering path will throw with a clear message.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CrawlOptions, CrawlResult, DiscoveredPage } from './crawler.service.js';
import { bodyFingerprint, fingerprintsEqual } from './crawler.service.js';
import {
  detectTechStack,
  platformProbes,
  probeManifest,
  probeServiceWorkers,
  probeSpecs,
  probeWellKnown,
  type TechFingerprint,
  type ManifestSummary,
  type EnrichmentItem,
} from './enrichment.service.js';

const CRAWLER_UA =
  'RhudSiteEnumerator/1.0 (+https://rhud.app/site-enumeration; contact=support@rhud.app; js=playwright)';

/** Default budget for JS crawls. Each page is a full browser
 *  navigation + render — Chromium-heavy. Defaults are an order of
 *  magnitude tighter than the static crawler. */
const DEFAULT_MAX_PAGES = 50;
const HARD_MAX_PAGES = 200;
const DEFAULT_MAX_DEPTH = 3;
const CONCURRENCY = 2;
const PAGE_TIMEOUT_MS = 25_000;
/** Time to give the SPA to finish mounting + settle network. Bumped
 *  from 8s → 15s because slow-mounting React apps (lazy-loaded fonts,
 *  Supabase auth handshakes, 3rd-party SDK loads) routinely keep the
 *  loop open past 8s and that meant we counted forms BEFORE the auth
 *  page mounted them. 15s is still well under the per-page timeout. */
const NETWORK_IDLE_TIMEOUT_MS = 15_000;
/** Extra wait after networkidle (or its timeout) before scraping the
 *  DOM — gives client-side hydration / setState callbacks a final
 *  beat to render forms that were waiting on a fetch response. */
const POST_SETTLE_DELAY_MS = 500;
const CRAWL_TIMEOUT_MS = 10 * 60 * 1_000;

/** Selectors we click after page settle to reveal hidden auth forms,
 *  side-nav drawers, and modal dialogs that contain input fields the
 *  initial render hides. Each candidate is matched case-insensitively
 *  via Playwright's text= and has= locators; we click the first one
 *  that's visible and bail if it would navigate away.
 *
 *  Order matters: most-likely-to-have-hidden-fields first. */
const REVEAL_SELECTORS: string[] = [
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Log in")',
  'button:has-text("Login")',
  'a:has-text("Sign in")',
  'a:has-text("Sign In")',
  'a:has-text("Log in")',
  'a:has-text("Sign up")',
  'a:has-text("Sign Up")',
  'a:has-text("Get started")',
  'a:has-text("Register")',
  // Menu / burger triggers — common SPA nav patterns
  'button[aria-label*="menu" i]',
  'button[aria-label*="navigation" i]',
  'button[aria-expanded="false"]',
];

@Injectable()
export class JsCrawlerService {
  private readonly logger = new Logger(JsCrawlerService.name);

  /** Crawl `rootUrl` using a real headless Chromium browser. Yields
   *  the same shape as the static crawler so the orchestrator can
   *  consume it interchangeably. */
  async crawl(rootUrl: string, opts: CrawlOptions = {}): Promise<CrawlResult> {
    const start = Date.now();
    const root = normaliseUrl(rootUrl);
    const host = new URL(root).host;

    const maxPages = clamp(opts.maxPages ?? DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
    const maxDepth = clamp(opts.maxDepth ?? DEFAULT_MAX_DEPTH, 0, 10);
    const includeRe = compileRegex(opts.includePathRegex);
    const excludeRe = compileRegex(opts.excludePathRegex);

    // Lazy-import Playwright so an unconfigured environment still loads
    // the module — only callers asking for JS rendering eat the error.
    let chromium: typeof import('playwright').chromium;
    try {
      ({ chromium } = await import('playwright'));
    } catch (e) {
      throw new Error(
        `playwright_not_installed: install with "pnpm add playwright && pnpm exec playwright install chromium" — ${(e as Error).message}`,
      );
    }

    let browser: import('playwright').Browser | null = null;
    let context: import('playwright').BrowserContext | null = null;
    try {
      browser = await chromium.launch({
        headless: true,
        // --no-sandbox is needed when running in containers without
        // user-namespace support (typical for production Docker images).
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
      context = await browser.newContext({
        userAgent: CRAWLER_UA,
        viewport: { width: 1280, height: 800 },
        // Reduce non-essential traffic — abort heavy assets.
        // Set up below via route handlers.
      });
      // Block media + analytics so we don't burn time on them. Keeps
      // the browser nimble for the actual link graph traversal.
      await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
      });

      // Capture every XHR/fetch the SPA fires. These reveal backend API
      // endpoints + third-party integrations that aren't visible in any
      // anchor tag. They're the highest-leverage signal for VAPT-style
      // pricing where each API endpoint is its own scope item. Keyed by
      // method + normalised URL (numeric/UUID path params collapsed into
      // `:id`) so paginated routes don't inflate the count.
      const apiKeys = new Set<string>();
      const apiEndpoints: DiscoveredPage[] = [];
      const integrationHosts = new Set<string>();
      context.on('request', (req) => {
        const t = req.resourceType();
        if (t !== 'xhr' && t !== 'fetch') return;
        const u = safeUrl(req.url());
        if (!u) return;
        // Modern bundlers lazy-load JS/CSS chunks via fetch(); Playwright
        // tags those as 'fetch' too. Filter them out by URL pattern so
        // they don't show up as "API endpoints".
        if (looksLikeStaticAsset(u.pathname)) return;
        // Same-origin OR cross-origin both interesting:
        //  - same-origin XHR → likely the app's own backend (`/api/...`)
        //  - cross-origin XHR → integration (Supabase, Razorpay, …)
        const isCrossOrigin = u.host !== host;
        const normPath = normaliseApiPath(u.pathname);
        const key = `${req.method()} ${u.host}${normPath}`;
        if (apiKeys.has(key)) return;
        apiKeys.add(key);
        const looksLikeIntegration = isCrossOrigin && isKnownIntegrationHost(u.host);
        if (looksLikeIntegration) integrationHosts.add(u.host);
        apiEndpoints.push({
          url: `${u.protocol}//${u.host}${normPath}`,
          httpStatus: 0, // filled in by the response listener if it lands
          contentType: null,
          title: `${req.method()} ${normPath}`,
          description: looksLikeIntegration
            ? `Cross-origin call to ${u.host} — likely third-party integration.`
            : `Backend endpoint called from ${u.host}.`,
          html: '',
          depth: -1,
          fetchedAt: new Date(),
          kind: looksLikeIntegration ? 'integration' : 'api',
          httpMethod: req.method(),
        });
      });
      // Track same-origin static assets so we can surface them as
      // metrics. JS bundles also feed the harvester (parsed for API
      // refs). CSS files are counted only — they don't usually drive
      // VAPT scope but the rep wants to see the build is captured.
      const jsBundleUrls = new Set<string>();
      const cssFileUrls = new Set<string>();
      context.on('response', (res) => {
        const u = safeUrl(res.url());
        if (!u) return;
        const ct = (res.headers()['content-type'] ?? '').toLowerCase();
        if (u.host === host) {
          if (
            (ct.includes('javascript') || ct.includes('ecmascript')) &&
            !u.pathname.endsWith('.map')
          ) {
            jsBundleUrls.add(res.url());
          } else if (ct.includes('text/css') || u.pathname.endsWith('.css')) {
            cssFileUrls.add(res.url());
          }
        }
        const normPath = normaliseApiPath(u.pathname);
        const key = `${res.request().method()} ${u.host}${normPath}`;
        if (!apiKeys.has(key)) return;
        const target = apiEndpoints.find((e) =>
          e.url === `${u.protocol}//${u.host}${normPath}` &&
          e.httpMethod === res.request().method(),
        );
        if (target && target.httpStatus === 0) target.httpStatus = res.status();
      });

      const visited = new Set<string>([root]);
      const pages: DiscoveredPage[] = [];
      const queue: Array<{ url: string; depth: number }> = [{ url: root, depth: 0 }];
      let truncated = false;
      const inFlight: Set<Promise<void>> = new Set();

      const visitOne = async (item: { url: string; depth: number }): Promise<void> => {
        if (Date.now() - start > CRAWL_TIMEOUT_MS) {
          truncated = true;
          return;
        }
        const page = await context!.newPage();
        try {
          let res: import('playwright').Response | null = null;
          try {
            res = await page.goto(item.url, {
              waitUntil: 'domcontentloaded',
              timeout: PAGE_TIMEOUT_MS,
            });
          } catch (e) {
            this.logger.warn(`js-crawl goto failed url=${item.url}: ${(e as Error).message}`);
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
          // Best-effort: wait for network to settle so a SPA has a
          // chance to mount + fetch its routes. Falls through quickly
          // if the page never reaches networkidle.
          try {
            await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
          } catch {
            // soft-timeout: some pages keep a long-poll open and
            // never reach idle; we proceed with what we have.
          }
          // Final hydration window — gives setState/effect callbacks a
          // beat to mount forms that were waiting on a fetch response.
          await page.waitForTimeout(POST_SETTLE_DELAY_MS);

          // Reveal-click pass: many SPAs hide the signup/login form
          // behind a button or modal trigger. Counting form fields
          // before clicking those means we miss the bulk of the
          // injection-point scope. Click the first visible reveal
          // trigger (capped at 1 per page so we don't infinite-loop
          // through nested modals), then wait briefly for the form
          // to render.
          const triggered = await this.clickFirstReveal(page);
          if (triggered) {
            await page.waitForTimeout(POST_SETTLE_DELAY_MS);
          }

          const status = res?.status() ?? 0;
          const contentType = res?.headers()['content-type'] ?? null;
          const html = await page.content();
          const title = await page.title().catch(() => '');
          const description = await page
            .$eval('meta[name="description"]', (el) => el.getAttribute('content') ?? '')
            .catch(() => '');
          // Count input controls on the rendered page. Each input /
          // select / textarea is a potential VAPT injection point so
          // it directly affects scope. Counted from the LIVE DOM (not
          // the static HTML) so SPA-rendered forms are included.
          const formFieldCount = await page
            .$$eval('input, textarea, select', (els) => els.length)
            .catch(() => 0);

          pages.push({
            url: item.url,
            httpStatus: status,
            contentType,
            title: title || null,
            description: description || null,
            html,
            depth: item.depth,
            fetchedAt: new Date(),
            formFieldCount,
          });

          // Mine the rendered HTML for declared integration hosts.
          // <link rel="preconnect|dns-prefetch"> + cross-origin
          // <script src> are the most reliable signals — they're put
          // there explicitly because the app needs the third party.
          for (const linkHost of extractDeclaredIntegrationHosts(html, host)) {
            integrationHosts.add(linkHost);
          }

          if (item.depth < maxDepth && pages.length + queue.length < maxPages) {
            // Pull every <a href> from the rendered DOM. Filter to
            // same-origin + de-dupe. SPA frameworks (React Router,
            // Vue Router) render their routes as anchor tags, so this
            // is the bit that makes JS rendering useful.
            // The callback runs inside the browser, so HTMLAnchorElement
            // is available there even though TS in our Node config
            // doesn't have DOM lib types.
            const hrefs: string[] = await page
              .$$eval('a[href]', (anchors) =>
                anchors.map((a) => (a as unknown as { href: string }).href),
              )
              .catch(() => [] as string[]);
            for (const href of hrefs) {
              try {
                const u = new URL(href);
                u.hash = '';
                const norm = u.toString();
                if (visited.has(norm)) continue;
                if (u.host !== host) continue;
                if (includeRe && !includeRe.test(u.pathname)) continue;
                if (excludeRe && excludeRe.test(u.pathname)) continue;
                visited.add(norm);
                queue.push({ url: norm, depth: item.depth + 1 });
                if (visited.size >= maxPages) break;
              } catch {
                // ignore malformed
              }
            }
          }
        } finally {
          await page.close().catch(() => undefined);
        }
      };

      // BFS with bounded concurrency. Tighter than the static crawler
      // because each slot is a Chromium tab.
      while ((queue.length > 0 || inFlight.size > 0) && pages.length < maxPages) {
        while (queue.length > 0 && inFlight.size < CONCURRENCY && pages.length + inFlight.size < maxPages) {
          const item = queue.shift()!;
          const p = visitOne(item).finally(() => {
            inFlight.delete(p);
          });
          inFlight.add(p);
        }
        if (inFlight.size > 0) await Promise.race(inFlight);
        if (Date.now() - start > CRAWL_TIMEOUT_MS) {
          truncated = true;
          break;
        }
      }
      if (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      if (queue.length > 0 || pages.length >= maxPages) truncated = true;

      // Even with JS rendering, some sites are catch-all SPAs that
      // genuinely render the same content for every URL (single-page
      // app with no client-side routing). Detect that and dedupe
      // against the root, same way the static crawler does.
      const rootPage = pages.find((p) => p.url === root);
      const looksLikeSpa = !!rootPage; // by definition — we ran JS rendering
      let probesDroppedAsDuplicate = 0;
      if (rootPage && pages.length > 1) {
        const rootSig = bodyFingerprint(rootPage.html);
        const kept: DiscoveredPage[] = [];
        for (const p of pages) {
          if (p.url === root) {
            kept.push(p);
            continue;
          }
          const sig = bodyFingerprint(p.html);
          if (fingerprintsEqual(rootSig, sig)) {
            probesDroppedAsDuplicate++;
            continue;
          }
          kept.push(p);
        }
        pages.length = 0;
        pages.push(...kept);
      }
      const spaCatchAll = pages.length === 1 && probesDroppedAsDuplicate > 0;

      // Enrichment passes — every signal source the BFS doesn't see
      // naturally. Each is opportunistic: missing data costs nothing
      // (a probe miss is a 4xx); a hit gives us new endpoints.
      const rootPageForEnrich = pages.find((p) => p.url === root);
      const rootSig = rootPageForEnrich
        ? bodyFingerprint(rootPageForEnrich.html)
        : bodyFingerprint('');
      const techFingerprint: TechFingerprint = rootPageForEnrich
        ? detectTechStack(rootPageForEnrich.html, [...jsBundleUrls])
        : { platform: 'unknown', signals: [] };
      const enrichmentItems: EnrichmentItem[] = [];
      const origin = `https://${host}`;

      const [specs, sw, manifest, platformResults, wellKnown] = await Promise.all([
        probeSpecs(context, origin, rootSig),
        probeServiceWorkers(context, origin),
        probeManifest(context, origin),
        platformProbes(context, origin, rootSig, techFingerprint),
        probeWellKnown(context, origin, rootSig),
      ]);
      enrichmentItems.push(...specs.items, ...sw.items, ...manifest.items, ...platformResults, ...wellKnown);

      let manifestSummary: ManifestSummary | null = manifest.manifest;
      const specsFound = specs.specsFound;
      const serviceWorkersFound = sw.foundUrls;

      // Harvest API references declared in the loaded JS bundles. Many
      // SPAs only fire their full backend API surface after auth, so
      // network-level capture alone misses most endpoints. The compiled
      // JS still contains all the table names / RPC names / REST paths —
      // we just have to grep for them. Cheap signal, no auth needed.
      const harvested = await this.harvestJsBundles(
        context,
        host,
        [...jsBundleUrls],
        integrationHosts,
      );
      // Dedupe harvested entries against XHR-captured ones so the count
      // doesn't double-up when a bundle reference also fired at runtime.
      for (const h of harvested) {
        const key = `GET ${safeUrl(h.url)?.host ?? ''}${safeUrl(h.url)?.pathname ?? ''}`;
        if (apiKeys.has(key)) continue;
        apiEndpoints.push(h);
      }

      // Append enrichment items as DiscoveredPage rows so they flow
      // through the same classification + pricing pipeline. Dedupe
      // against URLs we already know about.
      const knownUrls = new Set(pages.map((p) => p.url).concat(apiEndpoints.map((p) => p.url)));
      for (const item of enrichmentItems) {
        if (knownUrls.has(item.url)) continue;
        knownUrls.add(item.url);
        apiEndpoints.push({
          url: item.url,
          httpStatus: 0,
          contentType: null,
          title: item.title,
          description: item.description,
          html: '',
          depth: -1,
          fetchedAt: new Date(),
          kind: item.kind,
          httpMethod: item.httpMethod ?? '',
        });
      }

      // Append the captured API endpoints — keyed already by method+url
      // so dupes are gone. They're attached as DiscoveredPage rows so
      // the existing classifier + persistence path Just Works.
      pages.push(...apiEndpoints);

      // Materialise integration entries (one per host) for the ones we
      // didn't already capture as a cross-origin XHR. This catches
      // declared-but-unused integrations (preconnect/dns-prefetch hints
      // in the HTML that hadn't fired by the time we settled).
      const xhrIntegrationHosts = new Set(
        apiEndpoints.filter((e) => e.kind === 'integration').map((e) => safeUrl(e.url)?.host).filter(Boolean) as string[],
      );
      for (const intHost of integrationHosts) {
        if (xhrIntegrationHosts.has(intHost)) continue;
        pages.push({
          url: `https://${intHost}/`,
          httpStatus: 0,
          contentType: null,
          title: intHost,
          description: `Integration declared via preconnect / dns-prefetch / script src.`,
          html: '',
          depth: -1,
          fetchedAt: new Date(),
          kind: 'integration',
          httpMethod: '',
        });
      }

      const totalFormFields = pages.reduce((n, p) => n + (p.formFieldCount ?? 0), 0);

      return {
        rootUrl: root,
        pages,
        truncated,
        seedSources: ['root_bfs'],
        looksLikeSpa,
        spaCatchAll,
        probesTried: 0,
        probesDroppedAsDuplicate,
        jsBundleCount: jsBundleUrls.size,
        cssFileCount: cssFileUrls.size,
        totalFormFields,
        techFingerprint: techFingerprint.generator
          ? { platform: techFingerprint.platform, signals: techFingerprint.signals, generator: techFingerprint.generator }
          : { platform: techFingerprint.platform, signals: techFingerprint.signals },
        manifest: manifestSummary,
        specsFound,
        serviceWorkersFound,
      };
    } finally {
      await context?.close().catch(() => undefined);
      await browser?.close().catch(() => undefined);
    }
  }

  /** Try to click a reveal-style button (Sign in, Sign up, menu burger,
   *  etc.) so hidden auth forms / drawer menus mount their inputs into
   *  the DOM before we count form fields. Returns true when something
   *  was clicked, false otherwise.
   *
   *  Safety: we capture the URL before clicking and back-navigate if
   *  the click triggered a navigation — we don't want to land on a
   *  totally different page than the BFS thought it was rendering.
   *  Each invocation clicks AT MOST one element. */
  private async clickFirstReveal(
    page: import('playwright').Page,
  ): Promise<boolean> {
    const before = page.url();
    for (const sel of REVEAL_SELECTORS) {
      try {
        const loc = page.locator(sel).first();
        const count = await loc.count();
        if (count === 0) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        // Use a tight timeout — if the element isn't immediately
        // clickable we move on rather than blocking the crawl.
        await loc.click({ timeout: 2_000, trial: false });
        // If the click navigated away, hop back so the rest of this
        // page's processing (form-count, link extract) sees the
        // intended URL.
        if (page.url() !== before) {
          try {
            await page.goBack({ timeout: 5_000, waitUntil: 'domcontentloaded' });
          } catch {
            // If goBack fails, just continue — we'll count whatever
            // is currently rendered.
          }
        }
        return true;
      } catch {
        // Selector mis-matched or click failed — try the next one.
      }
    }
    return false;
  }

  /** Fetch loaded JS bundles + every lazy chunk they reference, parse
   *  each for API references (Supabase table / RPC names + literal
   *  REST paths), and return them as DiscoveredPage entries with
   *  kind='api'. This unlocks the full backend surface even for
   *  unauthenticated SPAs whose route chunks only download after
   *  login: the compiled main bundle still imports their URLs.
   *
   *  Two-pass discovery:
   *   1. Fetch every initially loaded JS bundle.
   *   2. While doing so, scan each one for `[/]?assets/foo.js` strings
   *      and queue any new chunks. Repeat one extra level so chunks-
   *      that-import-chunks are also walked.
   */
  private async harvestJsBundles(
    context: import('playwright').BrowserContext,
    sameOriginHost: string,
    bundleUrls: string[],
    integrationHosts: Set<string>,
  ): Promise<DiscoveredPage[]> {
    if (bundleUrls.length === 0) return [];
    const supabaseHost = [...integrationHosts].find((h) => /\.supabase\.(co|com)$/.test(h))
      ?? 'discovered.supabase.invalid';

    // Pass 1: walk initially loaded bundles + recursively discover
    // any chunk references inside them. Cap defends against
    // pathological builds with thousands of chunks.
    const HARD_BUNDLE_CAP = 150;
    const allBundles = new Set<string>(bundleUrls);
    const queue: string[] = [...bundleUrls];
    const fetched = new Map<string, string>();
    while (queue.length > 0 && fetched.size < HARD_BUNDLE_CAP) {
      const url = queue.shift()!;
      if (fetched.has(url)) continue;
      let text: string;
      try {
        const res = await context.request.get(url, { timeout: 15_000 });
        if (!res.ok()) continue;
        const body = await res.body();
        if (body.length > 700_000) continue; // skip huge chunks
        text = body.toString('utf8');
      } catch {
        continue;
      }
      fetched.set(url, text);
      // Discover lazy chunks referenced inside this bundle. Vite
      // emits chunk paths as plain string literals (with or without a
      // leading slash). Bounded recursion through `queue`.
      for (const m of text.matchAll(/["'`]\/?(assets\/[a-zA-Z0-9._-]+\.js)["'`]/g)) {
        const chunkUrl = `https://${sameOriginHost}/${m[1]}`;
        if (!allBundles.has(chunkUrl)) {
          allBundles.add(chunkUrl);
          queue.push(chunkUrl);
        }
      }

      // Source-map enrichment: many builds publish .js.map files in
      // production. The bundle declares its source map in a trailing
      // `//# sourceMappingURL=...` comment. The map's `sourcesContent`
      // array contains the ORIGINAL (non-minified) source of every
      // module that contributed to the bundle. Parsing that gives
      // dramatically better signal — original variable names, real
      // route definitions, comments referencing APIs.
      const mapMatch = text.match(/\/\/[#@]\s*sourceMappingURL\s*=\s*([^\s\r\n]+)/);
      if (mapMatch) {
        const mapUrl = absoluteUrl(mapMatch[1]!, url);
        try {
          const mapRes = await context.request.get(mapUrl, { timeout: 10_000 });
          if (mapRes.ok()) {
            const mapBody = await mapRes.text();
            if (mapBody.length < 5_000_000) {
              const orig = sourcesContentFromMap(mapBody);
              if (orig) {
                // Append original source to the bundle text so the
                // regex parser sees both views. Minified noise is
                // already low-signal; original source is high-signal.
                fetched.set(url, text + '\n/* ── sourcemap-original ── */\n' + orig);
              }
            }
          }
        } catch {
          // Source map missing / inaccessible — proceed with
          // minified-only parsing.
        }
      }
    }

    // Pass 2: parse every fetched bundle for API references. Dedupe
    // across all bundles by (kind, name).
    const seen = new Set<string>();
    const out: DiscoveredPage[] = [];
    for (const text of fetched.values()) {
      for (const item of parseJsBundleForApis(text)) {
        const key = `${item.kind}:${item.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(harvestedItemToPage(item, sameOriginHost, supabaseHost));
      }
    }
    return out;
  }
}

// ── Pure helpers (mirrored from the static crawler so this module
// stays self-contained — they're tiny and avoid coupling the two
// crawlers' internals just to share a clamp/regex/url helper.) ─────────────

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

function compileRegex(src?: string): RegExp | null {
  if (!src) return null;
  try { return new RegExp(src); } catch { return null; }
}

function normaliseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const u = new URL(withScheme);
  u.hash = '';
  u.host = u.host.toLowerCase();
  return u.toString();
}

function safeUrl(raw: string): URL | null {
  try { return new URL(raw); } catch { return null; }
}

/** True when a URL path looks like a static asset (JS chunk, CSS,
 *  image, font, sourcemap, manifest, etc.) rather than an API call.
 *  Modern bundlers fetch JS/CSS chunks dynamically, so they show up
 *  in the request stream tagged as `fetch`/`xhr` — filter them out
 *  here so the "API endpoints" surface only contains actual data
 *  calls. */
export function looksLikeStaticAsset(pathname: string): boolean {
  return /\.(js|mjs|css|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|wasm|webmanifest|txt|xml|html?|mp4|webm|mp3|wav|pdf|zip)(\?|$)/i.test(pathname);
}

/** Collapse path params into stable buckets so a paginated route like
 *  `/api/v1/portfolios/123` and `/api/v1/portfolios/456` count as one
 *  endpoint instead of N. Conservative — replaces UUIDs and pure
 *  numeric segments only. Anything that looks like a slug is left alone. */
export function normaliseApiPath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':uuid';
      if (/^\d+$/.test(seg)) return ':id';
      return seg;
    })
    .join('/');
}

/** Curated list of hosts that are unambiguously third-party services
 *  worth flagging as an integration scope item. We keep it short and
 *  high-signal — analytics + CDNs are intentionally excluded since
 *  they don't usually drive VAPT scope. Substring match — covers
 *  subdomains (e.g. `xkxicoqoabuyiqpjhzgm.supabase.co`). */
const INTEGRATION_HOST_PATTERNS = [
  // Payment processors (PCI scope drivers)
  'stripe.com', 'razorpay.com', 'paypal.com', 'square.com', 'adyen.com',
  'checkout.com', 'braintree', 'cashfree.com', 'phonepe.com', 'paytm.com',
  // Auth / identity providers (OAuth / SSO scope)
  'auth0.com', 'okta.com', 'clerk.com', 'firebaseapp.com', 'firebase.google.com',
  'accounts.google.com', 'login.microsoftonline.com', 'github.com/login',
  'workos.com', 'cognito-idp', 'amazoncognito.com',
  // Backend-as-a-service (carries its own auth + data layer)
  'supabase.co', 'supabase.com', 'firebaseio.com', 'firebasedatabase.app',
  'xano.io', 'hasura.app', 'pocketbase',
  // SaaS APIs the frontend talks to directly
  'twilio.com', 'sendgrid.com', 'mailgun.org', 'resend.com',
  'algolia.net', 'algolia.com',
  // Headless CMS
  'contentful.com', 'sanity.io', 'strapi', 'prismic.io',
];

export function isKnownIntegrationHost(host: string): boolean {
  const h = host.toLowerCase();
  return INTEGRATION_HOST_PATTERNS.some((p) => h.includes(p));
}

// ── JS bundle parsing ───────────────────────────────────────────────────────
// Recognised reference shapes inside compiled SPA bundles. We're after
// API surface area, not perfect parsing — false positives are OK as long
// as they're stable (each bucket de-dupes by name).

export type HarvestedRefKind = 'supabase_table' | 'supabase_rpc' | 'rest_path';
export interface HarvestedRef {
  kind: HarvestedRefKind;
  /** Bare identifier — table name, RPC function name, or path. */
  name: string;
}

/** Parse a JS bundle's text and return every API reference we recognise.
 *
 *  Supabase clients almost always look like:
 *    supabase.from('users')
 *    supabase.rpc('process_payment', { ... })
 *  After minification:
 *    .from("users") / .rpc("calc_xyz")
 *
 *  We grep for those shapes plus literal API paths. Patterns are
 *  intentionally loose — minified code uses single OR double quotes,
 *  and the leading variable name is gone. */
export function parseJsBundleForApis(text: string): HarvestedRef[] {
  const out: HarvestedRef[] = [];

  // Supabase table refs: .from("name")
  for (const m of text.matchAll(/(?:^|[^a-zA-Z0-9_$])from\(\s*["'`]([a-z_][a-z0-9_]{0,40})["'`]\s*\)/g)) {
    const name = m[1]!;
    if (looksLikeSupabaseIdentifier(name)) out.push({ kind: 'supabase_table', name });
  }
  // Supabase RPC: .rpc("name") or .rpc("name", { args })
  for (const m of text.matchAll(/(?:^|[^a-zA-Z0-9_$])rpc\(\s*["'`]([a-z_][a-z0-9_]{0,60})["'`]/g)) {
    const name = m[1]!;
    if (looksLikeSupabaseIdentifier(name)) out.push({ kind: 'supabase_rpc', name });
  }
  // Literal REST paths: "/api/v1/...", "/rest/...", "/graphql", "/functions/v1/..."
  for (const m of text.matchAll(/["'`](\/(?:api|rest|graphql|functions|v[1-9])\/[a-z0-9][a-z0-9_/-]{0,80})["'`]/gi)) {
    out.push({ kind: 'rest_path', name: m[1]! });
  }
  return out;
}

/** Filter out the noise — random short strings + JS keywords would
 *  otherwise leak in. Real Supabase identifiers are usually 3+ chars,
 *  snake_case, and not JS reserved words. */
function looksLikeSupabaseIdentifier(name: string): boolean {
  if (name.length < 3) return false;
  // Reject pure JS-builtin-looking names ("length", "name", "value", etc.)
  const NOISE = new Set([
    'length', 'name', 'value', 'data', 'error', 'state', 'type', 'props',
    'children', 'key', 'index', 'item', 'items', 'list', 'arr', 'obj',
    'ref', 'event', 'env', 'config', 'options', 'params',
  ]);
  if (NOISE.has(name)) return false;
  return true;
}

/** Convert a HarvestedRef into a DiscoveredPage with kind='api'. The
 *  URL is synthesised from the supabase host (when known) or the same
 *  origin so the persistence layer treats it like any other URL. */
export function harvestedItemToPage(
  item: HarvestedRef,
  sameOriginHost: string,
  supabaseHost: string,
): DiscoveredPage {
  let url: string;
  let title: string;
  let description: string;
  switch (item.kind) {
    case 'supabase_table':
      url = `https://${supabaseHost}/rest/v1/${item.name}`;
      title = `Supabase table: ${item.name}`;
      description = 'Discovered in JS bundle — typically 4 CRUD endpoints (GET list, GET id, POST, PATCH/DELETE).';
      break;
    case 'supabase_rpc':
      url = `https://${supabaseHost}/rest/v1/rpc/${item.name}`;
      title = `Supabase RPC: ${item.name}`;
      description = 'Discovered in JS bundle — POST endpoint executing a server-side function.';
      break;
    case 'rest_path':
      url = `https://${sameOriginHost}${item.name}`;
      title = `REST path: ${item.name}`;
      description = 'Discovered in JS bundle — endpoint string literal in the app code.';
      break;
  }
  return {
    url,
    httpStatus: 0,
    contentType: null,
    title,
    description,
    html: '',
    depth: -1,
    fetchedAt: new Date(),
    kind: 'api',
    httpMethod: '',
  };
}

/** Resolve a possibly-relative URL against a base URL. Used by the
 *  source-map fetcher (the comment URL is usually a sibling like
 *  `index-D1xSlwbd.js.map`) and other relative references. */
export function absoluteUrl(href: string, base: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

/** Extract the concatenated `sourcesContent` array from a source map.
 *  Source maps emitted by Vite/webpack/esbuild include the ORIGINAL
 *  (non-minified) source of every module in `sourcesContent`. We
 *  don't decode the mappings — we only want the original source text
 *  so the existing regex/AST passes can grep over it. Returns null
 *  when the map is malformed or omits `sourcesContent`. */
export function sourcesContentFromMap(mapBody: string): string | null {
  try {
    const parsed = JSON.parse(mapBody) as { sourcesContent?: Array<string | null> };
    if (!parsed.sourcesContent || !Array.isArray(parsed.sourcesContent)) return null;
    const joined = parsed.sourcesContent
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .join('\n');
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}

/** Pull integration hosts declared in the static HTML — preconnect,
 *  dns-prefetch, and cross-origin script src tags. These are reliable
 *  signals because the developer added them deliberately. Only returns
 *  hosts that pass `isKnownIntegrationHost` so we don't flood the rep
 *  with noise (CDNs, fonts, analytics). */
export function extractDeclaredIntegrationHosts(html: string, sameOriginHost: string): string[] {
  const out = new Set<string>();
  const re = /<(?:link|script)\b[^>]*\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const u = new URL(m[1]!, `https://${sameOriginHost}`);
      if (u.host === sameOriginHost) continue;
      if (!isKnownIntegrationHost(u.host)) continue;
      out.add(u.host);
    } catch {
      // ignore malformed
    }
  }
  return [...out];
}
