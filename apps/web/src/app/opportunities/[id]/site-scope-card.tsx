'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  describeError,
  extraction,
  siteEnumeration,
  type BasePriceLine,
  type EngagementQuote,
  type DiscoveredPageRow,
  type SiteEnumerationCategorySummary,
  type SiteEnumerationStateView,
  type SiteUrlCategory,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Overlay } from '@/components/overlay';
import { formatMoney } from './format';

// ── Site scope (crawl prospect site → categorised scope → quote) ────────

/** Compact URL display for the site-scope card.
 *  - Same-host pages (the SPA's own routes) show the path only.
 *  - Cross-host URLs (APIs, integrations like supabase.co / razorpay)
 *    show host + path so the rep can tell the destinations apart. */
function siteHost(siteUrl: string): string | undefined {
  try { return new URL(siteUrl).host; } catch { return undefined; }
}

/** Group API-category URLs by what they actually are so the tech-side
 *  view shows the hierarchy (Supabase tables, RPCs, REST paths, XHR).
 *  Pure URL-pattern detection — keeps the categorisation decoupled
 *  from the crawler. */
type ApiSubGroup = 'supabase_table' | 'supabase_rpc' | 'rest_path' | 'xhr_call';
const API_SUBGROUP_LABEL: Record<ApiSubGroup, string> = {
  supabase_table: 'Supabase tables',
  supabase_rpc: 'Supabase RPC functions',
  rest_path: 'REST endpoints',
  xhr_call: 'Other XHR / fetch calls',
};
function classifyApiUrl(url: string): { sub: ApiSubGroup; name: string } {
  try {
    const u = new URL(url);
    if (/\.supabase\.(co|com)$/.test(u.host)) {
      const m = u.pathname.match(/^\/rest\/v\d+\/rpc\/([^/]+)/);
      if (m) return { sub: 'supabase_rpc', name: m[1]! };
      const t = u.pathname.match(/^\/rest\/v\d+\/([^/?]+)/);
      if (t) return { sub: 'supabase_table', name: t[1]! };
    }
    if (/^\/(api|rest|graphql|functions|v[1-9])\//.test(u.pathname)) {
      return { sub: 'rest_path', name: u.host + u.pathname };
    }
    return { sub: 'xhr_call', name: u.host + u.pathname };
  } catch {
    return { sub: 'xhr_call', name: url };
  }
}

