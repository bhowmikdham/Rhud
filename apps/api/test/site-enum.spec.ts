/**
 * Site enumeration — unit tests for the pure helpers across the
 * crawler, classifier, mapper, and shared helpers. These don't touch
 * Postgres or any LLM provider, so they run anywhere vitest does.
 *
 * Integration coverage (full crawl → classify → quote against a
 * fixture HTTP server) lands in a follow-up sprint when we wire a
 * lightweight test server; the unit suite locks the contract for the
 * helpers that change most often (URL/HTML parsing, category mapping).
 */

import { describe, expect, it } from 'vitest';
import {
  defaultCategoryToServiceLineSlug,
  type RateCard,
  type SiteEnumerationCategorySummary,
} from '@rhud/shared';
import {
  bodyFingerprint,
  clamp,
  compileRegex,
  decodeHtmlEntities,
  detectSpa,
  extractDescription,
  extractLinks,
  extractSitemapLocs,
  extractTitle,
  fingerprintsEqual,
  parseRobots,
} from '../src/site-enum/crawler.service.js';
import {
  heuristicCategory,
  parseLlmBatchResponse,
  type ClassifiedPage,
} from '../src/site-enum/classifier.service.js';
import { SiteScopeMapperService } from '../src/site-enum/mapper.service.js';
import {
  absoluteUrl,
  extractDeclaredIntegrationHosts,
  harvestedItemToPage,
  isKnownIntegrationHost,
  looksLikeStaticAsset,
  normaliseApiPath,
  parseJsBundleForApis,
  sourcesContentFromMap,
} from '../src/site-enum/js-crawler.service.js';
import {
  detectTechStack,
  expandOpenApiPaths,
  tryParseManifest,
  tryParseOpenApi,
} from '../src/site-enum/enrichment.service.js';
import {
  buildSummaries,
  isPlausibleUrl,
} from '../src/site-enum/site-enum.service.js';
import type { DiscoveredPage } from '../src/site-enum/crawler.service.js';

// ── Crawler helpers ─────────────────────────────────────────────────────────

describe('crawler — clamp', () => {
  it('clamps to bounds and floors floats', () => {
    expect(clamp(50, 1, 100)).toBe(50);
    expect(clamp(0, 1, 100)).toBe(1);
    expect(clamp(150, 1, 100)).toBe(100);
    expect(clamp(7.9, 1, 100)).toBe(7);
    expect(clamp(NaN, 1, 100)).toBe(1);
  });
});

describe('crawler — compileRegex', () => {
  it('returns null for empty / undefined', () => {
    expect(compileRegex(undefined)).toBeNull();
    expect(compileRegex('')).toBeNull();
  });
  it('returns a compiled regex for valid input', () => {
    const re = compileRegex('^/blog/');
    expect(re).toBeInstanceOf(RegExp);
    expect(re!.test('/blog/post-1')).toBe(true);
    expect(re!.test('/products/x')).toBe(false);
  });
  it('returns null for invalid regex', () => {
    expect(compileRegex('([)')).toBeNull();
  });
});

describe('crawler — decodeHtmlEntities', () => {
  it('decodes the common entities', () => {
    expect(decodeHtmlEntities('Tom &amp; Jerry')).toBe('Tom & Jerry');
    expect(decodeHtmlEntities('A &lt;tag&gt; B')).toBe('A <tag> B');
    expect(decodeHtmlEntities('it&#39;s here')).toBe("it's here");
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
  });
});

describe('crawler — parseRobots', () => {
  it('extracts disallow rules and sitemap directives', () => {
    const txt = `
      User-agent: *
      Disallow: /private
      Disallow: /admin/
      Allow: /public
      Sitemap: https://example.com/sitemap.xml
      Sitemap: https://example.com/sitemap-news.xml
      # comment line
    `;
    const r = parseRobots(txt);
    expect(r.disallow).toEqual(['/private', '/admin/']);
    expect(r.sitemaps).toEqual([
      'https://example.com/sitemap.xml',
      'https://example.com/sitemap-news.xml',
    ]);
  });
  it('ignores empty disallow (means allow all) and empty lines', () => {
    const r = parseRobots('User-agent: *\nDisallow:\n\n');
    expect(r.disallow).toEqual([]);
    expect(r.sitemaps).toEqual([]);
  });
});

describe('crawler — extractSitemapLocs', () => {
  it('extracts <loc> values from a urlset', () => {
    const xml = `<?xml version="1.0"?>
      <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
        <url><loc>https://example.com/a</loc></url>
        <url><loc>https://example.com/b</loc></url>
      </urlset>`;
    expect(extractSitemapLocs(xml)).toEqual([
      'https://example.com/a',
      'https://example.com/b',
    ]);
  });
  it('extracts <loc> values from a sitemap index', () => {
    const xml = `<sitemapindex>
        <sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap>
        <sitemap><loc>https://example.com/sitemap-2.xml</loc></sitemap>
      </sitemapindex>`;
    expect(extractSitemapLocs(xml)).toEqual([
      'https://example.com/sitemap-1.xml',
      'https://example.com/sitemap-2.xml',
    ]);
  });
});

