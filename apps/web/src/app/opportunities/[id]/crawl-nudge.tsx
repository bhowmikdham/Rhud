'use client';

import { useEffect, useState } from 'react';
import { siteEnumeration } from '@/lib/api';
import { Icon } from '@/components/icon';

/**
 * One-line bridge banner: when a site crawl has completed and found a
 * positive number of URLs, nudge the rep to review the scope it adds
 * to pricing. Deliberately NOT the full SiteScopeCard — just a single
 * compact warn-tinted banner with a button into the Scope focus.
 *
 * Reads `siteEnumeration.get(engagementId)` → SiteEnumerationStateView.
 * Fields used: `status` (banner shows only when === 'ready') and
 * `totalUrls` (the discovered-URL count rendered as {N}).
 *
 * Renders nothing (null) when: still loading, no crawl exists, the
 * crawl isn't ready, nothing was discovered, or the fetch errors.
 */
export function CrawlNudge({
  engagementId,
  onReviewInScope,
}: {
  engagementId: string;
  onReviewInScope: () => void;
}) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    // Guard against a late resolve writing into an unmounted component
    // (or a stale engagementId after navigation).
    let cancelled = false;
    siteEnumeration
      .get(engagementId)
      .then((state) => {
        if (cancelled) return;
        // Only bridge once the crawl has finished AND actually
        // enumerated something. Anything else → render nothing.
        if (state && state.status === 'ready' && state.totalUrls > 0) {
          setCount(state.totalUrls);
        } else {
          setCount(null);
        }
      })
      .catch(() => {
        // No crawl / network error / not found — stay silent.
        if (!cancelled) setCount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId]);

  if (count == null) return null; // nothing discovered / not ready / error

  return (
    <div
      className="card"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        marginTop: 16,
        background: 'var(--warn-tint)',
        borderLeft: '3px solid var(--warn)',
        transition: 'background 200ms ease, border-color 200ms ease',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'grid',
          placeItems: 'center',
          color: 'var(--warn)',
          flexShrink: 0,
        }}
      >
        <Icon.Globe size={15} />
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 12.5,
          color: 'var(--fg)',
          lineHeight: 1.4,
        }}
      >
        Site crawl found <b>{count}</b> {count === 1 ? 'page' : 'pages'} — review
        the scope it adds to pricing.
      </span>
      <button
        type="button"
        className="btn sm"
        onClick={onReviewInScope}
        style={{ flexShrink: 0 }}
      >
        <Icon.ArrowRight size={11} /> Review in Scope
      </button>
    </div>
  );
}
