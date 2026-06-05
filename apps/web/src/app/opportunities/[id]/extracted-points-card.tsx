'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  describeError,
  extraction,
  type ExtractedPoint,
  type FileExtraction,
  type InferredEntity,
  type PointCategory,
  type ParsedDocument,
} from '@/lib/api';
import { Icon } from '@/components/icon';

// ── Extracted points (client-uploaded documents) ─────────────────────────

/**
 * Renders every file the client attached + the structured points the
 * extraction pipeline pulled out. Polls every 5s while any file is
 * still in `pending` / `processing` so the user sees points appear
 * as the LLM finishes each document. Hides itself entirely when the
 * engagement has zero files (the common case for templates without
 * an `allowFiles` question).
 */
export function ExtractedPointsCard({ engagementId }: { engagementId: string }) {
  const [files, setFiles] = useState<FileExtraction[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openText, setOpenText] = useState<Set<string>>(new Set());
  void openText; // reserved for future per-file raw-text preview toggle
  // Per-file "Parsed structure" panel state. Map: fileId → loading/loaded
  // ParsedDocument or null when expanded but the row has no Document.
  const [parsedDocs, setParsedDocs] = useState<Record<string, ParsedDocument | null | 'loading'>>({});
  // Top-level collapse: by default the whole "Extracted from client documents"
  // card is closed once everything is ready, so it doesn't dwarf the rest of
  // the page. We auto-open while files are in flight (so the rep sees points
  // appear in real time), and stay open if the user manually expanded.
  const [cardOpen, setCardOpen] = useState<boolean>(true);
  const [userToggled, setUserToggled] = useState(false);
  // Per-file: the long list of extracted points (scope rows + every "other"
  // identity/contact field) collapses by default. Inferred-for-pricing stays
  // visible since it's the actionable bit.
  const [openPoints, setOpenPoints] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const list = await extraction.list(engagementId);
      setFiles(list);
    } catch (e) {
      setErr(describeError(e));
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Poll while any file is in flight. 5s matches our other Gamma /
  // status loops — fast enough that the UI feels live, slow enough
  // we don't hammer the API for engagements with 5+ documents.
  // Keep polling for retry_queued too — the cron flips them back to
  // processing on its own, and the rep needs to see that transition.
  // Keep polling for retry_queued too — the cron flips them back to processing.
  const pollInFlight =
    !!files &&
    files.some((f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued');
  // Depend on the primitive `pollInFlight` so the 5s interval is created once
  // when work starts and cleared once when it ends — not re-subscribed on
  // every tick (which the old `[files]` dependency did).
  useEffect(() => {
    if (!pollInFlight) return;
    const handle = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(handle);
  }, [pollInFlight, refresh]);

  // Auto-collapse rule: when nothing is in flight any more, fold the card
  // shut so the page stays compact. Skip if the user manually toggled —
  // we don't want to override an explicit "show me everything" intent.
  useEffect(() => {
    if (!files || userToggled) return;
    const inFlight = files.some(
      (f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued',
    );
    setCardOpen(inFlight);
  }, [files, userToggled]);

  async function reExtract(fileId: string) {
    setBusyId(fileId); setErr(null);
    try {
      await extraction.reExtract(engagementId, fileId);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Re-run only Layer-3 mapping (no full re-extract). Cheap path: skips
   * S3 fetch + text extraction, reuses the cached extracted_points to
   * call the LLM mapper again. Use after a 429 rate-limit or to pick up
   * tweaked rate-card hints / new enrichment without paying for a full
   * pass.
   */
  async function rerunMapping(fileId: string) {
    setBusyId(fileId); setErr(null);
    try {
      await extraction.rerunInference(engagementId, fileId);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  /**
   * Toggle the "Parsed structure" panel for a file. First open lazy-
   * loads the canonical RhudDocument; subsequent toggles reuse the
   * cached state. Setting `undefined` collapses the panel entirely.
   */
  async function toggleParsedDoc(fileId: string) {
    setParsedDocs((prev) => {
      // Already loaded or loading → collapse by removing the key.
      if (fileId in prev) {
        const next = { ...prev };
        delete next[fileId];
        return next;
      }
      // Mark loading immediately so the UI shows a spinner.
      return { ...prev, [fileId]: 'loading' };
    });
    if (fileId in parsedDocs) return; // collapsing — nothing to fetch
    try {
      const out = await extraction.parsedDocument(engagementId, fileId);
      setParsedDocs((prev) => ({ ...prev, [fileId]: out.document }));
    } catch (e) {
      setErr(describeError(e));
      setParsedDocs((prev) => {
        const next = { ...prev };
        delete next[fileId]; // collapse on error so the user can retry
        return next;
      });
    }
  }

  // Don't render the card at all when there are no files — adds noise
  // for templates that don't ask for attachments.
  if (files === null) return null;
  if (files.length === 0) return null;

  const anyInFlight = files.some(
    (f) => f.status === 'pending' || f.status === 'processing' || f.status === 'retry_queued',
  );
  const totalPoints = files.reduce((s, f) => s + f.points.length, 0);
  const totalInferred = files.reduce((s, f) => s + f.inferredEntities.length, 0);

  function toggleCard() {
    setUserToggled(true);
    setCardOpen((v) => !v);
  }
  function togglePoints(fileId: string) {
    setOpenPoints((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      {/* Click-anywhere header that toggles the whole card */}
      <button
        type="button"
        onClick={toggleCard}
        style={{
          appearance: 'none', background: 'transparent', border: 0, padding: 0, margin: 0,
          font: 'inherit', color: 'inherit', textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          width: '100%',
          marginBottom: cardOpen ? 12 : 0,
        }}
        aria-expanded={cardOpen}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <span style={{
            width: 18, height: 18, display: 'grid', placeItems: 'center',
            color: 'var(--fg-muted)', flexShrink: 0,
          }}>
            {cardOpen ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="section-label">Extracted from client documents</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              {anyInFlight
                ? 'Processing documents — pricing waits until everything is read.'
                : (
                  <>
                    <b>{files.length}</b> file{files.length === 1 ? '' : 's'}
                    <span style={{ color: 'var(--fg-subtle)' }}> · </span>
                    <b>{totalPoints}</b> data point{totalPoints === 1 ? '' : 's'}
                    {totalInferred > 0 && (
                      <>
                        <span style={{ color: 'var(--fg-subtle)' }}> · </span>
                        <b>{totalInferred}</b> inferred for pricing
                      </>
                    )}
                  </>
                )}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {anyInFlight && (
            <span className="chip warn"><Icon.Clock size={10} /> Processing</span>
          )}
          {!anyInFlight && totalInferred > 0 && (
            <span className="chip ok" style={{ fontSize: 10.5 }}>
              <Icon.Check size={10} /> Ready
            </span>
          )}
        </div>
      </button>

      {cardOpen && (
        <>
          {err && (
            <div style={{
              padding: 10, fontSize: 12.5, marginBottom: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{err}</div>
          )}

          {!anyInFlight && files[0]?.diagnostics && (
            <PipelineDiagnostic d={files[0].diagnostics} totalExtracted={totalPoints} />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {files.map((f) => {
              const pointsOpen = openPoints.has(f.id);
              return (
                <div key={f.id} style={{
                  padding: 12, borderRadius: 8,
                  background: 'var(--bg-sunk)',
                  border: '1px solid var(--divider)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <span style={{
                      width: 28, height: 28, borderRadius: 6,
                      background: fileColor(f.contentType), color: '#fff',
                      display: 'grid', placeItems: 'center',
                      fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                      flexShrink: 0,
                    }}>{fileGlyph(f.contentType, f.filename)}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {f.filename}
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                        <ExtractionStatusChip
                          status={f.status}
                          pointCount={f.points.length}
                          retryAt={f.retryAt}
                          attempts={f.attempts}
                        />
                        {f.error && f.status !== 'ready' && (
                          <span style={{ marginLeft: 8, color: 'var(--fg-subtle)' }} title={f.error}>
                            · {humaniseExtractionError(f.error)}
                          </span>
                        )}
                      </div>
                    </div>
                    {/*
                      Parsed structure: shows the canonical RhudDocument
                      (every cell / page / heading) the parser captured
                      BEFORE any LLM step ran. Lets the rep diagnose
                      "did the parser miss something?" separately from
                      "did the LLM mapper choose poorly?". Lazy-loaded
                      on first open.
                    */}
                    {f.status === 'ready' && (
                      <button
                        className="btn sm ghost"
                        onClick={() => void toggleParsedDoc(f.id)}
                        title="Show the structured representation we captured from this file before any LLM step ran"
                      >
                        {parsedDocs[f.id] === 'loading'
                          ? <span className="spin" />
                          : <><Icon.Sparkle size={11} /> {f.id in parsedDocs ? 'Hide' : 'Show'} parsed structure</>}
                      </button>
                    )}
                    {/*
                      Re-run mapping: cheap path that re-classifies cached
                      extracted_points without paying for a full S3 fetch
                      + text-extraction round trip. Only available when
                      points are present (status='ready' AND the file
                      actually produced points). Best after a 429 fallback
                      or after rate-card hints are retuned.
                    */}
                    {f.status === 'ready' && f.points.length > 0 && (
                      <button
                        className="btn sm ghost"
                        disabled={busyId === f.id}
                        onClick={() => void rerunMapping(f.id)}
                        title="Re-classify the existing extracted points without re-fetching the file (use after a rate-limit fallback or rate-card retune)"
                      >
                        {busyId === f.id ? <span className="spin" /> : <><Icon.Sparkle size={11} /> Re-run mapping</>}
                      </button>
                    )}
                    {(f.status === 'ready' || f.status === 'failed' || f.status === 'skipped' || f.status === 'retry_queued' || f.status == null) && (
                      <button
                        className="btn sm ghost"
                        disabled={busyId === f.id}
                        onClick={() => void reExtract(f.id)}
                        title="Re-run extraction on this file"
                      >
                        {busyId === f.id ? <span className="spin" /> : <><Icon.Sparkle size={11} /> Re-extract</>}
                      </button>
                    )}
                  </div>

                  <SheetBreakdown points={f.points} />

                  {/*
                    Parsed-structure panel — renders the canonical
                    RhudDocument captured at parse time, BEFORE any LLM
                    step. Lazy-loaded; "Hide" collapses without losing
                    the cached state.
                  */}
                  {f.id in parsedDocs && parsedDocs[f.id] !== 'loading' && (
                    <ParsedDocumentPanel doc={parsedDocs[f.id] as ParsedDocument | null} />
                  )}

                  {f.inferredEntities.length > 0 && (
                    <InferredEntitiesSection
                      engagementId={engagementId}
                      fileId={f.id}
                      entities={f.inferredEntities}
                      onChange={() => void refresh()}
                    />
                  )}

                  {f.points.length > 0 && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => togglePoints(f.id)}
                        style={{
                          fontSize: 11.5,
                          color: 'var(--fg-muted)',
                          padding: '4px 8px',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        {pointsOpen ? <Icon.ChevronDown size={12} /> : <Icon.ChevronRight size={12} />}
                        {pointsOpen ? 'Hide' : 'Show'} all {f.points.length} extracted point{f.points.length === 1 ? '' : 's'}
                      </button>
                      {pointsOpen && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                          {f.points.map((p, i) => (
                            <div key={`${f.id}-${i}`} style={{
                              display: 'grid',
                              gridTemplateColumns: 'minmax(120px, 200px) 1fr',
                              gap: 12,
                              padding: '6px 8px',
                              borderRadius: 6,
                              background: 'var(--bg)',
                              fontSize: 12.5,
                              alignItems: 'baseline',
                            }}>
                              <div style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {p.category && <CategoryChip category={p.category} />}
                                {p.key}
                                {p.sheet && (
                                  <span style={{ fontSize: 10, marginLeft: 6, color: 'var(--fg-subtle)' }}>
                                    · {p.sheet}
                                  </span>
                                )}
                                {p.relatedQuestion && (
                                  <span className="chip outline" style={{ fontSize: 10, marginLeft: 6, padding: '0 5px' }}>
                                    {p.relatedQuestion}
                                  </span>
                                )}
                              </div>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ wordBreak: 'break-word' }}>{p.value}</div>
                                {p.sourceQuote && (
                                  <div style={{
                                    marginTop: 2, fontSize: 11, color: 'var(--fg-subtle)', fontStyle: 'italic',
                                    borderLeft: '2px solid var(--divider)', paddingLeft: 6,
                                  }}>
                                    “{p.sourceQuote}”
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {f.emptyResult && (
                    <div style={{ fontSize: 12, color: 'var(--fg-subtle)', fontStyle: 'italic', marginTop: 4 }}>
                      Extracted, but nothing pricing-relevant found in this file.
                    </div>
                  )}

                  {(f.status === 'processing' || f.status === 'pending') && (
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                      <span className="spin" /> Reading the file…
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Pipeline-of-counters strip: shows where the chain breaks when the
 * predicted price comes back at INR 0. Reads as five steps:
 *
 *   {extracted}  →  {matched}  →  {answered}  →  {priced}  →  rate-card status
 *
 * Examples:
 *   47 extracted → 0 matched     → fuzzy match too tight, lower threshold or rephrase template Qs
 *   47 extracted → 12 matched    → 12 answered → 0 priced → template Qs lack rate-card bindings
 *   47 → 12 → 12 → 5 priced      → working, base reflects the 5 line items
 *
 * Each step is a chip with the counter and a tooltip explaining what
 * "no progress past here" would imply.
 */
function PipelineDiagnostic({
  d, totalExtracted,
}: {
  d: FileExtraction['diagnostics'];
  totalExtracted: number;
}) {
  const steps: Array<{
    label: string;
    value: number | string;
    tone: 'ok' | 'warn' | 'danger' | 'muted';
    title: string;
  }> = [
    {
      label: 'extracted',
      value: totalExtracted,
      tone: totalExtracted > 0 ? 'ok' : 'danger',
      title: 'Total data points the structured parser pulled from all uploaded files.',
    },
    {
      label: 'matched',
      value: d.matchedToQuestion,
      tone: d.matchedToQuestion > 0 ? 'ok' : 'warn',
      title: d.matchedToQuestion > 0
        ? 'Layer 2: points that matched a template question (will auto-promote to answers).'
        : 'No points matched any template question. The Layer-3 inferred path can still produce a price.',
    },
    {
      label: 'inferred',
      value: d.inferredHighConfidence,
      tone: d.inferredHighConfidence > 0 ? 'ok' : 'warn',
      title: d.inferredHighConfidence > 0
        ? 'Layer 3: service-line entities the field mapper inferred (LLM-first, ≥0.6 confidence).'
        : 'Layer 3 produced no high-confidence entities. The LLM didn\'t see explicit evidence of any service line, or fell back to heuristics that found no domain keywords.',
    },
    {
      label: 'mapped',
      value: d.mappedToRateCard,
      tone: d.mappedToRateCard > 0 ? 'ok' : 'warn',
      title: d.mappedToRateCard > 0
        ? 'Layer 4-5: inferred entities that survived to the priced quote (rate-card tier match).'
        : 'No service lines made it to the priced quote. Either inference returned nothing or every entity hit `unmatched` in tier lookup.',
    },
    {
      label: 'answered',
      value: d.answeredQuestions,
      tone: d.answeredQuestions > 0 ? 'ok' : 'warn',
      title: 'Engagement-wide answer count (form answers + auto-promoted from extraction).',
    },
    {
      label: 'priced',
      value: d.quoteLineItems,
      tone: d.quoteLineItems > 0 ? 'ok' : 'danger',
      title: d.quoteLineItems > 0
        ? 'Answers that produced bookable line items via the rate card.'
        : 'No answer produced a priced line item. Either the template questions lack rate-card bindings, or the rate card has no tier matching the values.',
    },
    {
      label: 'rate card',
      value: d.rateCardBound ? '✓' : '✗',
      tone: d.rateCardBound ? 'ok' : 'danger',
      title: d.rateCardBound
        ? 'Template has a rate card bound — pricing will run.'
        : 'Template has no rate card bound. Open the template and pick one before re-predicting.',
    },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6,
      padding: '8px 10px', marginBottom: 10,
      background: 'var(--bg-sunk)', borderRadius: 8,
      fontSize: 11.5,
    }}>
      <span style={{ color: 'var(--fg-muted)', marginRight: 4 }}>Pipeline:</span>
      {steps.map((s, i) => (
        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span
            className={`chip ${s.tone === 'ok' ? 'ok' : s.tone === 'danger' ? 'danger' : s.tone === 'warn' ? 'warn' : 'outline'}`}
            title={s.title}
            style={{ fontSize: 10.5 }}
          >
            <b style={{ marginRight: 4 }}>{s.value}</b>{s.label}
          </span>
          {i < steps.length - 1 && (
            <span style={{ color: 'var(--fg-subtle)' }}>→</span>
          )}
        </span>
      ))}
    </div>
  );
}

/**
 * Parsed-structure debug panel — renders the canonical RhudDocument
 * the parser captured. Shows sheets as cell grids and text blocks as
 * heading-bounded sections. The point is to answer "what did the
 * parser actually see from this file?" separately from "what did the
 * LLM mapper do with it?"
 *
 * Empty/null doc → tiny note ("no structured representation captured").
 * Legacy rows + plain-text formats hit this branch.
 */
function ParsedDocumentPanel({ doc }: { doc: ParsedDocument | null }) {
  if (!doc) {
    return (
      <div style={{
        marginTop: 10, padding: 10, fontSize: 11.5,
        color: 'var(--fg-subtle)',
        background: 'var(--bg-sunk)',
        border: '1px dashed var(--divider)',
        borderRadius: 6,
      }}>
        No structured representation was captured for this file. (Legacy
        row, plain text, or the parser fell through to the LLM-only path.)
      </div>
    );
  }
  return (
    <div style={{
      marginTop: 10,
      padding: '12px 14px',
      background: 'var(--bg-sunk)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      fontSize: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
        <Icon.Sparkle size={11} />
        <span style={{ fontWeight: 600 }}>Parsed structure</span>
        <span style={{ color: 'var(--fg-subtle)' }}>
          · {doc.sheets.length} sheet{doc.sheets.length === 1 ? '' : 's'}
          {doc.textBlocks.length > 0 && ` · ${doc.textBlocks.length} text block${doc.textBlocks.length === 1 ? '' : 's'}`}
          {doc.warnings.length > 0 && ` · ${doc.warnings.length} warning${doc.warnings.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {doc.warnings.length > 0 && (
        <div style={{
          marginBottom: 8, padding: 8,
          background: 'color-mix(in oklch, var(--warn, #c97a06) 6%, transparent)',
          border: '1px dashed color-mix(in oklch, var(--warn, #c97a06) 35%, transparent)',
          borderRadius: 6,
          fontSize: 11.5,
        }}>
          <div style={{ fontWeight: 600, color: 'var(--warn, #c97a06)' }}>Parser warnings</div>
          <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
            {doc.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
      {doc.sheets.map((sheet) => (
        <div key={sheet.name + ':' + sheet.index} style={{ marginBottom: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Sheet: {sheet.name}
            <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
              · {sheet.rowCount} row{sheet.rowCount === 1 ? '' : 's'} × {sheet.columnCount} col{sheet.columnCount === 1 ? '' : 's'}
              {sheet.detectedShape && ` · detected: ${sheet.detectedShape}`}
            </span>
          </div>
          <div style={{
            maxHeight: 320, overflow: 'auto',
            border: '1px solid var(--divider)',
            borderRadius: 6,
            background: 'var(--bg)',
          }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontFamily: 'var(--font-mono)', fontSize: 11.5,
            }}>
              <tbody>
                {sheet.rows.map((row) => {
                  // Reconstruct the column-major view including blanks
                  // so the user sees the source layout, not a packed list.
                  const cellsByCol = new Map(row.cells.map((c) => [c.column, c]));
                  const maxCol = Math.max(0, ...row.cells.map((c) => c.column));
                  const cols: Array<typeof row.cells[number] | null> = [];
                  for (let c = 0; c <= maxCol; c++) {
                    cols.push(cellsByCol.get(c) ?? null);
                  }
                  return (
                    <tr key={row.index}>
                      <td style={{
                        padding: '3px 6px',
                        color: 'var(--fg-subtle)',
                        borderRight: '1px solid var(--divider)',
                        textAlign: 'right',
                        userSelect: 'none',
                        width: 36,
                      }}>{row.index + 1}</td>
                      {cols.map((cell, i) => (
                        <td key={i} style={{
                          padding: '3px 6px',
                          borderRight: '1px solid var(--divider)',
                          background: cell?.mergeAnchor
                            ? 'color-mix(in oklch, var(--accent) 8%, transparent)'
                            : cell?.mergedFromAnchor
                              ? 'color-mix(in oklch, var(--accent) 4%, transparent)'
                              : 'transparent',
                          color: cell?.mergedFromAnchor ? 'var(--fg-muted)' : 'var(--fg)',
                          fontStyle: cell?.mergedFromAnchor ? 'italic' : 'normal',
                          whiteSpace: 'pre',
                          maxWidth: 280,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}>
                          {cell?.value ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      {doc.textBlocks.map((block, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>
            {block.heading ?? <span style={{ color: 'var(--fg-subtle)', fontWeight: 400 }}>(unheaded section)</span>}
            {block.page != null && (
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
                · page {block.page}
              </span>
            )}
            {block.headingDepth != null && (
              <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, marginLeft: 6 }}>
                · depth {block.headingDepth}
              </span>
            )}
          </div>
          <div style={{
            padding: 8,
            background: 'var(--bg)',
            border: '1px solid var(--divider)',
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            fontSize: 11.5,
            maxHeight: 240,
            overflow: 'auto',
          }}>
            {block.body || <span style={{ color: 'var(--fg-subtle)' }}>(empty)</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * "Inferred for pricing" section — one row per Layer-3 entity the
 * rate-card field mapper produced. Shows the LLM/heuristic's
 * reasoning + sourceQuote so the rep can see WHY each line is
 * priced, and offers an inline edit affordance for the most common
 * correction (LLM was conservative on scope value, e.g. picked
 * `1 apis` from `api_usage: Yes` when the doc actually has 23).
 *
 * Confidence < 0.6 entities are shown but visually de-emphasised —
 * they don't reach the priced quote until the rep raises confidence
 * by editing (overrides force confidence to 1.0).
 */
function InferredEntitiesSection({
  engagementId,
  fileId,
  entities,
  onChange,
}: {
  engagementId: string;
  fileId: string;
  entities: InferredEntity[];
  onChange(): void;
}) {
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Sort: high-confidence first (the priced ones), low-confidence at the
  // bottom (rep needs to bump them to make them count). Stable within
  // each bucket so the list doesn't jitter on every refresh.
  const sorted = [...entities].sort((a, b) => {
    const aHi = a.confidence >= 0.6 ? 1 : 0;
    const bHi = b.confidence >= 0.6 ? 1 : 0;
    if (aHi !== bHi) return bHi - aHi;
    return b.confidence - a.confidence;
  });
  const high = sorted.filter((e) => e.confidence >= 0.6).length;

  return (
    <div style={{
      marginTop: 10, marginBottom: 8, padding: 12,
      background: 'var(--bg-elev, var(--bg))',
      border: '1px solid var(--divider)',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon.Sparkles size={12} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--fg)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
            Inferred for pricing
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          {high} of {entities.length} will price
        </span>
      </div>

      {err && (
        <div style={{
          padding: 8, fontSize: 12, marginBottom: 8,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 6,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map((e) => (
          <InferredEntityRow
            key={e.serviceLineSlug}
            entity={e}
            editing={editingSlug === e.serviceLineSlug}
            busy={busySlug === e.serviceLineSlug}
            onEdit={() => setEditingSlug(e.serviceLineSlug)}
            onCancel={() => setEditingSlug(null)}
            onSave={async (patch) => {
              setBusySlug(e.serviceLineSlug);
              setErr(null);
              try {
                await extraction.overrideEntity(engagementId, fileId, e.serviceLineSlug, patch);
                setEditingSlug(null);
                onChange();
              } catch (caught) {
                setErr(describeError(caught));
              } finally {
                setBusySlug(null);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}

function InferredEntityRow({
  entity, editing, busy, onEdit, onCancel, onSave,
}: {
  entity: InferredEntity;
  editing: boolean;
  busy: boolean;
  onEdit(): void;
  onCancel(): void;
  onSave(patch: { scopeValue?: number; methodology?: string | null; customerType?: 'internal' | 'external' }): void;
}) {
  const [scope, setScope] = useState(String(entity.scopeValue));
  const [methodology, setMethodology] = useState(entity.methodology ?? '');
  const [customerType, setCustomerType] = useState<'internal' | 'external'>(entity.customerType);

  // Reset local state when entering edit mode so we always start
  // from the latest server state, not whatever was typed before.
  useEffect(() => {
    if (editing) {
      setScope(String(entity.scopeValue));
      setMethodology(entity.methodology ?? '');
      setCustomerType(entity.customerType);
    }
  }, [editing, entity.scopeValue, entity.methodology, entity.customerType]);

  const lowConfidence = entity.confidence < 0.6;
  const sourceLabel =
    entity.source === 'llm' ? 'LLM'
    : entity.source === 'heuristic' ? 'Heuristic'
    : 'Manual';
  const sourceTone =
    entity.source === 'manual' ? 'ok'
    : entity.source === 'llm' ? 'outline'
    : 'outline';

  return (
    <div style={{
      padding: 12,
      borderRadius: 8,
      background: lowConfidence ? 'var(--bg-sunk)' : 'var(--bg)',
      border: lowConfidence
        ? '1px dashed var(--divider)'
        : '1px solid var(--divider)',
      opacity: lowConfidence ? 0.78 : 1,
    }}>
      {!editing ? (
        <>
          {/* Top row: prominent scope number on the left, slug + meta on the
              right, edit button anchored to the right edge. The number is
              the bit the rep is most likely to override (LLM was conservative,
              real count is in the doc) so it gets the visual weight. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              minWidth: 56,
              padding: '6px 10px',
              borderRadius: 8,
              background: lowConfidence ? 'var(--bg)' : 'var(--accent-tint, var(--bg-sunk))',
              border: '1px solid var(--divider)',
              textAlign: 'center',
              flexShrink: 0,
            }}>
              <div style={{
                fontSize: 22, fontWeight: 700, lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
                color: lowConfidence ? 'var(--fg-muted)' : 'var(--fg)',
              }}>
                {entity.scopeValue}
              </div>
              <div style={{ fontSize: 9.5, color: 'var(--fg-muted)', marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                scope
              </div>
            </div>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                <code style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {entity.serviceLineSlug}
                </code>
                <span className={lowConfidence ? 'chip warn' : 'chip ok'} style={{ fontSize: 10 }}>
                  {Math.round(entity.confidence * 100)}%
                </span>
                <span className={`chip ${sourceTone}`} style={{ fontSize: 10 }} title={`Source: ${sourceLabel}`}>
                  {sourceLabel}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <span>methodology: <b style={{ color: 'var(--fg)' }}>{entity.methodology ?? '—'}</b></span>
                <span>customer: <b style={{ color: 'var(--fg)' }}>{entity.customerType}</b></span>
              </div>
            </div>

            <button onClick={onEdit} className="btn sm ghost" disabled={busy} style={{ flexShrink: 0 }}>
              <Icon.Edit size={11} /> Edit
            </button>
          </div>

          {lowConfidence && (
            <div style={{
              marginTop: 8, padding: '6px 8px', fontSize: 11,
              color: 'var(--warn, var(--fg-subtle))', fontStyle: 'italic',
              background: 'var(--warn-tint, var(--bg-sunk))', borderRadius: 6,
            }}>
              Below threshold — won&apos;t reach the priced quote unless you click Edit and raise it.
            </div>
          )}

          {(entity.reasoning || entity.sourceQuote) && (
            <details style={{ marginTop: 8 }}>
              <summary style={{
                cursor: 'pointer',
                fontSize: 11, color: 'var(--fg-muted)',
                userSelect: 'none', listStyle: 'none',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Icon.ChevronRight size={10} /> Why this value?
              </summary>
              {entity.reasoning && (
                <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 6, lineHeight: 1.5 }}>
                  {entity.reasoning}
                </div>
              )}
              {entity.sourceQuote && (
                <div style={{
                  marginTop: 6, padding: '4px 8px', fontSize: 11, color: 'var(--fg-subtle)', fontStyle: 'italic',
                  borderLeft: '2px solid var(--divider)', background: 'var(--bg-sunk)', borderRadius: '0 4px 4px 0',
                }}>
                  “{entity.sourceQuote}”
                </div>
              )}
            </details>
          )}
        </>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <label style={{ color: 'var(--fg-muted)' }}>scope value</label>
          <input
            className="input"
            type="number"
            min={0}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            style={{ height: 28, fontSize: 13, padding: '0 8px' }}
            disabled={busy}
            autoFocus
          />
          <label style={{ color: 'var(--fg-muted)' }}>methodology</label>
          <input
            className="input"
            value={methodology}
            onChange={(e) => setMethodology(e.target.value)}
            placeholder="leave blank for wildcard match"
            style={{ height: 28, fontSize: 13, padding: '0 8px', fontFamily: 'var(--font-mono)' }}
            disabled={busy}
          />
          <label style={{ color: 'var(--fg-muted)' }}>customer type</label>
          <select
            className="input"
            value={customerType}
            onChange={(e) => setCustomerType(e.target.value as 'internal' | 'external')}
            style={{ height: 28, fontSize: 13, padding: '0 8px' }}
            disabled={busy}
          >
            <option value="external">external</option>
            <option value="internal">internal</option>
          </select>
          <span />
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <button
              onClick={() => {
                const n = Number(scope);
                onSave({
                  ...(Number.isFinite(n) && n > 0 && n !== entity.scopeValue && { scopeValue: n }),
                  ...(methodology !== (entity.methodology ?? '') && { methodology: methodology.trim() || null }),
                  ...(customerType !== entity.customerType && { customerType }),
                });
              }}
              disabled={busy}
              className="btn sm accent"
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save + re-price</>}
            </button>
            <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Tiny inline chip showing the Layer-2 semantic category of a
 *  point. Colour-coded so the rep can scan the list and immediately
 *  spot misclassifications (e.g. an identity field flagged as
 *  scope). Categories are mutually exclusive — see backend
 *  `categorisePoint` for the rules. */
function CategoryChip({ category }: { category: PointCategory }) {
  const meta: Record<PointCategory, { bg: string; fg: string; label: string }> = {
    scope:        { bg: 'var(--cat-scope-bg)',      fg: 'var(--cat-scope-fg)',      label: 'scope' },
    methodology:  { bg: 'var(--cat-method-bg)',     fg: 'var(--cat-method-fg)',     label: 'method' },
    service_type: { bg: 'var(--cat-service-bg)',    fg: 'var(--cat-service-fg)',    label: 'service' },
    identity:     { bg: 'var(--cat-identity-bg)',   fg: 'var(--cat-identity-fg)',   label: 'identity' },
    environment:  { bg: 'var(--cat-env-bg)',        fg: 'var(--cat-env-fg)',        label: 'env' },
    compliance:   { bg: 'var(--cat-compliance-bg)', fg: 'var(--cat-compliance-fg)', label: 'compliance' },
    other:        { bg: 'var(--bg-sunk)',           fg: 'var(--fg-subtle)',         label: 'other' },
  };
  const m = meta[category];
  return (
    <span
      style={{
        display: 'inline-block',
        marginRight: 6,
        padding: '1px 6px',
        borderRadius: 4,
        fontSize: 10,
        fontFamily: 'var(--font-sans)',
        fontWeight: 500,
        background: m.bg,
        color: m.fg,
        verticalAlign: 1,
      }}
      title={`Layer 2 categorisation: ${category}`}
    >
      {m.label}
    </span>
  );
}

/** Per-sheet count strip — visible proof that the structured parser
 *  walked every worksheet rather than stopping at sheet 1 or 2. Rolls
 *  up the points array into `[sheetName, count]` pairs and renders
 *  them as small chips. Hidden when no point carries a `sheet` field
 *  (PDFs / single-sheet xlsx / LLM-extracted). */
function SheetBreakdown({ points }: { points: ExtractedPoint[] }) {
  const counts = new Map<string, number>();
  for (const p of points) {
    if (!p.sheet) continue;
    counts.set(p.sheet, (counts.get(p.sheet) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, marginBottom: 8,
      paddingBottom: 8, borderBottom: '1px solid var(--divider)',
    }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', alignSelf: 'center' }}>
        {counts.size} sheet{counts.size === 1 ? '' : 's'}:
      </span>
      {rows.map(([name, count]) => (
        <span
          key={name}
          className="chip outline"
          style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}
          title={`${count} point${count === 1 ? '' : 's'} from ${name}`}
        >
          {name} <b style={{ marginLeft: 4 }}>{count}</b>
        </span>
      ))}
    </div>
  );
}

function ExtractionStatusChip({ status, pointCount, retryAt, attempts }: {
  status: FileExtraction['status'];
  pointCount: number;
  retryAt: string | null;
  attempts: number;
}) {
  if (status === 'ready') {
    return <span className="chip ok"><Icon.Check size={10} /> {pointCount} extracted</span>;
  }
  if (status === 'processing') return <span className="chip warn"><Icon.Clock size={10} /> Processing…</span>;
  if (status === 'pending')    return <span className="chip warn"><Icon.Clock size={10} /> Queued</span>;
  if (status === 'retry_queued') return <RetryCountdownChip retryAt={retryAt} attempts={attempts} />;
  if (status === 'failed')     return <span className="chip danger"><Icon.X size={10} /> Failed</span>;
  if (status === 'skipped')    return <span className="chip outline"><Icon.Dot size={10} /> Skipped</span>;
  return <span className="chip outline">—</span>;
}

/** Live "retrying in 1m 23s…" chip. Updates every second; tells the
 *  rep the cron will pick this up so they don't have to baby-sit. */
function RetryCountdownChip({ retryAt, attempts }: { retryAt: string | null; attempts: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(handle);
  }, []);
  const remainingMs = retryAt ? new Date(retryAt).getTime() - now : 0;
  const label = remainingMs <= 0
    ? 'Retrying any moment…'
    : `Retrying in ${formatCountdown(remainingMs)}`;
  return (
    <span className="chip warn" title={`Attempt ${attempts}/5 · auto-retry`}>
      <Icon.Clock size={10} /> {label}
    </span>
  );
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}

function fileColor(contentType: string): string {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('pdf')) return 'oklch(0.55 0.18 25)';     // PDF: red-orange
  if (ct.includes('sheet') || ct.includes('excel')) return 'oklch(0.5 0.15 145)'; // xlsx: green
  if (ct.startsWith('text/') || ct.includes('csv')) return 'oklch(0.5 0.1 240)'; // text: blue
  return 'oklch(0.5 0.05 280)'; // unknown
}

/** Map the backend's short error codes to scannable inline text. The
 *  raw upstream provider error stays accessible via the row's title
 *  attribute; this is the at-a-glance summary. */
function humaniseExtractionError(raw: string): string {
  if (raw.startsWith('rate_limited')) return 'Rate-limited by AI — try gemini-1.5-flash or wait 60s';
  if (raw.startsWith('bad_model_name')) return 'Bad model name — fix in Settings → AI';
  if (raw.startsWith('auth_failed')) return 'AI auth failed — check API key';
  if (raw.startsWith('timeout')) return 'AI timed out — try Re-extract';
  if (raw.startsWith('unsupported_content_type')) return 'File type not supported (yet)';
  if (raw === 'manual_provider_unsupported') return 'Manual AI mode can\'t auto-extract';
  // Otherwise show the first 80 chars of whatever upstream said.
  return raw.length > 80 ? raw.slice(0, 80) + '…' : raw;
}

function fileGlyph(contentType: string, filename: string): string {
  const lower = `${contentType} ${filename}`.toLowerCase();
  if (lower.includes('pdf')) return 'PDF';
  if (lower.includes('xlsx') || lower.includes('sheet') || lower.includes('excel')) return 'XLSX';
  if (lower.includes('csv')) return 'CSV';
  if (lower.includes('text') || lower.endsWith('.txt') || lower.endsWith('.md')) return 'TXT';
  return 'DOC';
}

