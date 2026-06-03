'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  describeError,
  extraction,
  type BasePriceLine,
  type FileExtraction,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { formatMoney } from './format';

// ── Base scope-pricing table (Price focus) ───────────────────────────────
//
// The editable BASE breakdown the reviewer adjusts before a quote goes out:
// one row per service-line entity the rate card priced (the VAPT / API
// breakdown). The reviewer's primary lever is the *scope value* — the LLM is
// frequently conservative ("1 api" inferred from `api_usage: Yes` when the
// document actually scopes 23). Editing scope here re-prices the line.
//
// Editing routes through `extraction.overrideEntity(engagementId, fileId,
// slug, { scopeValue })`. The catch: `fileId` is NOT carried on a
// `BasePriceLine`. A base line only knows its `serviceLineSlug`. So on mount
// we fetch `extraction.list(engagementId)` and build a slug → { fileId, slug }
// map from every file's `inferredEntities`. A line is EDITABLE iff `canEdit`
// AND its slug appears in that map (i.e. it originated from an uploaded
// document). Lines without a match came from a template answer or the
// site-enumeration path — those have no inferred-entity to override, so they
// render READ-ONLY with a 'derived' provenance tag.
//
// This mirrors `InferredEntityRow` in extracted-points-card.tsx exactly:
// controlled scope input, save-on-blur, per-row busy state, optimistic update
// with rollback on error.

/** Resolves a base line's slug to the file + slug needed to override it. */
type OverrideTarget = { fileId: string; slug: string };