describe('crawler — bodyFingerprint / fingerprintsEqual', () => {
  it('matches identical bodies', () => {
    const a = bodyFingerprint('<html><title>X</title><body>hello</body></html>');
    const b = bodyFingerprint('<html><title>X</title><body>hello</body></html>');
    expect(fingerprintsEqual(a, b)).toBe(true);
  });
  it('detects size differences', () => {
    const a = bodyFingerprint('<title>X</title>aaaaaa');
    const b = bodyFingerprint('<title>X</title>bbbbbbbb');
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
  it('detects title differences even when sizes match', () => {
    const a = bodyFingerprint('<title>AA</title>x'.padEnd(100, '-'));
    const b = bodyFingerprint('<title>BB</title>x'.padEnd(100, '-'));
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
  it('detects head/tail differences when size + title match', () => {
    const head = '<title>X</title>';
    const a = bodyFingerprint(head + 'AAA' + 'x'.repeat(500) + 'TAIL_A');
    const b = bodyFingerprint(head + 'AAA' + 'x'.repeat(500) + 'TAIL_B');
    expect(a.size).toBe(b.size);
    expect(a.title).toBe(b.title);
    expect(fingerprintsEqual(a, b)).toBe(false);
  });
});

describe('crawler — detectSpa', () => {
  it('flags Vite/React SPA shape (mount div + zero anchors)', () => {
    expect(detectSpa({ html: '<div id="root"></div>' })).toBe(true);
    expect(detectSpa({ html: '<div id="app"></div>' })).toBe(true);
    expect(detectSpa({ html: '<div id="__next"></div>' })).toBe(true);
  });
  it('does not flag pages with anchor tags even if a mount div exists', () => {
    expect(detectSpa({ html: '<div id="root"></div><a href="/about">a</a>' })).toBe(false);
  });
  it('does not flag plain HTML without a mount div', () => {
    expect(detectSpa({ html: '<body><h1>Hi</h1></body>' })).toBe(false);
  });
  it('safely handles empty html', () => {
    expect(detectSpa({ html: '' })).toBe(false);
  });
});

describe('crawler — HTML extractors', () => {
  it('extracts <title>', () => {
    expect(extractTitle('<html><head><title>Acme &amp; Co</title></head></html>')).toBe('Acme & Co');
    expect(extractTitle('<html><body>no title</body></html>')).toBeNull();
  });
  it('extracts meta description, then og:description, then first <p>', () => {
    expect(
      extractDescription('<meta name="description" content="hello world"/>'),
    ).toBe('hello world');
    expect(
      extractDescription('<meta property="og:description" content="og fallback"/>'),
    ).toBe('og fallback');
    expect(
      extractDescription('<p>First paragraph text.</p>'),
    ).toBe('First paragraph text.');
    expect(extractDescription('<div>nothing</div>')).toBeNull();
  });
  it('extracts absolute links and ignores anchors / mailto / js', () => {
    const html = `
      <a href="/about">About</a>
      <a href="https://other.example.com/external">ext</a>
      <a href="https://example.com/products/x">prod</a>
      <a href="#section">anchor</a>
      <a href="mailto:hi@x.com">mail</a>
      <a href="javascript:void(0)">js</a>
    `;
    const links = extractLinks(html, 'https://example.com/');
    expect(links).toContain('https://example.com/about');
    expect(links).toContain('https://other.example.com/external');
    expect(links).toContain('https://example.com/products/x');
    // No anchors / mailto / js.
    expect(links.some((l) => l.includes('mailto'))).toBe(false);
    expect(links.some((l) => l.includes('javascript'))).toBe(false);
  });
});

// ── Heuristic classifier ────────────────────────────────────────────────────

describe('classifier — heuristicCategory', () => {
  const base = { contentType: 'text/html', title: null, description: null, html: '' };

  it('classifies attachments by extension', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/files/whitepaper.pdf', contentType: null }))
      .toBe('attachment');
  });
  it('classifies media by content-type', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/img/hero.png', contentType: 'image/png' }))
      .toBe('media');
  });
  it('classifies ecommerce path tokens', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/shop/widget' })).toBe('ecommerce');
    expect(heuristicCategory({ ...base, url: 'https://x.com/cart' })).toBe('ecommerce');
    expect(heuristicCategory({ ...base, url: 'https://x.com/checkout' })).toBe('ecommerce');
  });
  it('classifies product paths', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/products/widget-1' })).toBe('product');
    expect(heuristicCategory({ ...base, url: 'https://x.com/catalog' })).toBe('product');
  });
  it('classifies blog paths', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/blog/why-x' })).toBe('blog');
    expect(heuristicCategory({ ...base, url: 'https://x.com/news/launch' })).toBe('blog');
  });
  it('classifies KB paths', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/kb/getting-started' })).toBe('knowledge_base');
    expect(heuristicCategory({ ...base, url: 'https://x.com/docs/api' })).toBe('knowledge_base');
    expect(heuristicCategory({ ...base, url: 'https://x.com/help/billing' })).toBe('knowledge_base');
  });
  it('classifies forms (path or <form> in HTML)', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/contact' })).toBe('form');
    expect(heuristicCategory({ ...base, url: 'https://x.com/random', html: '<form>...</form>' })).toBe('form');
  });
  it('classifies members area, including auth flows', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/portal/dashboard' })).toBe('members');
    expect(heuristicCategory({ ...base, url: 'https://x.com/login' })).toBe('members');
    expect(heuristicCategory({ ...base, url: 'https://x.com/signin' })).toBe('members');
    expect(heuristicCategory({ ...base, url: 'https://x.com/signup' })).toBe('members');
    expect(heuristicCategory({ ...base, url: 'https://x.com/register' })).toBe('members');
    // /auth?mode=signup — the actual investos.world URL we got wrong before.
    expect(heuristicCategory({ ...base, url: 'https://x.com/auth?mode=signup' })).toBe('members');
  });
  it('classifies real forms (contact/lead) as form, not auth', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/contact' })).toBe('form');
    expect(heuristicCategory({ ...base, url: 'https://x.com/lead' })).toBe('form');
    expect(heuristicCategory({ ...base, url: 'https://x.com/feedback' })).toBe('form');
  });
  it('classifies module / app sub-paths', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/crm/leads' })).toBe('module');
    expect(heuristicCategory({ ...base, url: 'https://x.com/inventory/stock' })).toBe('module');
  });
  it('classifies api by URL path', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/api/v1/users' })).toBe('api');
    expect(heuristicCategory({ ...base, url: 'https://x.com/v1/portfolios' })).toBe('api');
    expect(heuristicCategory({ ...base, url: 'https://x.com/graphql' })).toBe('api');
    expect(heuristicCategory({ ...base, url: 'https://x.com/rest/orders' })).toBe('api');
  });
  it('classifies api by host pattern', () => {
    expect(heuristicCategory({ ...base, url: 'https://api.example.com/things' })).toBe('api');
    expect(heuristicCategory({ ...base, url: 'https://abcd.supabase.co/rest/v1/users' })).toBe('api');
    expect(heuristicCategory({ ...base, url: 'https://abc.firebaseio.com/data.json' })).toBe('api');
  });
  it('classifies api by JSON content-type with no html body', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/whatever', contentType: 'application/json', html: '' })).toBe('api');
  });
  it('falls back to cms for generic pages', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/about' })).toBe('cms');
    expect(heuristicCategory({ ...base, url: 'https://x.com/' })).toBe('cms');
  });
  it('uses title hints as a last resort', () => {
    expect(heuristicCategory({ ...base, url: 'https://x.com/foo', title: 'Latest blog post' })).toBe('blog');
  });
});