function urlPath(url: string, sameHost?: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname + (u.search || '');
    if (sameHost && u.host === sameHost) return path;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

const CATEGORY_LABEL: Record<SiteUrlCategory, string> = {
  product: 'Product / catalog pages',
  ecommerce: 'Ecommerce (cart / checkout)',
  blog: 'Blog / news posts',
  cms: 'CMS pages (about / contact / static)',
  form: 'Forms (contact / lead capture)',
  knowledge_base: 'Knowledge base / docs',
  attachment: 'Attachments (PDF / DOCX / …)',
  members: 'Members area / portal',
  media: 'Media (images / video)',
  module: 'App modules (CRM / inventory / …)',
  api: 'API endpoints',
  integration: 'Third-party integrations',
  other: 'Other / unclassified',
};

const STATUS_LABEL: Record<SiteEnumerationStateView['status'], string> = {
  pending: 'Queued',
  crawling: 'Crawling site…',
  classifying: 'Classifying URLs…',
  ready: 'Ready',
  failed: 'Failed',
  retry_queued: 'Retry scheduled',
};

interface SiteEnumQuotePreview {
  rateCardId: string;
  totalCents: number;
  currency: string;
  lines: BasePriceLine[];
  hasManualQuoteRequired: boolean;
  hasUnmatched: boolean;
}

/**
 * Site scope crawler card. Three modes:
 *  - empty: show the input + "Crawl site" button
 *  - in flight (pending / crawling / classifying / retry_queued):
 *      show progress + spinner; poll every 3s
 *  - ready / failed: show categories + actions
 */
export function SiteScopeCard({
  engagementId,
  defaultOpen,
  onAfterCompute,
  parentBusy,
}: {
  engagementId: string;
  /** Opens the card body on first render (stage-aware — open at Pricing). */
  defaultOpen?: boolean;
  /** Hook to flow into the conventional predict/quote path. Called
   *  after Site Scope's quote endpoint refreshes the per-rate-card
   *  inferred-entities cache; the parent then re-runs the prediction
   *  (which now picks up the cached entities via the engagement quote)
   *  and smooth-scrolls the user up to see the result. */
  onAfterCompute?: () => Promise<void>;
  /** True while the parent's runPredict is in flight. Disables our
   *  Compute button so we can't queue duplicate work. */
  parentBusy?: boolean;
}) {
  const [state, setState] = useState<SiteEnumerationStateView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [siteUrl, setSiteUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [quotePreview, setQuotePreview] = useState<SiteEnumQuotePreview | null>(null);
  const [open, setOpen] = useState(defaultOpen ?? false);
  const [showAll, setShowAll] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await siteEnumeration.get(engagementId);
      setState(s);
      setLoaded(true);
    } catch (e) {
      setErr(describeError(e));
      setLoaded(true);
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll every 3s while a crawl is in flight. Slightly slower than the
  // extraction poll (5s would feel sluggish for a UI the user is
  // actively waiting on).
  const crawlInFlight =
    !!state &&
    (state.status === 'pending' || state.status === 'crawling' ||
      state.status === 'classifying' || state.status === 'retry_queued');
  // Poll only while a crawl is in flight AND the card is open — collapsing it
  // stops the network churn. Depend on the primitive `crawlInFlight` (not the
  // whole `state` object) so the interval isn't torn down + recreated on every
  // tick.
  useEffect(() => {
    if (!crawlInFlight || !open) return;
    const handle = setInterval(() => { void refresh(); }, 3_000);
    return () => clearInterval(handle);
  }, [crawlInFlight, open, refresh]);

  async function kickoff() {
    if (!siteUrl.trim()) return;
    setBusy(true); setErr(null);
    try {
      await siteEnumeration.kickoff(engagementId, { siteUrl: siteUrl.trim() });
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reCrawl(opts?: { useJsRendering?: boolean }) {
    if (!state) return;
    setBusy(true); setErr(null);
    setQuotePreview(null);
    try {
      await siteEnumeration.kickoff(engagementId, {
        siteUrl: state.siteUrl,
        ...(opts?.useJsRendering ? { options: { useJsRendering: true } } : {}),
      });
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!state) return;
    setBusy(true); setErr(null);
    try {
      await siteEnumeration.retry(state.id);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function computeQuote() {
    setBusy(true); setErr(null);
    try {
      // Step 1: refresh the per-rate-card cache of inferred entities
      // (mapToRateCard) AND get the inline-breakdown preview for the
      // tech-detail panel below the card. The parent's runPredict
      // call (next step) reads the refreshed cache from the
      // SiteEnumeration row when it persists the EngagementQuote.
      const res = await siteEnumeration.quote(engagementId);
      setQuotePreview({
        rateCardId: res.rateCardId,
        totalCents: res.quote.totalCents,
        currency: res.quote.currency,
        lines: res.quote.lines,
        hasManualQuoteRequired: res.quote.hasManualQuoteRequired,
        hasUnmatched: res.quote.hasUnmatched,
      });
      // Step 2: flow into the conventional predict/quote path so the
      // QuoteCard / ApprovalCard at the top of the page reflect the
      // site-enum-driven scope. Parent also smooth-scrolls there.
      if (onAfterCompute) {
        await onAfterCompute();
      }
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Trigger a browser download of the CSV. We can't use a plain
   *  `<a download href="...">` because the API expects the bearer
   *  token in an Authorization header, which `<a>` can't attach.
   *  Instead: fetch the body into a Blob, mint a blob: URL, click a
   *  hidden anchor, then revoke the URL. */
  async function downloadCsv() {
    setBusy(true); setErr(null);
    try {
      const csv = await siteEnumeration.fetchCsv(engagementId);
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `site-scope-${engagementId.slice(0, 8)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null; // first paint quiet until the GET resolves

  // No enumeration yet — show empty-state input.
  const headerSummary = (() => {
    if (!state) return 'Paste a prospect URL to crawl their site and quote on it.';
    if (state.status === 'ready') {
      return `${state.totalUrls} URL${state.totalUrls === 1 ? '' : 's'} crawled · ${state.categories.length} categor${state.categories.length === 1 ? 'y' : 'ies'}`;
    }
    if (state.status === 'failed') return 'Crawl failed — see details below.';
    if (state.status === 'retry_queued') {
      const ra = state.retryAt ? new Date(state.retryAt) : null;
      return ra ? `Retry queued — next attempt around ${ra.toLocaleTimeString()}` : 'Retry queued';
    }
    return `${STATUS_LABEL[state.status]} — ${state.totalUrls} URL${state.totalUrls === 1 ? '' : 's'} so far`;
  })();

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          appearance: 'none', background: 'transparent', border: 0, padding: 0, margin: 0,
          font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, width: '100%', marginBottom: open ? 12 : 0,
        }}
        aria-expanded={open}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 18, height: 18, display: 'grid', placeItems: 'center',
            color: 'var(--fg-muted)', flexShrink: 0,
          }}>
            {open ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="section-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon.Globe size={11} /> Site scope
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              {headerSummary}
            </div>
          </div>
        </div>
      </button>

      {open && (
        <>
          {err && (
            <div style={{
              padding: '8px 10px', marginBottom: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              borderRadius: 6, fontSize: 12,
            }}>{err}</div>
          )}

          {!state && (
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text"
                placeholder="https://prospect.example.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                disabled={busy}
                style={{
                  flex: 1, padding: '8px 10px',
                  background: 'var(--bg-sunk)',
                  border: '1px solid var(--divider)',
                  borderRadius: 6, fontSize: 13,
                }}
              />
              <button
                className="btn sm"
                disabled={busy || !siteUrl.trim()}
                onClick={() => void kickoff()}
              >
                {busy ? <><span className="spin" /> Starting…</> : <><Icon.Search size={11} /> Crawl site</>}
              </button>
            </div>
          )}

          {state && (
            <>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                padding: '10px 12px', background: 'var(--bg-sunk)',
                borderRadius: 6, marginBottom: 12, fontSize: 12.5,
              }}>
                <span className="mono" style={{ color: 'var(--fg-muted)' }}>{state.siteUrl}</span>
                <span className="dot">·</span>
                <span><b>{state.totalUrls}</b> total</span>
                <span className="dot">·</span>
                <span><b>{state.classifiedUrls}</b> classified</span>
                <span className="dot">·</span>
                <span style={{
                  color:
                    state.status === 'ready' ? 'var(--ok)'
                    : state.status === 'failed' ? 'var(--danger)'
                    : 'var(--accent)',
                  fontWeight: 600,
                }}>{STATUS_LABEL[state.status]}</span>
              </div>

              {(state.status === 'pending' || state.status === 'crawling' || state.status === 'classifying' || state.status === 'retry_queued') && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px', fontSize: 12.5, color: 'var(--fg-muted)',
                }}>
                  <span className="spin" />
                  <span>
                    {state.status === 'crawling' && (state.options?.useJsRendering
                      ? `Rendering pages with headless Chromium (capped at ${state.options?.maxPages ?? 50} pages — slower than static).`
                      : `Walking same-origin links (capped at ${state.options?.maxPages ?? 500} pages).`)}
                    {state.status === 'classifying' && `Categorising ${state.totalUrls} URLs.`}
                    {state.status === 'pending' && 'Queued — starting shortly.'}
                    {state.status === 'retry_queued' && state.retryAt && `Retry around ${new Date(state.retryAt).toLocaleTimeString()} (attempt ${state.attempts + 1}).`}
                  </span>
                </div>
              )}

              {state.status === 'failed' && (
                <div style={{
                  padding: 12, marginBottom: 10,
                  background: 'var(--danger-tint)', color: 'var(--danger)',
                  borderRadius: 6, fontSize: 12.5,
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Crawl failed after {state.attempts} attempt{state.attempts === 1 ? '' : 's'}</div>
                  <div style={{ color: 'var(--fg-muted)', wordBreak: 'break-word' }}>{state.error ?? 'Unknown error'}</div>
                </div>
              )}

              {state.status === 'ready' && state.spaCatchAll && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--warn-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--warn)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>SPA catch-all detected — only 1 distinct page found by static crawl</div>
                  <div style={{ color: 'var(--fg-muted)', marginBottom: 8 }}>
                    The server returns the same HTML for every URL. All routing is client-side JavaScript,
                    which the static crawler can&apos;t see. <b>Re-crawl with JavaScript rendering</b> to spin up a real
                    headless Chromium that executes the SPA and walks its rendered link graph.
                  </div>
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void reCrawl({ useJsRendering: true })}
                  >
                    {busy ? <><span className="spin" /> Starting…</> : <><Icon.Sparkle size={11} /> Re-crawl with JavaScript rendering</>}
                  </button>
                </div>
              )}

              {state.status === 'ready' && state.looksLikeSpa && !state.spaCatchAll && !state.options?.useJsRendering && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--warn-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--warn)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>This site looks like a JavaScript SPA</div>
                  <div style={{ color: 'var(--fg-muted)', marginBottom: 8 }}>
                    The static HTML has no anchor links, so the crawler walked common routes (<span className="mono">/about</span>, <span className="mono">/pricing</span>, <span className="mono">/blog</span>, …) instead.
                    Coverage is inherently incomplete — distinct pages found below are real, but the SPA likely has more routes that only render after JS executes.
                    Re-crawl with JavaScript rendering for full coverage.
                  </div>
                  <button
                    className="btn sm"
                    disabled={busy}
                    onClick={() => void reCrawl({ useJsRendering: true })}
                  >
                    {busy ? <><span className="spin" /> Starting…</> : <><Icon.Sparkle size={11} /> Re-crawl with JavaScript rendering</>}
                  </button>
                </div>
              )}

              {state.status === 'ready' && state.options?.useJsRendering && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--ok-tint)',
                  borderRadius: 6, fontSize: 12.5,
                  color: 'var(--fg)',
                  borderLeft: '3px solid var(--ok)',
                }}>
                  <div style={{ fontWeight: 600, marginBottom: 2 }}>JavaScript rendering complete</div>
                  <div style={{ color: 'var(--fg-muted)' }}>
                    Rendered with headless Chromium — captured {state.totalUrls} distinct items including
                    rendered routes, backend API calls, and third-party integrations declared by the app.
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.techFingerprint && state.techFingerprint.platform !== 'unknown' && (
                <div style={{
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--bg-elev)',
                  borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--divider)',
                }}>
                  <div style={{ marginBottom: state.techFingerprint.signals.length > 0 ? 4 : 0 }}>
                    <span style={{ color: 'var(--fg-muted)' }}>Detected platform </span>
                    <b className="mono">{state.techFingerprint.platform}</b>
                    {state.techFingerprint.generator && (
                      <span style={{ color: 'var(--fg-subtle)' }}>
                        {' '}· generator: <span className="mono">{state.techFingerprint.generator}</span>
                      </span>
                    )}
                  </div>
                  {state.techFingerprint.signals.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                      Signals: {state.techFingerprint.signals.join(' · ')}
                    </div>
                  )}
                  {state.specsFound.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 4 }}>
                      ✓ Specs fetched: {state.specsFound.map((s) => <span key={s} className="mono" style={{ marginRight: 8 }}>{s}</span>)}
                    </div>
                  )}
                  {state.serviceWorkersFound.length > 0 && (
                    <div style={{ fontSize: 11, color: 'var(--ok)', marginTop: 2 }}>
                      ✓ Service workers harvested: {state.serviceWorkersFound.length}
                    </div>
                  )}
                  {state.manifest && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                      ✓ PWA manifest: {state.manifest.name ?? '(unnamed)'}
                      {state.manifest.shortcuts.length > 0 && ` · ${state.manifest.shortcuts.length} shortcuts`}
                    </div>
                  )}
                </div>
              )}

              {state.status === 'ready' && (state.totalFormFields > 0 || state.jsBundleCount > 0 || state.cssFileCount > 0) && (
                <div style={{
                  display: 'flex', flexWrap: 'wrap', gap: 14,
                  padding: '10px 12px', marginBottom: 10,
                  background: 'var(--bg-elev)',
                  borderRadius: 6, fontSize: 12,
                  border: '1px solid var(--divider)',
                }}>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>Form input fields </span>
                    <b className="mono">{state.totalFormFields}</b>
                    <span style={{ color: 'var(--fg-subtle)' }}> · injection points across all rendered pages</span>
                  </div>
                  <div style={{ color: 'var(--fg-subtle)' }}>·</div>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>JS bundles </span>
                    <b className="mono">{state.jsBundleCount}</b>
                  </div>
                  <div style={{ color: 'var(--fg-subtle)' }}>·</div>
                  <div>
                    <span style={{ color: 'var(--fg-muted)' }}>CSS files </span>
                    <b className="mono">{state.cssFileCount}</b>
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.categories.length > 0 && (
                <div style={{ marginBottom: 12 }}>
                  <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 6 }}>Category breakdown</div>
                  <div style={{ border: '1px solid var(--divider)', borderRadius: 6, overflow: 'hidden' }}>
                    {state.categories.map((c, idx) => (
                      <CategoryRow
                        key={c.category}
                        category={c}
                        sameHost={siteHost(state.siteUrl)}
                        isLast={idx === state.categories.length - 1}
                      />
                    ))}
                  </div>
                </div>
              )}

              {state.status === 'ready' && state.categories.length === 0 && (
                <div style={{ padding: 12, fontSize: 12.5, color: 'var(--fg-muted)' }}>
                  Crawl finished but no URLs were discovered.
                </div>
              )}

              {quotePreview && (
                <QuoteBreakdownCard preview={quotePreview} />
              )}

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {state.status === 'ready' && (
                  <button className="btn sm" disabled={busy || parentBusy} onClick={() => void computeQuote()}>
                    {busy || parentBusy
                      ? <><span className="spin" /> Computing…</>
                      : <><Icon.Sparkle size={11} /> Compute quote</>}
                  </button>
                )}
                {state.status === 'ready' && state.totalUrls > 0 && (
                  <>
                    <button className="btn sm ghost" disabled={busy} onClick={() => setShowAll(true)}>
                      <Icon.Eye size={11} /> View all {state.totalUrls} items
                    </button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => void downloadCsv()}>
                      <Icon.Download size={11} /> Download CSV
                    </button>
                  </>
                )}
                {(state.status === 'ready' || state.status === 'failed') && (
                  <button className="btn sm ghost" disabled={busy} onClick={() => void reCrawl()}>
                    <Icon.Search size={11} /> Re-crawl
                  </button>
                )}
                {state.status === 'failed' && (
                  <button className="btn sm" disabled={busy} onClick={() => void retry()}>
                    <Icon.Sparkle size={11} /> Retry
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}

      {showAll && state && (
        <DiscoveredPagesModal
          engagementId={engagementId}
          siteUrl={state.siteUrl}
          onClose={() => setShowAll(false)}
        />
      )}
    </div>
  );
}

/** A single category row. Expandable when the breakdown is meaningful
 *  (lots of items, OR API category with sub-groups worth showing). */
function CategoryRow({
  category,
  sameHost,
  isLast,
}: {
  category: SiteEnumerationCategorySummary;
  sameHost: string | undefined;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const expandable = category.examples.length > 3 || category.category === 'api';

  // For the API category, group examples by URL pattern so the tech
  // person sees Supabase tables / RPCs / REST paths separately.
  const apiSubgroups = category.category === 'api'
    ? groupApiExamples(category.examples)
    : null;

  return (
    <div
      style={{
        padding: '10px 12px',
        borderBottom: isLast ? 'none' : '1px solid var(--divider)',
        fontSize: 13,
      }}
    >
      <div
        style={{
          display: 'grid', gridTemplateColumns: '1fr auto',
          alignItems: 'baseline', cursor: expandable ? 'pointer' : 'default',
        }}
        onClick={expandable ? () => setOpen((v) => !v) : undefined}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          {expandable && (
            <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
              {open ? <Icon.ChevronDown size={11} /> : <Icon.ChevronRight size={11} />}
            </span>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{CATEGORY_LABEL[category.category] ?? category.category}</div>
            {!open && apiSubgroups && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                {apiSubgroups.map((g) => `${API_SUBGROUP_LABEL[g.sub]}: ${g.items.length}`).join('  ·  ')}
              </div>
            )}
            {!open && !apiSubgroups && category.examples[0] && (
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                {category.examples.slice(0, 3).map((ex, i) => (
                  <div key={ex.url + i} className="mono" style={{ wordBreak: 'break-all' }}>
                    {urlPath(ex.url, sameHost)}
                  </div>
                ))}
                {category.examples.length > 3 && (
                  <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                    + {category.examples.length - 3} more — click to expand
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="mono" style={{ fontWeight: 600, paddingLeft: 12 }}>{category.count}</div>
      </div>

      {open && apiSubgroups && (
        <div style={{ marginTop: 10, paddingLeft: 16 }}>
          {apiSubgroups.map((g) => (
            <div key={g.sub} style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                {API_SUBGROUP_LABEL[g.sub]} <span style={{ color: 'var(--fg-muted)' }}>({g.items.length})</span>
              </div>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                gap: 4, fontSize: 11.5, color: 'var(--fg-muted)',
              }}>
                {g.items.map((name, i) => (
                  <div key={name + i} className="mono" style={{ wordBreak: 'break-all' }}>{name}</div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {open && !apiSubgroups && category.examples.length > 3 && (
        <div style={{ marginTop: 10, paddingLeft: 16, fontSize: 11.5, color: 'var(--fg-muted)' }}>
          {category.examples.map((ex, i) => (
            <div key={ex.url + i} className="mono" style={{ wordBreak: 'break-all' }}>
              {urlPath(ex.url, sameHost)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function groupApiExamples(examples: SiteEnumerationCategorySummary['examples']) {
  const groups = new Map<ApiSubGroup, string[]>();
  for (const ex of examples) {
    const { sub, name } = classifyApiUrl(ex.url);
    const list = groups.get(sub) ?? [];
    if (!list.includes(name)) list.push(name);
    groups.set(sub, list);
  }
  // Stable order: tables, RPCs, REST paths, XHR.
  const order: ApiSubGroup[] = ['supabase_table', 'supabase_rpc', 'rest_path', 'xhr_call'];
  return order
    .filter((s) => groups.has(s))
    .map((s) => ({ sub: s, items: (groups.get(s) ?? []).sort() }));
}

/** Quote breakdown — every line item from the rate card walk, with
 *  the matched service line, scope (unit + value), tier, and price.
 *  Each row is expandable to show: where the scope value came from,
 *  the math (qty × unit-price), and the methodology rationale. */
function QuoteBreakdownCard({ preview }: { preview: SiteEnumQuotePreview }) {
  const fmt = (cents: number) => formatMoney(cents, preview.currency);
  const sortedLines = [...preview.lines].sort((a, b) => b.priceCents - a.priceCents);
  const totalDiscovered = sortedLines.reduce((n, l) => n + (l.unmatched || l.manualQuoteRequired ? 0 : l.priceCents), 0);
  const flaggedCount = sortedLines.filter((l) => l.unmatched || l.manualQuoteRequired).length;
  return (
    <div style={{
      padding: '14px 16px', marginBottom: 12,
      background: 'var(--bg-elev)', borderRadius: 6,
      border: '1px solid var(--divider)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Approximate base quote
        </span>
        <span style={{ fontSize: 20, fontWeight: 700 }}>{fmt(preview.totalCents)}</span>
      </div>

      <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 10 }}>
        Walked rate card <span className="mono">{preview.rateCardId.slice(0, 8)}</span>
        {' '}— {preview.lines.length} line item{preview.lines.length === 1 ? '' : 's'}, click any row for the math.
        {flaggedCount > 0 && ` ${flaggedCount} row${flaggedCount === 1 ? '' : 's'} flagged.`}
      </div>

      <div style={{ border: '1px solid var(--divider)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '6px 10px', background: 'var(--bg-sunk)',
          fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
          textTransform: 'uppercase', letterSpacing: 0.4,
        }}>
          <div>Service line</div>
          <div>Scope</div>
          <div>Tier matched</div>
          <div style={{ textAlign: 'right' }}>Price</div>
        </div>
        {sortedLines.map((line) => (
          <QuoteLineRow key={line.entityId + line.serviceLineSlug} line={line} fmt={fmt} />
        ))}
        <div style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '8px 10px',
          borderTop: '2px solid var(--divider)',
          background: 'var(--bg-sunk)',
          fontSize: 12, fontWeight: 700,
        }}>
          <div>Total <span style={{ color: 'var(--fg-muted)', fontWeight: 400, fontSize: 11 }}>(priced lines only)</span></div>
          <div></div>
          <div></div>
          <div className="mono" style={{ textAlign: 'right' }}>{fmt(totalDiscovered)}</div>
        </div>
      </div>

      <EstimationMethodologyPanel preview={preview} />
    </div>
  );
}

/** A single quote line that opens to show the math + provenance. */
function QuoteLineRow({ line, fmt }: { line: BasePriceLine; fmt: (cents: number) => string }) {
  const [open, setOpen] = useState(false);
  const failed = !!line.unmatched;
  const manual = !!line.manualQuoteRequired;
  const provenance = describeProvenance(line);
  const math = describeMath(line, fmt);
  const methodologyNote = describeMethodology(line);

  return (
    <>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto',
          padding: '8px 10px', fontSize: 12,
          borderTop: '1px solid var(--divider)',
          alignItems: 'baseline', cursor: 'pointer',
          background: failed ? 'var(--danger-tint)' : manual ? 'var(--warn-tint)' : 'transparent',
        }}
      >
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span style={{ color: 'var(--fg-muted)', fontSize: 10 }}>
            {open ? <Icon.ChevronDown size={11} /> : <Icon.ChevronRight size={11} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>
              {line.serviceLineName || line.serviceLineSlug}
              {line.entityId.endsWith(':estimated') && (
                <span style={{
                  marginLeft: 6, padding: '1px 6px', borderRadius: 3,
                  background: 'var(--warn-tint)', color: 'var(--warn)',
                  fontSize: 9.5, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3,
                }}>
                  estimated
                </span>
              )}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 1 }}>
              {line.entityId}
            </div>
          </div>
        </div>
        <div className="mono" style={{ fontSize: 11.5 }}>
          {line.scopeValue} {line.scopeUnit}
        </div>
        <div style={{ fontSize: 11.5, color: failed ? 'var(--danger)' : 'var(--fg-muted)' }}>
          {failed
            ? `Unmatched: ${line.unmatched?.reason ?? 'no tier'}`
            : manual
              ? 'Open-priced — manual quote'
              : (line.tierLabel || 'auto-matched')}
        </div>
        <div className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>
          {failed || manual ? '—' : fmt(line.priceCents)}
        </div>
      </div>
      {open && (
        <div style={{
          padding: '10px 14px 12px 32px', fontSize: 11.5,
          background: 'var(--bg-sunk)',
          borderTop: '1px solid var(--divider)',
          color: 'var(--fg-muted)', lineHeight: 1.6,
        }}>
          <div style={{ marginBottom: 6 }}>
            <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Where this came from: </span>
            {provenance}
          </div>
          {math && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Math: </span>
              <span className="mono">{math}</span>
            </div>
          )}
          {methodologyNote && (
            <div style={{ marginBottom: 6 }}>
              <span style={{ fontWeight: 600, color: 'var(--fg)' }}>Methodology: </span>
              {methodologyNote}
            </div>
          )}
          {failed && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--danger-tint)', borderRadius: 4, color: 'var(--fg)' }}>
              <b style={{ color: 'var(--danger)' }}>Action:</b> add a service line whose slug contains
              {' '}<span className="mono">{slugHintFor(line.entityId)}</span>{' '}to the rate card so this scope can be priced.
            </div>
          )}
          {manual && (
            <div style={{ marginTop: 8, padding: 8, background: 'var(--warn-tint)', borderRadius: 4, color: 'var(--fg)' }}>
              This service is open-priced — quote manually with the client.
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** Map the ScopedEntity's entityId back to a human description of
 *  what the crawler actually saw. The mapper writes these IDs in a
 *  predictable shape — `site-enum:<category>` or
 *  `site-enum:<derived>:[estimated]`. */
function describeProvenance(line: BasePriceLine): string {
  const id = line.entityId;
  if (id === 'site-enum:cms') {
    return 'Distinct routes the crawler navigated to and rendered (excluding login / form / API pages classified separately).';
  }
  if (id === 'site-enum:product') return 'Routes whose path tokens match product/catalog patterns.';
  if (id === 'site-enum:ecommerce') return 'Routes matching cart / checkout / store patterns.';
  if (id === 'site-enum:blog') return 'Routes matching blog / news / article patterns.';
  if (id === 'site-enum:knowledge_base') return 'Routes matching docs / KB / help patterns.';
  if (id === 'site-enum:form') return 'Pages with prominent form elements (contact / lead / survey).';
  if (id === 'site-enum:members') return 'Auth / portal / dashboard / login routes — anything behind authentication.';
  if (id === 'site-enum:api') {
    return 'Backend HTTP endpoints — captured via XHR/fetch during JS render plus Supabase tables / RPC calls / REST path strings parsed out of the loaded JS bundles.';
  }
  if (id === 'site-enum:integration') {
    return 'Third-party services declared via preconnect / dns-prefetch tags or detected through cross-origin XHR (Razorpay, Google OAuth, Supabase, etc.).';
  }
  if (id === 'site-enum:web_input_fields') {
    return 'Sum of <input>, <textarea>, <select> elements counted directly from the rendered DOM of every crawled page.';
  }
  if (id === 'site-enum:api_input_fields:estimated') {
    return 'Estimated from the discovered API endpoint count × 1.5 input fields per endpoint (conservative — typical REST endpoint takes 1-3 input fields). Not measured directly without OpenAPI spec / authentication.';
  }
  if (id.startsWith('site-enum:')) return `Items classified as "${id.replace('site-enum:', '')}" by the crawler.`;
  return 'Discovered during site enumeration.';
}

/** Render the per-line math depending on pricing model. */
function describeMath(line: BasePriceLine, fmt: (cents: number) => string): string | null {
  if (line.unmatched || line.manualQuoteRequired) return null;
  if (line.pricingModel === 'per_unit' && line.unitPriceCents != null) {
    return `${line.scopeValue} ${line.scopeUnit} × ${fmt(line.unitPriceCents)}/unit  =  ${fmt(line.priceCents)}`;
  }
  // tier_lookup / flat — the tier price IS the line price.
  return `Flat tier price: ${fmt(line.priceCents)} (matched bracket "${line.tierLabel ?? '—'}")`;
}

/** Brief note explaining why a particular methodology was chosen. */
function describeMethodology(line: BasePriceLine): string | null {
  if (line.unmatched || line.manualQuoteRequired) return null;
  if (line.methodology === 'grey_box') {
    return `grey_box — this service line only has tiers for grey-box testing (requires test credentials).`;
  }
  if (line.methodology === 'black_box') {
    return `black_box — default for external customers (no credentials supplied).`;
  }
  if (line.methodology === 'white_box') {
    return `white_box — full source-code access required.`;
  }
  return null;
}

/** Suggest a slug substring for unmatched lines so the rep knows what
 *  to add to the rate card. */
function slugHintFor(entityId: string): string {
  if (entityId === 'site-enum:integration') return 'third_party_integration';
  if (entityId === 'site-enum:attachment') return 'document_attachment';
  if (entityId === 'site-enum:media') return 'media_asset';
  if (entityId === 'site-enum:module') return 'app_module';
  return 'matching slug';
}

/** Full-screen overlay listing every discovered page. Searchable +
 *  filterable by category. Backs the "View all N items" button on
 *  the SiteScopeCard. */
function DiscoveredPagesModal({
  engagementId,
  siteUrl,
  onClose,
}: {
  engagementId: string;
  siteUrl: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<DiscoveredPageRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');

  useEffect(() => {
    siteEnumeration.listPages(engagementId)
      .then(setRows)
      .catch((e) => setErr(describeError(e)));
  }, [engagementId]);

  // Close on Escape — common modal affordance.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categories = rows
    ? [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))].sort()
    : [];
  const filtered = (rows ?? []).filter((r) => {
    if (categoryFilter && r.category !== categoryFilter) return false;
    if (!filter) return true;
    const f = filter.toLowerCase();
    return (
      r.url.toLowerCase().includes(f) ||
      (r.title ?? '').toLowerCase().includes(f) ||
      (r.category ?? '').toLowerCase().includes(f)
    );
  });
  const sameHost = siteHost(siteUrl);

  return (
    <Overlay onClose={onClose} zIndex={1000} label="Discovered pages">
        <div
          style={{
            background: 'var(--bg)', borderRadius: 8,
            width: 'min(1200px, 95vw)', maxHeight: '90vh',
            display: 'flex', flexDirection: 'column',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          }}
        >
          <div style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>All discovered items</div>
              <div className="mono" style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                {siteUrl}
              </div>
            </div>
            <button className="btn sm ghost" onClick={onClose}>
              <Icon.X size={11} /> Close
            </button>
          </div>

          <div style={{
            padding: '10px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
          }}>
            <input
              type="text"
              placeholder="Filter URL / title / category…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                flex: 1, minWidth: 200, padding: '6px 10px',
                background: 'var(--bg-sunk)', borderRadius: 4,
                border: '1px solid var(--divider)', fontSize: 12,
              }}
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              style={{
                padding: '6px 10px',
                background: 'var(--bg-sunk)', borderRadius: 4,
                border: '1px solid var(--divider)', fontSize: 12,
              }}
            >
              <option value="">All categories</option>
              {categories.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c as SiteUrlCategory] ?? c}</option>
              ))}
            </select>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
              Showing <b>{filtered.length}</b> of <b>{rows?.length ?? '…'}</b> items
            </span>
          </div>

          <div style={{ overflow: 'auto', flex: 1 }}>
            {err && (
              <div style={{ padding: 14, color: 'var(--danger)', fontSize: 12 }}>{err}</div>
            )}
            {!rows && !err && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--fg-muted)' }}>
                <span className="spin" /> Loading…
              </div>
            )}
            {rows && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'var(--bg-sunk)', position: 'sticky', top: 0 }}>
                    <th style={th()}>Category</th>
                    <th style={th()}>URL</th>
                    <th style={th()}>Title</th>
                    <th style={th()}>HTTP</th>
                    <th style={th()}>Source</th>
                    <th style={th()}>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r, i) => (
                    <tr key={r.url + i} style={{ borderBottom: '1px solid var(--divider)' }}>
                      <td style={td()}>
                        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                          {r.category ? (CATEGORY_LABEL[r.category as SiteUrlCategory] ?? r.category) : '—'}
                        </span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11, wordBreak: 'break-all' }}>
                          {urlPath(r.url, sameHost)}
                        </span>
                      </td>
                      <td style={td()}>
                        <span style={{ fontSize: 11.5 }}>{r.title ?? '—'}</span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11 }}>{r.httpStatus ?? '—'}</span>
                      </td>
                      <td style={td()}>
                        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                          {r.classifierSource ?? '—'}
                        </span>
                      </td>
                      <td style={td()}>
                        <span className="mono" style={{ fontSize: 11 }}>
                          {r.classifierConfidence != null ? r.classifierConfidence.toFixed(2) : '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
    </Overlay>
  );
}

function th(): React.CSSProperties {
  return {
    textAlign: 'left', padding: '8px 12px',
    fontSize: 10.5, fontWeight: 600, color: 'var(--fg-muted)',
    textTransform: 'uppercase', letterSpacing: 0.4,
    borderBottom: '1px solid var(--divider)',
  };
}
function td(): React.CSSProperties {
  return { padding: '6px 12px', verticalAlign: 'top' };
}

/** Quick-reference card: every estimation rule + assumption used to
 *  produce derived line items. Surfaces what's measured vs what's
 *  inferred so the rep can defend the quote to the client. */
function EstimationMethodologyPanel({ preview }: { preview: SiteEnumQuotePreview }) {
  const hasEstimated = preview.lines.some((l) => l.entityId.endsWith(':estimated'));
  const hasUnmatched = preview.hasUnmatched;
  const hasManual = preview.hasManualQuoteRequired;
  if (!hasEstimated && !hasUnmatched && !hasManual) return null;
  return (
    <div style={{
      padding: '12px 14px', marginTop: 8, marginBottom: 12,
      background: 'var(--bg-sunk)', borderRadius: 6,
      border: '1px solid var(--divider)', fontSize: 11.5,
      color: 'var(--fg-muted)', lineHeight: 1.55,
    }}>
      <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
        How the quote was derived
      </div>
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        <li>
          <b>Pages</b> — counted from distinct same-origin URLs the JS-rendering crawler
          successfully fetched. SPAs flip from <span className="mono">static_pages</span> to
          {' '}<span className="mono">dynamic_pages</span> (higher per-unit price).
        </li>
        <li>
          <b>API endpoints</b> — measured: cross-origin XHR/fetch captured during render
          plus Supabase tables / RPC names / literal REST paths grep&apos;d out of every
          loaded JS bundle (recursive chunk discovery).
        </li>
        <li>
          <b>Web app input fields</b> — measured: live DOM count of
          {' '}<span className="mono">&lt;input&gt;</span>,
          {' '}<span className="mono">&lt;textarea&gt;</span>,
          {' '}<span className="mono">&lt;select&gt;</span> per rendered page, summed.
        </li>
        <li>
          <b>API input fields <span style={{ color: 'var(--warn)' }}>(estimated)</span></b> —
          derived as <span className="mono">round(API endpoints × 1.5)</span>. Conservative —
          typical REST endpoint takes 1-3 input fields. Not directly measurable without
          OpenAPI spec or authenticated probing.
        </li>
        <li>
          <b>Methodology</b> — auto-picked per service line. <span className="mono">black_box</span>
          {' '}for external customers by default; service lines that only have
          {' '}<span className="mono">grey_box</span> tiers (login modules, etc.) flip
          automatically since black_box would never match.
        </li>
        <li>
          <b>Tier matched</b> — pricing engine picks the first tier whose range contains the
          scope value, filtered by methodology + customer type. Per-unit lines multiply by
          the scope value; tier-lookup lines are flat per bracket.
        </li>
        {hasUnmatched && (
          <li style={{ color: 'var(--danger)' }}>
            <b>Unmatched rows</b> — categories the rate card has no slug for. Add the slug
            (suggested below each row) and re-quote to capture them.
          </li>
        )}
        {hasManual && (
          <li style={{ color: 'var(--warn)' }}>
            <b>Open-priced rows</b> — service lines marked manual-quote on the rate card.
            Negotiate with the client and enter the price by hand.
          </li>
        )}
      </ul>
    </div>
  );
}

