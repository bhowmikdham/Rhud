/**
 * Enrichment passes that run AFTER the JS crawler's BFS / network
 * capture / bundle harvesting. Each pass exploits a different
 * over-the-wire signal that the BFS won't naturally see:
 *
 *   - Spec probes      — OpenAPI / Swagger / GraphQL endpoints
 *   - Service worker   — precache URL lists, fetch-handler routes
 *   - Manifest parsing — PWA shortcuts + start_url + scope
 *   - Source maps      — original (non-minified) JS source for parsing
 *   - Tech fingerprint — WordPress / Shopify / Next.js / Razorpay etc.
 *                        → drives platform-specific deeper probes
 *
 * Each pass produces `EnrichmentItem` records that the crawler appends
 * to its `pages` list as `kind='api'` / `kind='page'` / `kind='integration'`.
 *
 * SPA catch-all defence: every probe response is fingerprinted against
 * the root and dropped if identical (lots of SPA hosts serve index.html
 * for every unknown URL — without this guard we'd fabricate scope).
 */

import type { BrowserContext } from 'playwright';
import {
  bodyFingerprint,
  fingerprintsEqual,
  type BodyFingerprint,
  type DiscoveredPage,
} from './crawler.service.js';
import { parseJsBundleForApis, harvestedItemToPage } from './js-crawler.service.js';

// ── Types ───────────────────────────────────────────────────────────────────

export interface TechFingerprint {
  /** Best-guess platform — drives platform-specific probes. */
  platform:
    | 'unknown'
    | 'wordpress'
    | 'shopify'
    | 'nextjs'
    | 'vite_react'
    | 'odoo'
    | 'drupal'
    | 'wix'
    | 'squarespace';
  /** Other platforms / SDKs detected — informational, not gating. */
  signals: string[];
  /** Set when the response carried a `<meta name="generator">` tag. */
  generator?: string;
}

export interface EnrichmentResult {
  /** New items discovered during enrichment. Each carries enough
   *  detail for the crawler to append it to the right bucket. */
  items: EnrichmentItem[];
  /** Tech-stack fingerprint computed during the pass. */
  fingerprint: TechFingerprint;
  /** Manifest contents (parsed start_url + shortcuts), for the UI. */
  manifest: ManifestSummary | null;
  /** Service worker URLs that were successfully fetched + parsed. */
  serviceWorkers: string[];
  /** Spec endpoints that were successfully fetched. */
  specsFound: string[];
}

export interface EnrichmentItem {
  url: string;
  title: string;
  description: string;
  kind: 'api' | 'integration' | 'page';
  httpMethod?: string;
  source:
    | 'openapi'
    | 'swagger'
    | 'graphql_introspection'
    | 'service_worker'
    | 'manifest'
    | 'platform_probe'
    | 'sourcemap'
    | 'wellknown';
}

export interface ManifestSummary {
  name?: string;
  startUrl?: string;
  scope?: string;
  shortcuts: string[];
}

// ── Spec probes (OpenAPI / Swagger / GraphQL) ──────────────────────────────

const OPENAPI_PROBES = [
  '/openapi.json', '/openapi.yaml',
  '/swagger.json', '/swagger.yaml', '/swagger/v1/swagger.json',
  '/api-docs', '/api/docs', '/api/openapi.json', '/api/swagger.json',
  '/.well-known/openapi.json',
  '/v3/api-docs', // Spring Boot default
  '/q/openapi',   // Quarkus default
];

const GRAPHQL_PROBES = ['/graphql', '/api/graphql', '/v1/graphql'];

/** Try each spec URL, parse the response, and emit endpoint items.
 *  Rejects SPA catch-all responses by fingerprint AND by content-type.
 *  Spec content MUST be JSON (or YAML for OpenAPI) — anything that
 *  comes back as text/html is a router fallback, not a spec. */