// ── LLM response parser ─────────────────────────────────────────────────────

describe('classifier — parseLlmBatchResponse', () => {
  const batch: DiscoveredPage[] = [
    { url: 'https://x.com/a', httpStatus: 200, contentType: 'text/html', title: 'A', description: null, html: '', depth: 0, fetchedAt: new Date() },
    { url: 'https://x.com/b', httpStatus: 200, contentType: 'text/html', title: 'B', description: null, html: '', depth: 0, fetchedAt: new Date() },
  ];
  const heuristic = new Map<string, ClassifiedPage>([
    ['https://x.com/a', { url: 'https://x.com/a', title: 'A', description: null, httpStatus: 200, contentType: 'text/html', category: 'cms', confidence: 0.6, source: 'heuristic' }],
    ['https://x.com/b', { url: 'https://x.com/b', title: 'B', description: null, httpStatus: 200, contentType: 'text/html', category: 'product', confidence: 0.6, source: 'heuristic' }],
  ]);

  it('parses a clean JSON batch response', () => {
    const raw = JSON.stringify({
      items: [
        { idx: 0, category: 'blog', confidence: 0.9, reason: 'looks like a blog' },
        { idx: 1, category: 'product', confidence: 0.95, reason: 'product page' },
      ],
    });
    const out = parseLlmBatchResponse(raw, batch, heuristic);
    expect(out).toHaveLength(2);
    expect(out[0]!.category).toBe('blog');
    expect(out[0]!.source).toBe('llm');
    expect(out[1]!.category).toBe('product');
    // Heuristic agreed → confidence bumped to ≥ 0.85.
    expect(out[1]!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('strips markdown fences', () => {
    const raw = '```json\n' + JSON.stringify({ items: [{ idx: 0, category: 'cms', confidence: 0.5 }] }) + '\n```';
    const out = parseLlmBatchResponse(raw, batch, heuristic);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('cms');
  });

  it('finds JSON inside surrounding text', () => {
    const raw = 'Here is the result: ' + JSON.stringify({ items: [{ idx: 0, category: 'form', confidence: 0.7 }] }) + ' done.';
    const out = parseLlmBatchResponse(raw, batch, heuristic);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('form');
  });

  it('drops invalid categories silently', () => {
    const raw = JSON.stringify({
      items: [
        { idx: 0, category: 'NOT_A_REAL_CATEGORY', confidence: 0.9 },
        { idx: 1, category: 'product', confidence: 0.5 },
      ],
    });
    const out = parseLlmBatchResponse(raw, batch, heuristic);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('product');
  });

  it('throws on completely non-JSON output', () => {
    expect(() => parseLlmBatchResponse('this is not json at all', batch, heuristic))
      .toThrow();
  });

  it('clamps confidence to [0, 1]', () => {
    const raw = JSON.stringify({ items: [{ idx: 0, category: 'cms', confidence: 1.7 }] });
    const out = parseLlmBatchResponse(raw, batch, heuristic);
    expect(out[0]!.confidence).toBeLessThanOrEqual(1);
  });
});

// ── JS crawler helpers (path collapsing + integration detection) ───────────

describe('js-crawler — normaliseApiPath', () => {
  it('collapses numeric path segments to :id', () => {
    expect(normaliseApiPath('/api/v1/users/123')).toBe('/api/v1/users/:id');
    expect(normaliseApiPath('/v2/orders/456/items/789')).toBe('/v2/orders/:id/items/:id');
  });
  it('collapses UUIDs to :uuid', () => {
    expect(normaliseApiPath('/api/v1/things/550e8400-e29b-41d4-a716-446655440000'))
      .toBe('/api/v1/things/:uuid');
  });
  it('leaves slug-shaped segments alone', () => {
    expect(normaliseApiPath('/api/v1/users/me/profile')).toBe('/api/v1/users/me/profile');
    expect(normaliseApiPath('/blog/why-x-matters')).toBe('/blog/why-x-matters');
  });
});

describe('js-crawler — isKnownIntegrationHost', () => {
  it('matches well-known integration hosts (incl. subdomains)', () => {
    expect(isKnownIntegrationHost('api.razorpay.com')).toBe(true);
    expect(isKnownIntegrationHost('xkxicoqoabuyiqpjhzgm.supabase.co')).toBe(true);
    expect(isKnownIntegrationHost('accounts.google.com')).toBe(true);
    expect(isKnownIntegrationHost('checkout.stripe.com')).toBe(true);
  });
  it('does not match unrelated hosts', () => {
    expect(isKnownIntegrationHost('example.com')).toBe(false);
    expect(isKnownIntegrationHost('cdn.cloudflare.net')).toBe(false);
  });
});

describe('js-crawler — looksLikeStaticAsset', () => {
  it('flags JS / CSS chunks fetched dynamically as static', () => {
    expect(looksLikeStaticAsset('/assets/index-D1xSlwbd.js')).toBe(true);
    expect(looksLikeStaticAsset('/assets/index-cHEH_Wb0.css')).toBe(true);
    expect(looksLikeStaticAsset('/assets/vendor-react-CeZ-7AwM.js')).toBe(true);
    expect(looksLikeStaticAsset('/registerSW.js')).toBe(true);
    expect(looksLikeStaticAsset('/manifest.webmanifest')).toBe(true);
    expect(looksLikeStaticAsset('/favicon.ico')).toBe(true);
    expect(looksLikeStaticAsset('/pwa-512x512.png')).toBe(true);
  });
  it('does not flag real API paths', () => {
    expect(looksLikeStaticAsset('/api/v1/users')).toBe(false);
    expect(looksLikeStaticAsset('/rest/v1/portfolios')).toBe(false);
    expect(looksLikeStaticAsset('/functions/v1/fetch-financial-news')).toBe(false);
    expect(looksLikeStaticAsset('/graphql')).toBe(false);
  });
  it('respects query strings on the asset URL', () => {
    expect(looksLikeStaticAsset('/assets/main.js?v=123')).toBe(true);
  });
});

describe('js-crawler — parseJsBundleForApis', () => {
  it('finds Supabase table refs (.from)', () => {
    const code = `var x=createClient().from("users");y.from('portfolios')`;
    const out = parseJsBundleForApis(code);
    const tables = out.filter((r) => r.kind === 'supabase_table').map((r) => r.name).sort();
    expect(tables).toEqual(['portfolios', 'users']);
  });
  it('finds Supabase RPC refs (.rpc)', () => {
    const code = `await sb.rpc("calculate_xirr", { args })\nawait sb.rpc('process_payment')`;
    const out = parseJsBundleForApis(code);
    const rpcs = out.filter((r) => r.kind === 'supabase_rpc').map((r) => r.name).sort();
    expect(rpcs).toEqual(['calculate_xirr', 'process_payment']);
  });
  it('finds literal REST paths', () => {
    const code = `fetch("/api/v1/users")\nawait fetch('/functions/v1/fetch-news')\nfetch(\`/rest/v1/orders\`)`;
    const out = parseJsBundleForApis(code);
    const paths = out.filter((r) => r.kind === 'rest_path').map((r) => r.name).sort();
    expect(paths).toContain('/api/v1/users');
    expect(paths).toContain('/functions/v1/fetch-news');
    expect(paths).toContain('/rest/v1/orders');
  });
  it('rejects noisy short identifiers (length, name, item, ...)', () => {
    const code = `arr.from("length"); o.from('name'); x.rpc('item')`;
    const out = parseJsBundleForApis(code);
    expect(out).toHaveLength(0);
  });
  it('does not match Array.from / iterators', () => {
    // Array.from(arr) — the leading `Array.` prevents the match because
    // we reject identifiers shorter than 3 chars or in the noise set.
    // The regex itself does match; the looksLikeSupabaseIdentifier
    // filter catches it.
    const code = `Array.from(items.map(x => x.id))`;
    const out = parseJsBundleForApis(code);
    expect(out.filter((r) => r.kind === 'supabase_table')).toHaveLength(0);
  });
});

describe('js-crawler — harvestedItemToPage', () => {
  it('builds Supabase table URL using known supabase host', () => {
    const p = harvestedItemToPage(
      { kind: 'supabase_table', name: 'portfolios' },
      'investos.world',
      'abc.supabase.co',
    );
    expect(p.url).toBe('https://abc.supabase.co/rest/v1/portfolios');
    expect(p.kind).toBe('api');
    expect(p.title).toContain('portfolios');
  });
  it('builds REST path URL using same-origin host', () => {
    const p = harvestedItemToPage(
      { kind: 'rest_path', name: '/api/v1/users' },
      'investos.world',
      'abc.supabase.co',
    );
    expect(p.url).toBe('https://investos.world/api/v1/users');
    expect(p.kind).toBe('api');
  });
});

describe('js-crawler — extractDeclaredIntegrationHosts', () => {
  it('pulls integration hosts from preconnect / dns-prefetch / script src', () => {
    const html = `
      <link rel="dns-prefetch" href="https://api.razorpay.com">
      <link rel="preconnect" href="https://accounts.google.com">
      <link rel="dns-prefetch" href="https://xkxicoqoabuyiqpjhzgm.supabase.co">
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Foo">
      <script src="https://js.stripe.com/v3/"></script>
      <script src="/assets/index.js"></script>
    `;
    const out = extractDeclaredIntegrationHosts(html, 'investos.world');
    expect(out).toContain('api.razorpay.com');
    expect(out).toContain('accounts.google.com');
    expect(out).toContain('xkxicoqoabuyiqpjhzgm.supabase.co');
    expect(out).toContain('js.stripe.com');
    // fonts.googleapis.com is not a known integration host
    expect(out).not.toContain('fonts.googleapis.com');
    // same-origin scripts excluded
    expect(out.some((h) => h.includes('investos.world'))).toBe(false);
  });
});

// ── Enrichment helpers ──────────────────────────────────────────────────────

describe('enrichment — tryParseOpenApi', () => {
  it('parses a v3 OpenAPI doc', () => {
    const spec = tryParseOpenApi(JSON.stringify({
      openapi: '3.0.0',
      info: { title: 'X', version: '1' },
      paths: { '/users': { get: {}, post: {} }, '/users/{id}': { get: {}, delete: {} } },
    }));
    expect(spec).toBeTruthy();
    expect(spec?.openapi).toBe('3.0.0');
  });
  it('parses a swagger 2 doc', () => {
    const spec = tryParseOpenApi(JSON.stringify({
      swagger: '2.0', paths: { '/things': { get: {} } },
    }));
    expect(spec).toBeTruthy();
    expect(spec?.swagger).toBe('2.0');
  });
  it('rejects non-spec JSON', () => {
    expect(tryParseOpenApi(JSON.stringify({ hello: 'world' }))).toBeNull();
    expect(tryParseOpenApi('not json')).toBeNull();
    expect(tryParseOpenApi('{}')).toBeNull();
  });
});

describe('enrichment — expandOpenApiPaths', () => {
  it('flattens paths × methods into endpoint records', () => {
    const out = expandOpenApiPaths({
      openapi: '3.0.0',
      paths: {
        '/users': { get: {}, post: {} },
        '/users/{id}': { get: {}, patch: {}, delete: {} },
      },
    }, 'https://api.example.com');
    const sigs = out.map((e) => `${e.method} ${e.path}`).sort();
    expect(sigs).toContain('GET /users');
    expect(sigs).toContain('POST /users');
    expect(sigs).toContain('GET /users/{id}');
    expect(sigs).toContain('PATCH /users/{id}');
    expect(sigs).toContain('DELETE /users/{id}');
    expect(out.every((e) => e.url.startsWith('https://api.example.com'))).toBe(true);
  });
});

describe('enrichment — tryParseManifest', () => {
  it('parses a Vite-shaped PWA manifest', () => {
    const m = tryParseManifest(JSON.stringify({
      name: 'InvestOS',
      start_url: '/dashboard',
      scope: '/',
      shortcuts: [{ url: '/portfolio' }, { url: '/spend-sense' }],
    }));
    expect(m).toBeTruthy();
    expect(m?.name).toBe('InvestOS');
    expect(m?.startUrl).toBe('/dashboard');
    expect(m?.shortcuts).toEqual(['/portfolio', '/spend-sense']);
  });
  it('returns null for malformed JSON', () => {
    expect(tryParseManifest('not json')).toBeNull();
  });
  it('handles missing optional fields', () => {
    const m = tryParseManifest(JSON.stringify({}));
    expect(m).toBeTruthy();
    expect(m?.shortcuts).toEqual([]);
  });
});

describe('enrichment — detectTechStack', () => {
  it('flags WordPress from /wp-content/ paths', () => {
    const fp = detectTechStack('<link href="/wp-content/themes/x/style.css">', []);
    expect(fp.platform).toBe('wordpress');
    expect(fp.signals).toEqual(expect.arrayContaining([expect.stringContaining('wp-content')]));
  });
  it('flags Shopify from CDN host', () => {
    const fp = detectTechStack('<script src="https://cdn.shopify.com/x.js"></script>', []);
    expect(fp.platform).toBe('shopify');
  });
  it('flags Next.js from _next/static paths in bundles', () => {
    const fp = detectTechStack('<html></html>', ['https://x.com/_next/static/chunks/abc.js']);
    expect(fp.platform).toBe('nextjs');
  });
  it('flags Vite/React SPA shell as last resort', () => {
    const fp = detectTechStack('<div id="root"></div>', ['/assets/vendor-react-CeZ.js']);
    expect(fp.platform).toBe('vite_react');
  });
  it('captures auxiliary signals (Razorpay, Supabase, Google OAuth)', () => {
    const fp = detectTechStack(`
      <link rel="dns-prefetch" href="https://api.razorpay.com">
      <link rel="preconnect" href="https://accounts.google.com">
      <link rel="dns-prefetch" href="https://x.supabase.co">
    `, []);
    expect(fp.signals).toEqual(expect.arrayContaining(['Razorpay', 'Supabase', 'Google OAuth']));
  });
  it('extracts <meta name="generator">', () => {
    const fp = detectTechStack(
      '<meta name="generator" content="Hugo 0.123.0">',
      [],
    );
    expect(fp.generator).toBe('Hugo 0.123.0');
  });
});

describe('enrichment — sourcesContentFromMap + absoluteUrl', () => {
  it('extracts joined sourcesContent', () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['a.js', 'b.js'],
      sourcesContent: ['function foo() { return supabase.from("portfolios"); }', 'export const x = 1;'],
      mappings: '',
    });
    const got = sourcesContentFromMap(map);
    expect(got).toContain('portfolios');
    expect(got).toContain('export const x');
  });
  it('returns null for malformed map', () => {
    expect(sourcesContentFromMap('not json')).toBeNull();
  });
  it('returns null when sourcesContent is missing', () => {
    expect(sourcesContentFromMap(JSON.stringify({ version: 3, mappings: '' }))).toBeNull();
  });
  it('absoluteUrl resolves a sibling relative path', () => {
    expect(absoluteUrl('index-XXX.js.map', 'https://x.com/assets/index-XXX.js'))
      .toBe('https://x.com/assets/index-XXX.js.map');
  });
  it('absoluteUrl passes through already-absolute URLs', () => {
    expect(absoluteUrl('https://other.com/foo.js', 'https://x.com/'))
      .toBe('https://other.com/foo.js');
  });
});

