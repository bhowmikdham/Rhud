'use client';

/**
 * ComparableDeals — a read-only "you priced similar before" history strip for
 * the Price focus. Surfaces the nearest-neighbour quotes the predictor leaned
 * on for the latest whole-deal price prediction, so a rep can sanity-check the
 * number against what they charged on comparable past deals.
 *
 * Purely presentational: it reads the LATEST `price_predicted` thread event,
 * pulls `payload.topK`, and renders up to three rows. No actions, no editable
 * cells, no network — there is nothing to save, so the optimistic/rollback and
 * per-row-loading machinery does not apply here.
 */
import type { ThreadEventRow } from '@/lib/api';
import { Icon } from '@/components/icon';
import { formatMoney } from './format';

interface Comparable {
  score: number;
  priceCents: number;
  scopeSummary: string;
}

/** Narrow `payload` (typed as unknown on ThreadEventRow) to the topK array we
 *  need, returning [] for anything malformed so the caller can bail cleanly. */
function readTopK(payload: unknown): Comparable[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const topK = (payload as { topK?: unknown }).topK;
  if (!Array.isArray(topK)) return [];
  return topK.filter(
    (c): c is Comparable =>
      typeof c === 'object' &&
      c !== null &&
      typeof (c as Comparable).score === 'number' &&
      typeof (c as Comparable).priceCents === 'number' &&
      typeof (c as Comparable).scopeSummary === 'string',
  );
}

export function ComparableDeals({
  thread,
  currency,
}: {
  thread: ThreadEventRow[];
  currency: string;
}) {
  // Latest, not first: a re-price appends a fresh price_predicted event, and we
  // want the comparables behind the number currently on screen.
  let latest: ThreadEventRow | undefined;
  for (const event of thread) {
    if (event.eventType !== 'price_predicted') continue;
    if (!latest || event.createdAt > latest.createdAt) latest = event;
  }
  if (!latest) return null;

  const comparables = readTopK(latest.payload).slice(0, 3);
  if (comparables.length === 0) return null;

  return (
    <section
      aria-label="Comparable past quotes"
      style={{ marginTop: 12 }}
    >
      <div
        className="section-label"
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}
      >
        <Icon.Clock size={11} aria-hidden="true" />
        Comparable past quotes
      </div>

      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {comparables.map((c, i) => (
          <li
            // Composite key — score+price+scope is stable across re-renders and
            // distinguishes rows; the trailing index only breaks exact dupes.
            key={`${c.score}:${c.priceCents}:${c.scopeSummary}:${i}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 10px',
              borderRadius: 'var(--radius)',
              background: 'var(--bg-sunk)',
              border: '1px solid var(--divider)',
              transition: 'background 180ms ease, border-color 180ms ease',
            }}
          >
            <span
              title={c.scopeSummary}
              style={{
                flex: 1,
                minWidth: 0,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontSize: 12.5,
                color: 'var(--fg-muted)',
              }}
            >
              {c.scopeSummary}
            </span>
            <span
              style={{
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--fg)',
                fontVariantNumeric: 'tabular-nums',
                whiteSpace: 'nowrap',
              }}
            >
              {formatMoney(c.priceCents, currency)}
            </span>
            <span
              className="chip accent"
              aria-label={`Similarity ${Math.round(c.score * 100)} percent`}
              style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {Math.round(c.score * 100)}%
            </span>
          </li>
        ))}
      </ul>

      <p
        style={{
          margin: '8px 0 0',
          // Meaningful caption — must clear the 4.5:1 contrast floor, so
          // --fg-muted (≈4.6:1 on light) rather than --fg-faint (≈1.9:1).
          fontSize: 'var(--text-2xs)',
          lineHeight: 1.45,
          color: 'var(--fg-muted)',
        }}
      >
        From the latest price prediction — whole-deal comparables, not per-line.
      </p>

      {/* Below ~640px the row reflows so the scope summary, price and chip stack
          instead of crushing the truncated summary. Scoped by data attribute so
          it can't leak to other lists on the page. */}
      <style jsx>{`
        @media (max-width: 640px) {
          li {
            flex-wrap: wrap;
          }
          li > span:first-child {
            flex-basis: 100%;
            white-space: normal;
          }
        }
      `}</style>
    </section>
  );
}