export async function probeSpecs(
  context: BrowserContext,
  origin: string,
  rootSig: BodyFingerprint,
): Promise<{ items: EnrichmentItem[]; specsFound: string[] }> {
  const items: EnrichmentItem[] = [];
  const specsFound: string[] = [];

  // OpenAPI / Swagger
  for (const path of OPENAPI_PROBES) {
    const hit = await fetchIfRealJson(context, `${origin}${path}`, rootSig);
    if (!hit) continue;
    const spec = tryParseOpenApi(hit.body);
    if (!spec) continue;
    specsFound.push(path);
    for (const endpoint of expandOpenApiPaths(spec, origin)) {
      items.push({
        url: endpoint.url,
        title: `${endpoint.method} ${endpoint.path}`,
        description: `Discovered in OpenAPI spec at ${path} — declared endpoint with full method + parameter list.`,
        kind: 'api',
        httpMethod: endpoint.method,
        source: spec.swagger ? 'swagger' : 'openapi',
      });
    }
    break; // one spec is enough; further probes would just rediscover
  }

  // GraphQL introspection
  for (const path of GRAPHQL_PROBES) {
    const hit = await graphqlIntrospect(context, `${origin}${path}`, rootSig);
    if (!hit) continue;
    specsFound.push(path);
    for (const opName of hit.operationNames) {
      items.push({
        url: `${origin}${path}#${opName}`,
        title: `GraphQL: ${opName}`,
        description: `Discovered via GraphQL introspection at ${path} — ${hit.operationNames.length} top-level operations exposed.`,
        kind: 'api',
        httpMethod: 'POST',
        source: 'graphql_introspection',
      });
    }
    break;
  }

  return { items, specsFound };
}

/** Fetch a URL; return the body only if it parses as JSON AND is
 *  distinct from the root (rejects SPA catch-all). */