// ── Mapper / category helpers ───────────────────────────────────────────────

const FIXTURE_RATE_CARD: RateCard = {
  id: 'rc-1',
  tenantId: 't-1',
  name: 'Fixture',
  version: 1,
  status: 'published',
  currency: 'INR',
  inferenceContext: null,
  defaultMethodologyRule: null,
  inferenceExamples: [],
  serviceLines: [
    {
      id: 'sl-pages',
      slug: 'website_pages',
      displayName: 'Website pages',
      scopeUnit: 'pages',
      pricingModel: 'tier_lookup',
      position: 0,
      tiers: [
        { id: 't1', rangeMin: 1, rangeMax: 50, methodology: null, customerType: 'external', priceCents: 50_000_00 },
        { id: 't2', rangeMin: 51, rangeMax: 200, methodology: null, customerType: 'external', priceCents: 150_000_00 },
        { id: 't3', rangeMin: 201, rangeMax: null, methodology: null, customerType: 'external', priceCents: 300_000_00 },
      ],
    },
    {
      id: 'sl-blog',
      slug: 'blog_content',
      displayName: 'Blog content migration',
      scopeUnit: 'pages',
      pricingModel: 'tier_lookup',
      position: 1,
      tiers: [
        { id: 'b1', rangeMin: 1, rangeMax: 100, methodology: null, customerType: 'external', priceCents: 30_000_00 },
      ],
    },
    {
      id: 'sl-shop',
      slug: 'ecommerce_setup',
      displayName: 'Ecommerce shop setup',
      scopeUnit: 'pages',
      pricingModel: 'tier_lookup',
      position: 2,
      tiers: [
        { id: 'e1', rangeMin: 1, rangeMax: null, methodology: null, customerType: 'external', priceCents: 200_000_00 },
      ],
    },
  ],
  openPricedServices: [],
};