export function ScopePricingTable({
  engagementId,
  baseBreakdown,
  currency,
  canEdit,
  onRepriced,
}: {
  engagementId: string;
  baseBreakdown: BasePriceLine[];
  currency: string;
  canEdit: boolean;
  onRepriced: () => void | Promise<void>;
}) {
  // slug → override target. Lines whose slug is absent are read-only.
  const [editableSlugs, setEditableSlugs] = useState<Map<string, OverrideTarget> | null>(null);
  // Optimistic scope overrides keyed by entityId. Lets the new number paint
  // immediately while `onRepriced()` refreshes the real, re-priced breakdown.
  const [optimistic, setOptimistic] = useState<Record<string, number>>({});
  // Per-row lifecycle: which entityId is saving, which last failed, which
  // just succeeded (drives the transient "saved" tick). Keyed by entityId so
  // two rows can be in flight independently without stomping each other.
  const [savingId, setSavingId] = useState<string | null>(null);
  const [errorByRow, setErrorByRow] = useState<Record<string, string>>({});
  const [savedId, setSavedId] = useState<string | null>(null);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build the slug → { fileId, slug } map once on mount. We deliberately keep
  // the FIRST file that owns a slug — if the same service line was inferred
  // from two documents, the override endpoint is idempotent per (file, slug),
  // and the first is the stable pick across refreshes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const files: FileExtraction[] = await extraction.list(engagementId);
        if (cancelled) return;
        const map = new Map<string, OverrideTarget>();
        for (const file of files) {
          for (const entity of file.inferredEntities) {
            if (!map.has(entity.serviceLineSlug)) {
              map.set(entity.serviceLineSlug, { fileId: file.id, slug: entity.serviceLineSlug });
            }
          }
        }
        setEditableSlugs(map);
      } catch {
        // A failed lookup must not strand the table — fall back to an empty
        // map so every line renders read-only rather than blocking forever.
        if (!cancelled) setEditableSlugs(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [engagementId]);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const flashSaved = useCallback((entityId: string) => {
    setSavedId(entityId);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setSavedId(null), 2_200);
  }, []);

  // Save one line's scope value. Optimistic: paint the new number, clear any
  // prior error, then call the override + `onRepriced`. On failure roll the
  // optimistic value back and surface a per-row message.
  const saveScope = useCallback(
    async (line: BasePriceLine, nextValue: number, target: OverrideTarget) => {
      setErrorByRow((prev) => {
        if (!(line.entityId in prev)) return prev;
        const next = { ...prev };
        delete next[line.entityId];
        return next;
      });
      setOptimistic((prev) => ({ ...prev, [line.entityId]: nextValue }));
      setSavingId(line.entityId);
      try {
        await extraction.overrideEntity(engagementId, target.fileId, target.slug, {
          scopeValue: nextValue,
        });
        // Let the parent refetch the re-priced breakdown. Once that lands the
        // server number is authoritative, so drop our optimistic shadow.
        await onRepriced();
        setOptimistic((prev) => {
          const next = { ...prev };
          delete next[line.entityId];
          return next;
        });
        flashSaved(line.entityId);
      } catch (caught) {
        // Roll back the optimistic value so the input reverts to the truth.
        setOptimistic((prev) => {
          const next = { ...prev };
          delete next[line.entityId];
          return next;
        });
        setErrorByRow((prev) => ({ ...prev, [line.entityId]: describeError(caught) }));
      } finally {
        setSavingId((cur) => (cur === line.entityId ? null : cur));
      }
    },
    [engagementId, onRepriced, flashSaved],
  );

  const baseTotalCents = useMemo(
    () => baseBreakdown.reduce((sum, l) => sum + l.priceCents, 0),
    [baseBreakdown],
  );

  if (baseBreakdown.length === 0) {
    return (
      <div className="card" style={{ padding: 22 }}>
        <div className="section-label" style={{ marginBottom: 6 }}>Base scope lines</div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
          No priced scope lines yet — once the rate card matches an inferred
          service line it will appear here for review.
        </div>
      </div>
    );
  }

  const sym = currency; // formatMoney handles symbol/locale; kept for clarity.
  void sym;

  return (
    <div className="card" style={{ padding: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
        <div className="section-label">Base scope lines</div>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {baseBreakdown.length} line{baseBreakdown.length === 1 ? '' : 's'}
        </span>
      </div>
      <p style={{ fontSize: 11.5, color: 'var(--fg-muted)', margin: '0 0 14px' }}>
        {canEdit
          ? 'Adjust the scope on any document-sourced line — the rate card re-prices it on save.'
          : 'Read-only — you do not have edit access to this engagement’s scope.'}
      </p>

      {/* Desktop / tablet: real table. Collapses to stacked cards under ~640px
          via the responsive override at the bottom of this component. */}
      <div className="scope-pricing-wrap" data-variant="table">
        <table className="scope-pricing-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <Th>Scope line</Th>
              <Th>Scope</Th>
              <Th>Method</Th>
              <Th align="right">Rate</Th>
              <Th align="right">Line</Th>
            </tr>
          </thead>
          <tbody>
            {baseBreakdown.map((line) => {
              const target = editableSlugs?.get(line.serviceLineSlug) ?? null;
              const editable = canEdit && !!target;
              return (
                <ScopeRow
                  key={line.entityId}
                  line={line}
                  currency={currency}
                  editable={editable}
                  target={target}
                  optimisticValue={optimistic[line.entityId]}
                  saving={savingId === line.entityId}
                  saved={savedId === line.entityId}
                  error={errorByRow[line.entityId] ?? null}
                  onSave={saveScope}
                />
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={4} style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 600, color: 'var(--fg-muted)', borderTop: '1px solid var(--border)' }}>
                Base total
              </td>
              <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', borderTop: '1px solid var(--border)' }}>
                {formatMoney(baseTotalCents, currency)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Scoped responsive + cell styling. No Tailwind: a single styled-jsx
          block keyed to the component's own class names. Under 640px the
          table, thead, tbody, tr and td switch to block layout so each row
          reads as a stacked card with data-label prefixes. */}
      <style jsx>{`
        .scope-pricing-table :global(th),
        .scope-pricing-table :global(td) {
          vertical-align: top;
        }
        @media (max-width: 640px) {
          .scope-pricing-table,
          .scope-pricing-table :global(thead),
          .scope-pricing-table :global(tbody),
          .scope-pricing-table :global(tfoot),
          .scope-pricing-table :global(tr),
          .scope-pricing-table :global(th),
          .scope-pricing-table :global(td) {
            display: block;
            width: 100%;
          }
          .scope-pricing-table :global(thead) {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip: rect(0 0 0 0);
            white-space: nowrap;
          }
          .scope-pricing-table :global(tbody tr) {
            border: 1px solid var(--divider);
            border-radius: var(--radius, 8px);
            background: var(--bg-sunk);
            padding: 10px 12px;
            margin-bottom: 10px;
          }
          .scope-pricing-table :global(tbody td) {
            border: 0 !important;
            padding: 4px 0 !important;
            text-align: left !important;
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: baseline;
          }
          .scope-pricing-table :global(tbody td[data-label])::before {
            content: attr(data-label);
            font-size: 10.5px;
            letter-spacing: 0.04em;
            text-transform: uppercase;
            color: var(--fg-subtle);
            flex-shrink: 0;
          }
          .scope-pricing-table :global(tfoot td) {
            text-align: right !important;
          }
        }
      `}</style>
    </div>
  );
}

// ── One scope line ───────────────────────────────────────────────────────

function ScopeRow({
  line,
  currency,
  editable,
  target,
  optimisticValue,
  saving,
  saved,
  error,
  onSave,
}: {
  line: BasePriceLine;
  currency: string;
  editable: boolean;
  target: OverrideTarget | null;
  optimisticValue: number | undefined;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: (line: BasePriceLine, nextValue: number, target: OverrideTarget) => void | Promise<void>;
}) {
  // The number the reviewer sees: optimistic shadow if present, else the
  // authoritative server value. The text input is controlled from this.
  const serverValue = optimisticValue ?? line.scopeValue;
  const [draft, setDraft] = useState<string>(String(serverValue));

  // Re-sync the input when the server (or optimistic) value changes from the
  // outside — e.g. after a re-price refresh — so it never shows a stale edit.
  // Mirrors InferredEntityRow's reset-on-source-change effect.
  useEffect(() => {
    setDraft(String(serverValue));
  }, [serverValue]);

  const commit = () => {
    if (!editable || !target || saving) return;
    const n = Number(draft);
    if (!Number.isFinite(n) || n <= 0) {
      // Invalid → snap back to the last good value, mirroring the inferred
      // row's "only save a finite, positive, changed value" guard.
      setDraft(String(serverValue));
      return;
    }
    const rounded = Math.round(n);
    if (rounded === line.scopeValue) {
      setDraft(String(line.scopeValue));
      return; // no change — nothing to persist
    }
    void onSave(line, rounded, target);
  };

  const provenance: 'doc' | 'derived' = editable ? 'doc' : 'derived';
  const scopeInputId = `scope-${line.entityId}`;

  return (
    <tr style={{ borderTop: '1px solid var(--divider)', transition: 'background 180ms ease' }}>
      {/* Scope line: name + provenance tag */}
      <td data-label="Scope line" style={cellStyle}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{line.serviceLineName}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ProvenanceTag kind={provenance} />
            {error && (
              <span className="chip danger" style={{ fontSize: 10 }} title={error}>
                <Icon.X size={9} /> Save failed
              </span>
            )}
          </span>
        </div>
      </td>

      {/* Scope: editable number input + unit, or read-only value */}
      <td data-label="Scope" style={cellStyle}>
        {editable ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <input
                id={scopeInputId}
                className="input"
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={draft}
                aria-label={`Scope value for ${line.serviceLineName}, in ${line.scopeUnit}`}
                disabled={saving}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === 'Escape') {
                    setDraft(String(serverValue));
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                style={{
                  width: 78,
                  height: 28,
                  fontSize: 13,
                  padding: '0 8px',
                  fontVariantNumeric: 'tabular-nums',
                  transition: 'border-color 180ms ease, box-shadow 180ms ease',
                }}
              />
              {/* Per-row lifecycle indicator, anchored to the input. State is
                  conveyed by icon + accessible text, never colour alone. */}
              <span
                aria-live="polite"
                style={{
                  position: 'absolute',
                  right: -22,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 16,
                  height: 16,
                  transition: 'opacity 180ms ease',
                }}
              >
                {saving ? (
                  <>
                    <span className="spin" aria-hidden="true" />
                    <span style={srOnly}>Saving</span>
                  </>
                ) : saved ? (
                  <>
                    <Icon.CheckCircle size={13} style={{ color: 'var(--ok)' }} aria-hidden="true" />
                    <span style={srOnly}>Saved</span>
                  </>
                ) : null}
              </span>
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{line.scopeUnit}</span>
          </span>
        ) : (
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            <b style={{ color: 'var(--fg)' }}>{serverValue}</b>{' '}
            <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{line.scopeUnit}</span>
          </span>
        )}
      </td>

      {/* Method: read-only chip of methodology */}
      <td data-label="Method" style={cellStyle}>
        {line.methodology ? (
          <span className="chip outline" style={{ fontSize: 10.5 }}>{line.methodology}</span>
        ) : (
          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
        )}
      </td>

      {/* Rate: the per-unit math, else em-dash */}
      <td data-label="Rate" style={{ ...cellStyle, textAlign: 'right' }}>
        {line.pricingModel === 'per_unit' && line.unitPriceCents != null ? (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>
            {serverValue} × {formatMoney(line.unitPriceCents, currency)}
          </span>
        ) : (
          <span style={{ color: 'var(--fg-subtle)' }}>—</span>
        )}
      </td>

      {/* Line: priced total, or a 'needs price' warn chip for manual quotes */}
      <td data-label="Line" style={{ ...cellStyle, textAlign: 'right' }}>
        {line.manualQuoteRequired ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
            <span style={{ color: 'var(--fg-subtle)' }}>—</span>
            <span className="chip warn" style={{ fontSize: 10 }}>
              <Icon.Dot size={10} /> needs price
            </span>
          </span>
        ) : (
          <b style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--fg)' }}>
            {formatMoney(line.priceCents, currency)}
          </b>
        )}
      </td>
    </tr>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────

const cellStyle: React.CSSProperties = {
  padding: '11px 10px',
  verticalAlign: 'top',
};

const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      style={{
        padding: '0 10px 8px',
        textAlign: align,
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--fg-subtle)',
        borderBottom: '1px solid var(--border)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </th>
  );
}

/**
 * Tiny provenance tag: 'doc' for lines we can re-price from an uploaded
 * document (editable), 'derived' for template-answer / site-enumeration
 * lines that have no inferred-entity to override (read-only). State is
 * carried by icon + label, never colour alone.
 */
function ProvenanceTag({ kind }: { kind: 'doc' | 'derived' }) {
  if (kind === 'doc') {
    return (
      <span
        className="chip accent"
        style={{ fontSize: 9.5, letterSpacing: '0.02em' }}
        title="Sourced from an uploaded document — scope is editable and re-prices on save"
      >
        <Icon.FileText size={9} /> doc
      </span>
    );
  }
  return (
    <span
      className="chip outline"
      style={{ fontSize: 9.5, letterSpacing: '0.02em', color: 'var(--fg-muted)' }}
      title="Derived from a template answer or site enumeration — read-only here"
    >
      <Icon.Lock size={9} /> derived
    </span>
  );
}
