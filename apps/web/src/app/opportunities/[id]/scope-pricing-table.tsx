'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

// A base line plus the optional rate-card-offered methodologies for its slug.
// `allowedMethodologies` is the set of methodology strings the rate card offers
// for this line (may be empty/absent). When present and the line is editable,
// the Method cell renders an editable <select> instead of the read-only chip.
type ScopeLine = BasePriceLine & { allowedMethodologies?: string[] };

/** Turn an appId slug ("crm_frontend", "app_2") into a readable label. */
function humanizeAppId(appId: string): string {
  return appId
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bApp (\d+)\b/, 'Application $1');
}

export function ScopePricingTable({
  engagementId,
  baseBreakdown,
  currency,
  canEdit,
  onRepriced,
}: {
  engagementId: string;
  baseBreakdown: ScopeLine[];
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

  // Save one line's methodology. Mirrors `saveScope`'s row lifecycle: clear any
  // prior error, show the per-row saving spinner, call the override + reprice,
  // flash the saved tick on success, surface a per-row message on failure. A
  // <select> reflects its value immediately, so no optimistic shadow is needed;
  // on error the reprice never lands and the next render reverts to the truth.
  const saveMethodology = useCallback(
    async (line: BasePriceLine, nextValue: string | null, target: OverrideTarget) => {
      setErrorByRow((prev) => {
        if (!(line.entityId in prev)) return prev;
        const next = { ...prev };
        delete next[line.entityId];
        return next;
      });
      setSavingId(line.entityId);
      try {
        await extraction.overrideEntity(engagementId, target.fileId, target.slug, {
          methodology: nextValue,
        });
        await onRepriced();
        flashSaved(line.entityId);
      } catch (caught) {
        setErrorByRow((prev) => ({ ...prev, [line.entityId]: describeError(caught) }));
      } finally {
        setSavingId((cur) => (cur === line.entityId ? null : cur));
      }
    },
    [engagementId, onRepriced, flashSaved],
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
            {/* `editableSlugs === null` means the doc → slug map is still being
                fetched, so we don't yet know which rows are editable. Render
                those rows with a disabled input (stable shape) so resolution
                only toggles `disabled`, never the layout — see ScopeRow. */}
            {(() => {
              const renderRow = (line: ScopeLine) => {
                const loading = editableSlugs === null;
                const target = editableSlugs?.get(line.serviceLineSlug) ?? null;
                const editable = canEdit && !!target;
                return (
                  <ScopeRow
                    key={line.entityId}
                    line={line}
                    currency={currency}
                    editable={editable}
                    canEdit={canEdit}
                    loading={loading}
                    target={target}
                    optimisticValue={optimistic[line.entityId]}
                    saving={savingId === line.entityId}
                    saved={savedId === line.entityId}
                    error={errorByRow[line.entityId] ?? null}
                    onSave={saveScope}
                    onSaveMethodology={saveMethodology}
                  />
                );
              };

              // Multi-application questionnaires produce several lines per
              // app; group + label them so the rep can tell QMS from CRM
              // instead of seeing anonymous repeated rows.
              const multiApp =
                new Set(baseBreakdown.map((l) => l.appId).filter(Boolean)).size >= 2;
              if (!multiApp) return baseBreakdown.map(renderRow);

              const groups = new Map<string, ScopeLine[]>();
              for (const l of baseBreakdown) {
                const k = l.appId ?? '';
                const g = groups.get(k);
                if (g) g.push(l);
                else groups.set(k, [l]);
              }
              const entries = [...groups.entries()].sort(([a], [b]) =>
                a === '' ? 1 : b === '' ? -1 : a.localeCompare(b),
              );
              return entries.flatMap(([appId, lines]) => [
                <tr key={`hdr-${appId || '__shared__'}`}>
                  <td colSpan={5} style={{
                    paddingTop: 12, paddingBottom: 4,
                    fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
                    textTransform: 'uppercase', color: 'var(--fg-muted)',
                    borderBottom: '1px solid var(--divider)',
                  }}>
                    {appId ? humanizeAppId(appId) : 'Shared / infrastructure'}
                    {lines.some((l) => l.pooledAcross) && (
                      <span style={{ fontWeight: 500, textTransform: 'none', marginLeft: 8 }}>
                        · volume-pooled across {lines.find((l) => l.pooledAcross)!.pooledAcross} apps
                      </span>
                    )}
                  </td>
                </tr>,
                ...lines.map(renderRow),
              ]);
            })()}
          </tbody>
          {/* Total moved to the unified pricing footer below (base + extras + grand). */}
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
  canEdit,
  loading,
  target,
  optimisticValue,
  saving,
  saved,
  error,
  onSave,
  onSaveMethodology,
}: {
  line: ScopeLine;
  currency: string;
  editable: boolean;
  /** The user may edit in principle (RLS/role) — independent of whether this
   *  specific line resolved to an override target yet. */
  canEdit: boolean;
  /** The editability lookup hasn't resolved; render a disabled input so the
   *  row's shape is stable and only `disabled` flips once we know. */
  loading: boolean;
  target: OverrideTarget | null;
  optimisticValue: number | undefined;
  saving: boolean;
  saved: boolean;
  error: string | null;
  onSave: (line: BasePriceLine, nextValue: number, target: OverrideTarget) => void | Promise<void>;
  onSaveMethodology: (line: BasePriceLine, nextValue: string | null, target: OverrideTarget) => void | Promise<void>;
}) {
  // Show the number input for any line the user could edit (during loading we
  // don't yet know per-line, so optimistically show it disabled) and for lines
  // that resolved to an override target. Derived/read-only lines render the
  // value instead. Keeping both branches the same height avoids a layout shift
  // when the lookup resolves.
  const showInput = canEdit && (loading || !!target);
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

  // The Method cell becomes an editable rate-card-driven <select> only when the
  // line is editable AND the rate card offers methodologies for its slug.
  // Otherwise it stays a read-only chip (or em-dash).
  const allowedMethodologies = line.allowedMethodologies ?? [];
  const methodEditable = editable && allowedMethodologies.length > 0;

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
        {showInput ? (
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
                aria-busy={loading}
                disabled={saving || loading}
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
          // Same min-height as the input so a derived line resolving from the
          // loading placeholder doesn't change the row height.
          <span style={{ fontVariantNumeric: 'tabular-nums', display: 'inline-flex', alignItems: 'center', minHeight: 28 }}>
            <b style={{ color: 'var(--fg)' }}>{serverValue}</b>{' '}
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--fg-muted)', marginLeft: 4 }}>{line.scopeUnit}</span>
          </span>
        )}
      </td>

      {/* Method: editable rate-card <select> when the card offers
          methodologies for this editable line, else a read-only chip. */}
      <td data-label="Method" style={{ ...cellStyle, paddingTop: 8, paddingBottom: 8 }}>
        {methodEditable ? (
          <select
            className="input"
            value={line.methodology ?? ''}
            aria-label={`Methodology for ${line.serviceLineName}`}
            disabled={saving}
            onChange={(e) => {
              if (!target) return;
              void onSaveMethodology(line, e.target.value || null, target);
            }}
            style={{
              // ~28px control styled like the scope input; the cell's 8px top+
              // bottom padding lifts the surrounding tap region to ≥44px.
              height: 28,
              fontSize: 13,
              padding: '0 8px',
              maxWidth: 180,
              transition: 'border-color 180ms ease, box-shadow 180ms ease',
            }}
          >
            <option value="">— any</option>
            {allowedMethodologies.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        ) : line.methodology ? (
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