describe('shared — defaultCategoryToServiceLineSlug', () => {
  it('matches blog → blog_content via substring', () => {
    expect(defaultCategoryToServiceLineSlug('blog', FIXTURE_RATE_CARD)).toBe('blog_content');
  });
  it('matches ecommerce → ecommerce_setup', () => {
    expect(defaultCategoryToServiceLineSlug('ecommerce', FIXTURE_RATE_CARD)).toBe('ecommerce_setup');
  });
  it('matches cms → website_pages (web/page substring)', () => {
    expect(defaultCategoryToServiceLineSlug('cms', FIXTURE_RATE_CARD)).toBe('website_pages');
  });
  it('returns null when no slug looks related', () => {
    expect(defaultCategoryToServiceLineSlug('module', FIXTURE_RATE_CARD)).toBeNull();
  });
  it('never auto-maps "other"', () => {
    expect(defaultCategoryToServiceLineSlug('other', FIXTURE_RATE_CARD)).toBeNull();
  });
});

// ── VAPT-aware mapper against a Prophaze-shaped rate card ─────────────────

const VAPT_FIXTURE: RateCard = {
  id: 'rc-vapt',
  tenantId: 't-1',
  name: 'VAPT fixture',
  version: 1,
  status: 'published',
  currency: 'INR',
  inferenceContext: null,
  defaultMethodologyRule: null,
  inferenceExamples: [],
  serviceLines: [
    {
      id: 'sl-vapt-input', slug: 'vapt_web_app_input_fields',
      displayName: 'VAPT — Web App / Input Fields',
      scopeUnit: 'other', pricingModel: 'per_unit', position: 0,
      tiers: [
        { id: 't1', rangeMin: 1, rangeMax: 14, methodology: 'black_box', customerType: 'external', priceCents: 5_000 },
        { id: 't2', rangeMin: 25, rangeMax: null, methodology: 'black_box', customerType: 'external', priceCents: 7_000 },
      ],
    },
    {
      id: 'sl-vapt-static', slug: 'vapt_web_app_static_pages',
      displayName: 'VAPT — Web App / Static Pages',
      scopeUnit: 'pages', pricingModel: 'per_unit', position: 1,
      tiers: [
        { id: 's1', rangeMin: 1, rangeMax: 10, methodology: 'black_box', customerType: 'external', priceCents: 3_000 },
      ],
    },
    {
      id: 'sl-vapt-dyn', slug: 'vapt_web_app_dynamic_pages',
      displayName: 'VAPT — Web App / Dynamic Pages',
      scopeUnit: 'pages', pricingModel: 'per_unit', position: 2,
      tiers: [
        { id: 'd1', rangeMin: 1, rangeMax: 49, methodology: 'black_box', customerType: 'external', priceCents: 10_000 },
      ],
    },
    {
      id: 'sl-vapt-login', slug: 'vapt_web_app_login_modules',
      displayName: 'VAPT — Web App / Login Modules (Grey Box only)',
      scopeUnit: 'other', pricingModel: 'per_unit', position: 4,
      tiers: [
        // Grey-box only — this is the case that exposes pickMethodology.
        { id: 'l1', rangeMin: 1, rangeMax: 4, methodology: 'grey_box', customerType: 'external', priceCents: 1_000_000 },
      ],
    },
    {
      id: 'sl-vapt-api-end', slug: 'vapt_api_endpoints',
      displayName: 'VAPT — API / Endpoints',
      scopeUnit: 'apis', pricingModel: 'per_unit', position: 10,
      tiers: [
        { id: 'a1', rangeMin: 16, rangeMax: 49, methodology: 'black_box', customerType: 'external', priceCents: 130_000 },
      ],
    },
    {
      id: 'sl-vapt-api-input', slug: 'vapt_api_input_fields',
      displayName: 'VAPT — API / Input Fields',
      scopeUnit: 'other', pricingModel: 'per_unit', position: 11,
      tiers: [
        { id: 'ai1', rangeMin: 35, rangeMax: null, methodology: 'black_box', customerType: 'external', priceCents: 70_000 },
      ],
    },
  ],
  openPricedServices: [],
};