async function fetchIfRealJson(
  context: BrowserContext,
  url: string,
  rootSig: BodyFingerprint,
): Promise<{ body: string; ct: string } | null> {
  try {
    const res = await context.request.get(url, { timeout: 10_000 });
    if (!res.ok()) return null;
    const ct = (res.headers()['content-type'] ?? '').toLowerCase();
    const body = await res.text();
    // SPA catch-all: many SPAs return 200 + index.html for unknown
    // routes. Reject if fingerprint matches root.
    if (fingerprintsEqual(bodyFingerprint(body), rootSig)) return null;
    // Spec responses MUST not be HTML.
    if (ct.includes('text/html')) return null;
    if (!ct.includes('json') && !ct.includes('yaml') && !/^[{\[]/.test(body.trim())) {
      return null;
    }
    return { body, ct };
  } catch {
    return null;
  }
}

/** Issue a GraphQL introspection query. Many schemas leave it on. */
async function graphqlIntrospect(
  context: BrowserContext,
  url: string,
  rootSig: BodyFingerprint,
): Promise<{ operationNames: string[] } | null> {
  try {
    const res = await context.request.post(url, {
      timeout: 10_000,
      headers: { 'content-type': 'application/json' },
      data: JSON.stringify({
        query: '{ __schema { queryType { name fields { name } } mutationType { name fields { name } } } }',
      }),
    });
    if (!res.ok()) return null;
    const ct = (res.headers()['content-type'] ?? '').toLowerCase();
    if (!ct.includes('json')) return null;
    const body = await res.text();
    if (fingerprintsEqual(bodyFingerprint(body), rootSig)) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { return null; }
    const data = (parsed as { data?: { __schema?: { queryType?: { fields?: Array<{ name: string }> }; mutationType?: { fields?: Array<{ name: string }> } } } }).data;
    if (!data?.__schema) return null;
    const queries = data.__schema.queryType?.fields?.map((f) => `query.${f.name}`) ?? [];
    const mutations = data.__schema.mutationType?.fields?.map((f) => `mutation.${f.name}`) ?? [];
    if (queries.length === 0 && mutations.length === 0) return null;
    return { operationNames: [...queries, ...mutations] };
  } catch {
    return null;
  }
}

/** Walk the OpenAPI / Swagger 2 paths object → flat endpoint list. */
export function expandOpenApiPaths(
  spec: OpenApiSpec,
  origin: string,
): Array<{ url: string; method: string; path: string }> {
  const out: Array<{ url: string; method: string; path: string }> = [];
  if (!spec.paths || typeof spec.paths !== 'object') return out;
  for (const [path, ops] of Object.entries(spec.paths)) {
    if (!ops || typeof ops !== 'object') continue;
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      if ((ops as Record<string, unknown>)[method]) {
        out.push({ url: `${origin}${path}`, method: method.toUpperCase(), path });
      }
    }
  }
  return out;
}

interface OpenApiSpec {
  openapi?: string;
  swagger?: string;
  paths?: Record<string, unknown>;
}

export function tryParseOpenApi(body: string): OpenApiSpec | null {
  try {
    const parsed = JSON.parse(body) as OpenApiSpec;
    if (!parsed.openapi && !parsed.swagger) return null;
    if (!parsed.paths) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Service worker parsing ─────────────────────────────────────────────────

const SW_PROBES = ['/sw.js', '/service-worker.js', '/sw-push.js', '/workbox-sw.js'];

/** Fetch each known service-worker URL, harvest URL string literals
 *  + obvious cache list patterns. */
export async function probeServiceWorkers(
  context: BrowserContext,
  origin: string,
): Promise<{ items: EnrichmentItem[]; foundUrls: string[] }> {
  const items: EnrichmentItem[] = [];
  const foundUrls: string[] = [];
  const seen = new Set<string>();

  for (const path of SW_PROBES) {
    try {
      const res = await context.request.get(`${origin}${path}`, { timeout: 8_000 });
      if (!res.ok()) continue;
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      if (!ct.includes('javascript') && !ct.includes('ecmascript')) continue;
      const body = await res.text();
      foundUrls.push(`${origin}${path}`);
      // Reuse the JS bundle harvester — service workers are JS too,
      // so any /api/, /functions/ paths in them get picked up.
      for (const ref of parseJsBundleForApis(body)) {
        const key = `${ref.kind}:${ref.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const page = harvestedItemToPage(ref, originHostOf(origin), 'discovered.supabase.invalid');
        items.push({
          url: page.url,
          title: page.title ?? '',
          description: `Discovered in service worker ${path} — ${ref.kind} reference "${ref.name}".`,
          kind: 'api',
          httpMethod: page.httpMethod ?? 'GET',
          source: 'service_worker',
        });
      }
      // Also scan for any same-origin URL string literals — these
      // are usually the SW's precache list.
      for (const m of body.matchAll(/["'`](\/[a-z][a-z0-9_/.?=&-]{2,80})["'`]/gi)) {
        const url = `${origin}${m[1]}`;
        if (seen.has(url)) continue;
        seen.add(url);
        // Skip obviously-static asset paths (the SW caches them but
        // they're not API surface).
        if (/\.(js|css|png|jpe?g|svg|ico|woff2?|webmanifest)(\?|$)/i.test(m[1]!)) continue;
        items.push({
          url,
          title: m[1]!,
          description: `URL string literal found in service worker ${path}.`,
          kind: 'page',
          source: 'service_worker',
        });
      }
    } catch {
      // continue
    }
  }
  return { items, foundUrls };
}

function originHostOf(origin: string): string {
  try { return new URL(origin).host; } catch { return origin; }
}

// ── Manifest parsing (PWA manifest) ────────────────────────────────────────

const MANIFEST_PROBES = ['/manifest.webmanifest', '/manifest.json', '/site.webmanifest'];

export async function probeManifest(
  context: BrowserContext,
  origin: string,
): Promise<{ items: EnrichmentItem[]; manifest: ManifestSummary | null }> {
  for (const path of MANIFEST_PROBES) {
    try {
      const res = await context.request.get(`${origin}${path}`, { timeout: 8_000 });
      if (!res.ok()) continue;
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      if (!ct.includes('json') && !ct.includes('manifest')) continue;
      const body = await res.text();
      const parsed = tryParseManifest(body);
      if (!parsed) continue;
      const items: EnrichmentItem[] = [];
      // Each shortcut points to a route the app considers "important
      // enough to expose as a launcher". Always priced as a page.
      for (const sc of parsed.shortcuts) {
        items.push({
          url: new URL(sc, origin).toString(),
          title: `PWA shortcut: ${sc}`,
          description: `Declared as a shortcut in ${path}.`,
          kind: 'page',
          source: 'manifest',
        });
      }
      // start_url too, if it's not "/"
      if (parsed.startUrl && parsed.startUrl !== '/') {
        items.push({
          url: new URL(parsed.startUrl, origin).toString(),
          title: `PWA start_url: ${parsed.startUrl}`,
          description: `Declared start_url in ${path}.`,
          kind: 'page',
          source: 'manifest',
        });
      }
      return { items, manifest: parsed };
    } catch {
      // try next
    }
  }
  return { items: [], manifest: null };
}

export function tryParseManifest(body: string): ManifestSummary | null {
  try {
    const m = JSON.parse(body) as {
      name?: string;
      start_url?: string;
      scope?: string;
      shortcuts?: Array<{ url?: string }>;
    };
    if (!m || typeof m !== 'object') return null;
    const out: ManifestSummary = {
      shortcuts: (m.shortcuts ?? [])
        .map((s) => s.url)
        .filter((u): u is string => typeof u === 'string'),
    };
    if (typeof m.name === 'string') out.name = m.name;
    if (typeof m.start_url === 'string') out.startUrl = m.start_url;
    if (typeof m.scope === 'string') out.scope = m.scope;
    return out;
  } catch {
    return null;
  }
}

// ── Tech-stack fingerprinting ──────────────────────────────────────────────

/** Detect the platform from the rendered HTML + headers + script src
 *  patterns. Returns the best-guess platform plus a list of secondary
 *  signals. Used to drive platform-specific probes. */
export function detectTechStack(rootHtml: string, jsBundleUrls: string[]): TechFingerprint {
  const haystack = rootHtml.toLowerCase();
  const bundleString = jsBundleUrls.join('\n').toLowerCase();
  const signals: string[] = [];

  // Generator meta tag — most reliable single signal.
  const genMatch = rootHtml.match(/<meta\s+name=["']generator["']\s+content=["']([^"']+)["']/i);
  const generator = genMatch?.[1];

  let platform: TechFingerprint['platform'] = 'unknown';

  // WordPress
  if (haystack.includes('/wp-content/') || haystack.includes('/wp-includes/') ||
      haystack.includes('wp-emoji') || /generator["']\s+content=["']wordpress/i.test(rootHtml)) {
    platform = 'wordpress';
    signals.push('wp-content paths', 'wp-includes paths');
  }
  // Shopify
  else if (haystack.includes('cdn.shopify.com') || haystack.includes('shopify.theme') ||
           haystack.includes('window.shopify')) {
    platform = 'shopify';
    signals.push('shopify cdn / theme globals');
  }
  // Next.js
  else if (haystack.includes('/_next/') || bundleString.includes('_next/static/')) {
    platform = 'nextjs';
    signals.push('Next.js _next/static paths');
  }
  // Odoo
  else if (haystack.includes('/web/static/') || haystack.includes('odoo.session_info') ||
           haystack.includes('window.odoo')) {
    platform = 'odoo';
    signals.push('Odoo /web/static + session_info');
  }
  // Drupal
  else if (haystack.includes('/sites/all/modules/') || /generator["']\s+content=["']drupal/i.test(rootHtml)) {
    platform = 'drupal';
    signals.push('Drupal sites/all/modules');
  }
  // Vite + React (catch-all for modern SPAs that aren't on a CMS)
  else if (bundleString.includes('vendor-react-') || bundleString.includes('vendor-vue-') ||
           rootHtml.includes('<div id="root"') || rootHtml.includes('<div id="app"')) {
    platform = 'vite_react';
    signals.push('Vite/React SPA shell');
  }

  // Always-on signals (informational)
  if (haystack.includes('razorpay')) signals.push('Razorpay');
  if (haystack.includes('stripe')) signals.push('Stripe');
  if (haystack.includes('supabase')) signals.push('Supabase');
  if (haystack.includes('firebase')) signals.push('Firebase');
  if (haystack.includes('accounts.google.com')) signals.push('Google OAuth');
  if (haystack.includes('clerk.com')) signals.push('Clerk auth');
  if (haystack.includes('auth0.com')) signals.push('Auth0');

  return generator ? { platform, signals, generator } : { platform, signals };
}

// ── Platform-specific probes ──────────────────────────────────────────────

const PLATFORM_PROBES: Record<TechFingerprint['platform'], string[]> = {
  unknown:    [],
  wordpress:  ['/wp-json/wp/v2/users', '/wp-json/wp/v2/posts', '/wp-json/wp/v2/pages',
               '/wp-json/wp/v2/categories', '/wp-json/wp/v2/tags', '/wp-json/wp/v2/comments',
               '/wp-json/wp/v2/media', '/wp-json/oembed/1.0/embed'],
  shopify:    ['/products.json', '/collections.json', '/blogs.json'],
  nextjs:     ['/_next/data/', '/api/auth/providers', '/api/auth/session'],
  vite_react: [],
  odoo:       ['/web/database/list', '/web/login', '/web/session/get_session_info', '/website/info'],
  drupal:     ['/jsonapi/node', '/user/login', '/admin/config'],
  wix:        [],
  squarespace: [],
};

export async function platformProbes(
  context: BrowserContext,
  origin: string,
  rootSig: BodyFingerprint,
  fingerprint: TechFingerprint,
): Promise<EnrichmentItem[]> {
  const probes = PLATFORM_PROBES[fingerprint.platform] ?? [];
  if (probes.length === 0) return [];
  const items: EnrichmentItem[] = [];
  for (const path of probes) {
    try {
      const res = await context.request.get(`${origin}${path}`, { timeout: 8_000 });
      if (!res.ok()) continue;
      const body = await res.text();
      // Reject SPA catch-all and HTML responses to API paths.
      if (fingerprintsEqual(bodyFingerprint(body), rootSig)) continue;
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      if (ct.includes('text/html') && !path.includes('login')) continue;
      items.push({
        url: `${origin}${path}`,
        title: path,
        description: `Platform probe (${fingerprint.platform}) hit ${path} → ${res.status()} ${ct.slice(0, 40)}.`,
        kind: 'api',
        httpMethod: 'GET',
        source: 'platform_probe',
      });
    } catch {
      // continue
    }
  }
  return items;
}

// ── /.well-known/security.txt — sometimes lists API paths ───────────────────

export async function probeWellKnown(
  context: BrowserContext,
  origin: string,
  rootSig: BodyFingerprint,
): Promise<EnrichmentItem[]> {
  const items: EnrichmentItem[] = [];
  const candidates = [
    '/.well-known/security.txt',
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
  ];
  for (const path of candidates) {
    try {
      const res = await context.request.get(`${origin}${path}`, { timeout: 8_000 });
      if (!res.ok()) continue;
      const ct = (res.headers()['content-type'] ?? '').toLowerCase();
      const body = await res.text();
      if (fingerprintsEqual(bodyFingerprint(body), rootSig)) continue;
      if (ct.includes('text/html')) continue;
      items.push({
        url: `${origin}${path}`,
        title: path,
        description: `Discovered ${path} — ${ct.slice(0, 40)} (${body.length} bytes).`,
        kind: 'page',
        source: 'wellknown',
      });
      // For OIDC/OAuth, parse the JSON and pull the listed endpoints.
      if (path.includes('openid') || path.includes('oauth')) {
        try {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          for (const k of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint',
                           'jwks_uri', 'registration_endpoint', 'introspection_endpoint',
                           'revocation_endpoint']) {
            const v = parsed[k];
            if (typeof v === 'string') {
              items.push({
                url: v,
                title: `OIDC ${k}`,
                description: `Declared in ${path} as the ${k}.`,
                kind: 'api',
                httpMethod: 'POST',
                source: 'wellknown',
              });
            }
          }
        } catch { /* malformed json — keep the item but no expansion */ }
      }
    } catch {
      // continue
    }
  }
  return items;
}