describe('mapper — VAPT-aware (Prophaze-shaped rate card)', () => {
  const mapper = new SiteScopeMapperService();
  const summaries: SiteEnumerationCategorySummary[] = [
    { category: 'cms', count: 8, examples: [] },
    { category: 'members', count: 1, examples: [] },
    { category: 'api', count: 49, examples: [] },
  ];

  it('flips cms → dynamic_pages when looksLikeSpa is true', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, { looksLikeSpa: true });
    const cmsLine = out.find((e) => e.entityId === 'site-enum:cms');
    expect(cmsLine?.serviceLineSlug).toBe('vapt_web_app_dynamic_pages');
  });

  it('uses static_pages for cms when not a SPA', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, { looksLikeSpa: false });
    const cmsLine = out.find((e) => e.entityId === 'site-enum:cms');
    expect(cmsLine?.serviceLineSlug).toBe('vapt_web_app_static_pages');
  });

  it('auto-picks grey_box methodology for login_modules (no black_box tier exists)', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, {});
    const loginLine = out.find((e) => e.entityId === 'site-enum:members');
    expect(loginLine?.serviceLineSlug).toBe('vapt_web_app_login_modules');
    expect(loginLine?.methodology).toBe('grey_box');
  });

  it('emits derived web-app input-fields entity when totalFormFields > 0', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, { totalFormFields: 47 });
    const fields = out.find((e) => e.entityId === 'site-enum:web_input_fields');
    expect(fields).toBeTruthy();
    expect(fields?.serviceLineSlug).toBe('vapt_web_app_input_fields');
    expect(fields?.dimensions.other).toBe(47);
  });

  it('emits estimated API input fields = round(apiCount × 1.5) by default', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, {});
    const apiFields = out.find((e) => e.entityId === 'site-enum:api_input_fields:estimated');
    expect(apiFields).toBeTruthy();
    expect(apiFields?.serviceLineSlug).toBe('vapt_api_input_fields');
    expect(apiFields?.dimensions.other).toBe(74); // round(49 * 1.5) = 74
  });

  it('honours apiInputFieldsPerEndpoint override', () => {
    const out = mapper.map(summaries, VAPT_FIXTURE, { apiInputFieldsPerEndpoint: 3 });
    const apiFields = out.find((e) => e.entityId === 'site-enum:api_input_fields:estimated');
    expect(apiFields?.dimensions.other).toBe(147); // 49 * 3
  });
});

describe('mapper — SiteScopeMapperService.map', () => {
  const mapper = new SiteScopeMapperService();

  it('maps each summary to one ScopedEntity per known slug', () => {
    const summaries: SiteEnumerationCategorySummary[] = [
      { category: 'cms', count: 12, examples: [] },
      { category: 'blog', count: 7, examples: [] },
      { category: 'ecommerce', count: 4, examples: [] },
    ];
    const out = mapper.map(summaries, FIXTURE_RATE_CARD);
    expect(out.length).toBe(3);
    const bySlug = Object.fromEntries(out.map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.website_pages?.dimensions.pages).toBe(12);
    expect(bySlug.blog_content?.dimensions.pages).toBe(7);
    expect(bySlug.ecommerce_setup?.dimensions.pages).toBe(4);
    for (const e of out) {
      expect(e.customerType).toBe('external');
      expect(e.methodology).toBeNull();
    }
  });

  it('emits one explicit "other" entity per unmapped category (honest about each gap)', () => {
    const summaries: SiteEnumerationCategorySummary[] = [
      { category: 'module', count: 5, examples: [] },
      { category: 'media', count: 2, examples: [] },
    ];
    const out = mapper.map(summaries, FIXTURE_RATE_CARD);
    expect(out.length).toBe(2);
    expect(out.map((e) => e.entityId).sort()).toEqual([
      'site-enum:media',
      'site-enum:module',
    ]);
    for (const e of out) {
      expect(e.serviceLineSlug).toBe('other');
      expect(e.dimensions.other).toBeGreaterThan(0);
    }
  });

  it('skips zero-count summaries', () => {
    const summaries: SiteEnumerationCategorySummary[] = [
      { category: 'cms', count: 0, examples: [] },
      { category: 'blog', count: 3, examples: [] },
    ];
    const out = mapper.map(summaries, FIXTURE_RATE_CARD);
    expect(out.length).toBe(1);
    expect(out[0]!.serviceLineSlug).toBe('blog_content');
  });
});

// ── Service-level pure helpers ──────────────────────────────────────────────

describe('site-enum.service — isPlausibleUrl', () => {
  it('accepts well-formed URLs with or without scheme', () => {
    expect(isPlausibleUrl('https://example.com')).toBe(true);
    expect(isPlausibleUrl('example.com')).toBe(true);
    expect(isPlausibleUrl('http://sub.example.com/path')).toBe(true);
  });
  it('rejects empty / non-host strings', () => {
    expect(isPlausibleUrl('')).toBe(false);
    expect(isPlausibleUrl('   ')).toBe(false);
    expect(isPlausibleUrl('not a url')).toBe(false);
    expect(isPlausibleUrl('localhost')).toBe(false); // no dot
  });
});

describe('site-enum.service — buildSummaries', () => {
  function p(url: string, category: ClassifiedPage['category'], title: string | null = null): ClassifiedPage {
    return {
      url, title, description: null,
      httpStatus: 200, contentType: 'text/html',
      category, confidence: 0.7, source: 'heuristic',
    };
  }

  it('rolls pages into per-category summaries sorted by count desc', () => {
    const pages: ClassifiedPage[] = [
      p('https://x.com/a', 'cms', 'A'),
      p('https://x.com/b', 'cms', 'B'),
      p('https://x.com/c', 'cms', 'C'),
      p('https://x.com/d', 'blog', 'D'),
      p('https://x.com/e', 'product', 'E'),
      p('https://x.com/f', 'product', 'F'),
    ];
    const out = buildSummaries(pages);
    expect(out.map((s) => s.category)).toEqual(['cms', 'product', 'blog']);
    expect(out[0]!.count).toBe(3);
    expect(out[0]!.examples).toHaveLength(3);
    expect(out[0]!.examples[0]!.title).toBe('A');
  });

  it('keeps up to 200 examples per category (UI hierarchy needs the full set)', () => {
    const pages: ClassifiedPage[] = Array.from({ length: 7 }).map((_, i) =>
      p(`https://x.com/p${i}`, 'product', `P${i}`),
    );
    const out = buildSummaries(pages);
    expect(out[0]!.count).toBe(7);
    expect(out[0]!.examples).toHaveLength(7);
  });
  it('caps examples at 200 even for very large categories', () => {
    const pages: ClassifiedPage[] = Array.from({ length: 250 }).map((_, i) =>
      p(`https://x.com/p${i}`, 'product', `P${i}`),
    );
    const out = buildSummaries(pages);
    expect(out[0]!.count).toBe(250);
    expect(out[0]!.examples).toHaveLength(200);
  });

  it('omits empty categories', () => {
    const pages: ClassifiedPage[] = [p('https://x.com/a', 'cms')];
    const out = buildSummaries(pages);
    expect(out).toHaveLength(1);
    expect(out[0]!.category).toBe('cms');
  });
});
