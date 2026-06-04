'use client';

/**
 * Sheet-based import modal — paste from Excel/Numbers/Google Sheets (or
 * upload a CSV/TSV) and the app shows the parsed grid. Per-column dropdowns
 * map each spreadsheet column to a node field (Question / Help text /
 * Placeholder / Type / Options / Required); per-row controls toggle
 * include + section. The submit payload uses the same import endpoint as
 * the plain-text mode — this is purely a smarter front door for the same
 * /templates/:id/nodes/import route.
 *
 * Auto-detection is intentionally cheap-and-cheerful: first non-empty
 * column → Question, a column whose values are all known node types →
 * Type, a column whose cells contain `;` → Options, the next text column
 * → Help text. Users can always override.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ImportNodeInput, NodeOption, NodeType } from '@/lib/api';
import { Icon } from '@/components/icon';

const NODE_TYPES_LIST: readonly NodeType[] = [
  'section',
  'single_select',
  'multi_select',
  'short_text',
  'long_text',
  'number',
  'file_upload',
];
const NODE_TYPES_SET: ReadonlySet<string> = new Set(NODE_TYPES_LIST);

const ROLES = ['skip', 'question', 'helpText', 'placeholder', 'nodeType', 'options', 'required'] as const;
type ColumnRole = (typeof ROLES)[number];

const ROLE_LABELS: Record<ColumnRole, string> = {
  skip: '— skip —',
  question: 'Question',
  helpText: 'Help text',
  placeholder: 'Placeholder',
  nodeType: 'Type',
  options: 'Options',
  required: 'Required',
};

const ROLE_HINTS: Partial<Record<ColumnRole, string>> = {
  options: 'separate values with ; or ,',
  required: 'true / false / yes / no',
  nodeType: NODE_TYPES_LIST.join(' · '),
};

interface Sheet {
  rows: string[][];
  cols: number;
}

interface RowConfig {
  include: boolean;
  asSection: boolean;
}

export interface SheetImportModalProps {
  onCancel(): void;
  onImport(args: { replace: boolean; nodes: ImportNodeInput[] }): Promise<void>;
  busy: boolean;
}

// Sample mirrors the IT-infra style intake we lifted from the questionnaire
// the client sent: section heading, mixed inputs, and a select with
// semicolon-separated options.
const SAMPLE = [
  'Engagement Details\tTell us about the project\tsection\t',
  'Client name\t\tshort_text\t',
  'Industry\tPick one\tsingle_select\tFinancial services;Healthcare;Retail',
  'Approximate budget?\tIn USD\tnumber\t',
  'Briefly describe your current security stack\tTools and gaps\tlong_text\t',
].join('\n');

interface LoadedWorkbook {
  fileName: string;
  sheets: Array<{ name: string; rows: string[][] }>;
}

export function SheetImportModal({ onCancel, onImport, busy }: SheetImportModalProps) {
  const [text, setText] = useState(SAMPLE);
  const [workbook, setWorkbook] = useState<LoadedWorkbook | null>(null);
  const [activeSheetName, setActiveSheetName] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [replace, setReplace] = useState(false);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // The grid's source of truth: either the active workbook sheet, or the
  // textarea contents parsed as TSV/CSV. We don't try to round-trip a
  // workbook through the textarea — embedded newlines + tabs would
  // garble it on the way back out.
  const sheet: Sheet = useMemo(() => {
    if (workbook && activeSheetName) {
      const found = workbook.sheets.find((s) => s.name === activeSheetName);
      if (found) return normaliseRows(found.rows);
    }
    return parseSheet(text);
  }, [text, workbook, activeSheetName]);

  const [roles, setRoles] = useState<ColumnRole[]>(() => autoDetectRoles(sheet));
  const [rowConfig, setRowConfig] = useState<RowConfig[]>(() => autoDetectRows(sheet));

  // Re-derive defaults when the sheet shape changes (column count or row
  // count). This keeps mapping in sync with edits without clobbering the
  // user's choices on a no-op rerender.
  useEffect(() => {
    setRoles(autoDetectRoles(sheet));
    setRowConfig(autoDetectRows(sheet));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sheet.cols, sheet.rows.length]);

  const previewNodes = useMemo(() => buildNodes(sheet, roles, rowConfig), [sheet, roles, rowConfig]);
  const hasQuestionCol = roles.includes('question');

  // Move focus into the dialog on open so keyboard + screen-reader users
  // land inside it.
  useEffect(() => {
    const focusTarget =
      dialogRef.current?.querySelector<HTMLElement>('textarea, input, button') ?? dialogRef.current;
    focusTarget?.focus();
  }, []);

  // Escape cancels, unless an import is in flight (mirrors the disabled
  // Cancel button).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) { e.stopPropagation(); onCancel(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [busy, onCancel]);

  function setRole(col: number, r: ColumnRole) {
    setRoles((curr) => {
      const next = [...curr];
      next[col] = r;
      // 'question' and 'nodeType' must be unique. If the user picks one of
      // these for a different column, clear the previous owner so the grid
      // never has two "Question" columns silently fighting.
      if (r === 'question' || r === 'nodeType') {
        for (let i = 0; i < next.length; i++) {
          if (i !== col && next[i] === r) next[i] = 'skip';
        }
      }
      return next;
    });
  }

  function patchRow(idx: number, patch: Partial<RowConfig>) {
    setRowConfig((curr) => curr.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function setAllRows(include: boolean) {
    setRowConfig((curr) => curr.map((r) => ({ ...r, include })));
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setParseErr(null);

    const lower = file.name.toLowerCase();
    const isXlsx =
      lower.endsWith('.xlsx') ||
      lower.endsWith('.xls') ||
      lower.endsWith('.xlsm') ||
      file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      file.type === 'application/vnd.ms-excel';

    if (!isXlsx) {
      const txt = await file.text();
      setText(txt);
      setWorkbook(null);
      setActiveSheetName(null);
      return;
    }

    // Dynamic-import SheetJS so the ~1.5MB lib only ships when an admin
    // actually uploads a workbook — keeps the editor's first paint snappy.
    setLoadingFile(true);
    try {
      const xlsx = await import('xlsx');
      const buffer = await file.arrayBuffer();
      // Numbers .xlsx archives ship a Data/ image dir at the top of the
      // zip — SheetJS will crash trying to parse them as OOXML, and the
      // raw error is opaque ("Unsupported file"). Detect this up-front
      // and tell the user how to get unstuck.
      if (looksLikeAppleNumbers(buffer)) {
        throw new Error(
          'This looks like an Apple Numbers file (saved with a .xlsx extension). ' +
          'Open it in Numbers and use File → Export To → Excel, or copy the cells ' +
          'and paste them into the textarea above.',
        );
      }
      const wb = xlsx.read(buffer, { type: 'array' });
      const sheets = wb.SheetNames.map((name) => {
        const ws = wb.Sheets[name];
        if (!ws) return { name, rows: [] as string[][] };
        // header:1 + raw:false gives us a string-of-strings matrix that
        // matches our parser's existing shape. defval:'' fills sparse cells.
        const matrix = xlsx.utils.sheet_to_json<unknown[]>(ws, {
          header: 1,
          raw: false,
          defval: '',
          blankrows: false,
        });
        const rows = matrix.map((row) => row.map((cell) => String(cell ?? '')));
        return { name, rows };
      });

      const firstNonEmpty =
        sheets.find((s) => s.rows.some((r) => r.some((c) => c.trim() !== ''))) ?? sheets[0];
      setWorkbook({ fileName: file.name, sheets });
      setActiveSheetName(firstNonEmpty?.name ?? null);
    } catch (err) {
      setParseErr(`Couldn't parse "${file.name}". ${err instanceof Error ? err.message : ''}`.trim());
    } finally {
      setLoadingFile(false);
    }
  }

  function clearFile() {
    setWorkbook(null);
    setActiveSheetName(null);
    setParseErr(null);
  }

  function submit() {
    setParseErr(null);
    if (!hasQuestionCol) {
      setParseErr('Map one column to “Question” first — that\'s where each node\'s prompt comes from.');
      return;
    }
    if (previewNodes.length === 0) {
      setParseErr('No rows are checked. Tick at least one row to import.');
      return;
    }
    void onImport({ replace, nodes: previewNodes });
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 'var(--z-modal)',
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label="Import questionnaire from a sheet"
        tabIndex={-1}
        style={{
          width: '100%',
          maxWidth: 1080,
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Import questionnaire from a sheet</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Paste from Excel · Numbers · Google Sheets, or upload a CSV / TSV.
            </div>
          </div>
          <button onClick={onCancel} className="btn sm ghost"><Icon.X size={11} /></button>
        </header>

        <div style={{ padding: '14px 18px', display: 'grid', gridTemplateColumns: '1fr', gap: 14, overflow: 'auto' }}>
          {workbook ? (
            <div className="card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg-sunk)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <Icon.FileText size={14} style={{ color: 'var(--fg-subtle)', flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{workbook.fileName}</span>
                  <span className="chip mono" style={{ padding: '0 6px' }}>{workbook.sheets.length} sheet{workbook.sheets.length === 1 ? '' : 's'}</span>
                </div>
                <button onClick={clearFile} className="btn sm ghost"><Icon.X size={11} /> Clear</button>
              </div>
              {workbook.sheets.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Sheet:</span>
                  {workbook.sheets.map((s) => {
                    const empty = s.rows.every((r) => r.every((c) => c.trim() === ''));
                    return (
                      <button
                        key={s.name}
                        onClick={() => setActiveSheetName(s.name)}
                        className={'btn sm ' + (activeSheetName === s.name ? 'accent' : 'ghost')}
                        disabled={empty}
                        title={empty ? 'sheet is empty' : undefined}
                        style={empty ? { opacity: 0.5 } : undefined}
                      >
                        {s.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'flex-start' }}>
              <textarea
                className="input mono"
                rows={6}
                placeholder="Paste rows here. Tab between columns — that's what Excel & Sheets put on your clipboard."
                value={text}
                onChange={(e) => setText(e.target.value)}
                style={{ fontSize: 12, lineHeight: 1.45 }}
              />
              <label className="btn sm" style={{ whiteSpace: 'nowrap', cursor: loadingFile ? 'wait' : 'pointer' }}>
                {loadingFile ? <span className="spin" /> : <><Icon.Paperclip size={11} /> Upload file</>}
                <input
                  type="file"
                  accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                  onChange={handleFile}
                  disabled={loadingFile}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          )}

          {sheet.rows.length === 0 ? (
            <div className="empty" style={{ padding: 24, fontSize: 12.5 }}>
              Paste rows above and we&apos;ll preview them as a grid.
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--fg-muted)' }}>
                  {sheet.rows.length} row(s), {sheet.cols} column(s) detected.
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn sm ghost" onClick={() => setAllRows(true)}>Select all rows</button>
                  <button className="btn sm ghost" onClick={() => setAllRows(false)}>Clear</button>
                </div>
              </div>

              <SheetGrid
                sheet={sheet}
                roles={roles}
                onRoleChange={setRole}
                rowConfig={rowConfig}
                onRowChange={patchRow}
              />

              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                Tip: tick the <Icon.Hash size={10} /> on a row to import it as a section heading.
                If a “Type” column maps to a node type, it overrides the auto-guess.
              </div>
            </>
          )}

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            Replace existing nodes (clears the current tree first)
          </label>

          {parseErr && (
            <div style={{
              padding: 10,
              background: 'var(--danger-tint)',
              color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
              fontSize: 12,
            }}>{parseErr}</div>
          )}
        </div>

        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
            {hasQuestionCol
              ? <>Will import <b style={{ color: 'var(--fg)' }}>{previewNodes.length}</b> node(s).</>
              : <span style={{ color: 'var(--warn)' }}>Map one column to “Question” to continue.</span>
            }
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onCancel} className="btn sm ghost" disabled={busy}>Cancel</button>
            <button
              onClick={submit}
              disabled={busy || !hasQuestionCol || previewNodes.length === 0}
              className="btn sm accent"
            >
              {busy ? <span className="spin" /> : <><Icon.Send size={11} /> Import {previewNodes.length}</>}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ── Grid ────────────────────────────────────────────────────────────────────

function SheetGrid({
  sheet,
  roles,
  onRoleChange,
  rowConfig,
  onRowChange,
}: {
  sheet: Sheet;
  roles: ColumnRole[];
  onRoleChange(col: number, r: ColumnRole): void;
  rowConfig: RowConfig[];
  onRowChange(idx: number, patch: Partial<RowConfig>): void;
}) {
  return (
    <div style={{
      border: '1px solid var(--divider)',
      borderRadius: 'var(--radius)',
      overflow: 'auto',
      maxHeight: '46vh',
      background: 'var(--bg-sunk)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'inherit' }}>
        <colgroup>
          <col style={{ width: 96 }} />
          {Array.from({ length: sheet.cols }).map((_, i) => <col key={i} />)}
        </colgroup>
        <thead>
          <tr style={{ position: 'sticky', top: 0, zIndex: 'var(--z-sticky)', background: 'var(--bg)' }}>
            <th style={cellHead(true)}>row</th>
            {Array.from({ length: sheet.cols }).map((_, c) => (
              <th key={c} style={cellHead(false)}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-subtle)', letterSpacing: '0.06em' }}>
                    {colLetter(c)}
                  </span>
                  <select
                    className="input"
                    value={roles[c] ?? 'skip'}
                    onChange={(e) => onRoleChange(c, e.target.value as ColumnRole)}
                    style={{ height: 24, padding: '0 6px', fontSize: 11.5, fontWeight: 500, width: '100%', minWidth: 110 }}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  {ROLE_HINTS[roles[c] ?? 'skip'] && (
                    <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>
                      {ROLE_HINTS[roles[c] ?? 'skip']}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, r) => {
            const cfg = rowConfig[r] ?? { include: true, asSection: false };
            return (
              <tr key={r} style={{ background: cfg.include ? undefined : 'var(--bg-sunk)' }}>
                <td style={{ ...cellBody(), borderRight: '1px solid var(--divider)', background: 'var(--bg)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={cfg.include}
                      onChange={(e) => onRowChange(r, { include: e.target.checked })}
                      title="Include this row"
                    />
                    <button
                      type="button"
                      onClick={() => onRowChange(r, { asSection: !cfg.asSection })}
                      title={cfg.asSection ? 'Stop treating as section' : 'Mark this row as a section heading'}
                      className="btn sm ghost"
                      style={{
                        height: 22,
                        padding: '0 6px',
                        background: cfg.asSection ? 'var(--accent-tint)' : 'transparent',
                        color: cfg.asSection ? 'var(--accent)' : 'var(--fg-subtle)',
                      }}
                    >
                      <Icon.Hash size={11} />
                    </button>
                    <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>{r + 1}</span>
                  </div>
                </td>
                {Array.from({ length: sheet.cols }).map((_, c) => {
                  const val = row[c] ?? '';
                  const role = roles[c] ?? 'skip';
                  const dim = role === 'skip' || !cfg.include;
                  return (
                    <td
                      key={c}
                      style={{
                        ...cellBody(),
                        color: dim ? 'var(--fg-subtle)' : 'var(--fg)',
                        opacity: dim ? 0.7 : 1,
                        fontWeight: role === 'question' ? 500 : 400,
                        background: role === 'question' ? 'var(--accent-tint)' :
                                    role === 'nodeType' ? 'color-mix(in oklch, var(--accent-tint) 50%, transparent)' :
                                    undefined,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        maxWidth: 280,
                      }}
                      title={val}
                    >
                      {val || <span style={{ color: 'var(--fg-subtle)' }}>—</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Style helpers ───────────────────────────────────────────────────────────

function cellHead(sticky: boolean): React.CSSProperties {
  return {
    padding: '8px 10px',
    borderBottom: '1px solid var(--divider)',
    textAlign: 'left',
    verticalAlign: 'top',
    fontWeight: 500,
    background: 'var(--bg)',
    position: sticky ? 'sticky' : undefined,
    left: sticky ? 0 : undefined,
    zIndex: sticky ? 2 : undefined,
  };
}
function cellBody(): React.CSSProperties {
  return {
    padding: '6px 10px',
    borderBottom: '1px solid var(--divider)',
    verticalAlign: 'middle',
  };
}

// ── Parsers + helpers (pure) ────────────────────────────────────────────────

function colLetter(idx: number): string {
  // 0 → A, 1 → B, …, 25 → Z, 26 → AA. Same convention spreadsheet apps use.
  let s = '';
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

export function normaliseRows(rows: string[][]): Sheet {
  // Trim trailing blank rows but keep interior gaps so the user can still
  // see + uncheck them. Also pad to a uniform column width so the grid
  // doesn't render ragged.
  const trimmed = [...rows];
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]!.every((c) => (c ?? '').trim() === '')) {
    trimmed.pop();
  }
  const cols = trimmed.reduce((m, r) => Math.max(m, r.length), 0);
  const padded = trimmed.map((r) => (r.length === cols ? r.map((c) => c ?? '') : [...r.map((c) => c ?? ''), ...Array(cols - r.length).fill('')]));
  return { rows: padded, cols };
}

export function parseSheet(raw: string): Sheet {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return { rows: [], cols: 0 };

  const lines = text.split('\n');
  // Drop trailing empty lines but keep interior blanks (the user might
  // intentionally have spacers; we'll just leave them un-included).
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();

  // Pick separator: prefer tabs if any line has one (Excel/Sheets default
  // on copy), else CSV.
  const hasTab = lines.some((l) => l.includes('\t'));
  const rows = lines.map((line) => (hasTab ? line.split('\t') : parseCsvLine(line)));
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  // Pad short rows so the grid isn't ragged.
  const padded = rows.map((r) => (r.length === cols ? r : [...r, ...Array(cols - r.length).fill('')]));
  return { rows: padded, cols };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') q = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function autoDetectRoles(sheet: Sheet): ColumnRole[] {
  const out: ColumnRole[] = Array.from({ length: sheet.cols }, () => 'skip');
  if (sheet.cols === 0) return out;

  // Sample up to the first 8 non-empty rows for heuristics — enough signal
  // without scanning huge pastes.
  const sample = sheet.rows.filter((r) => r.some((c) => c.trim() !== '')).slice(0, 8);
  const cellsAt = (c: number) => sample.map((r) => (r[c] ?? '').trim());

  // Type column: where most cells (or all non-empty) match a known node type.
  let typeCol = -1;
  let typeScore = 0;
  for (let c = 0; c < sheet.cols; c++) {
    const cells = cellsAt(c).filter((v) => v.length > 0);
    if (cells.length === 0) continue;
    const matches = cells.filter((v) => NODE_TYPES_SET.has(v.toLowerCase())).length;
    if (matches > typeScore && matches >= Math.max(1, Math.floor(cells.length / 2))) {
      typeScore = matches;
      typeCol = c;
    }
  }

  // Options column: contains a `;` somewhere — this is how spreadsheet
  // authors usually pack a list into a single cell.
  let optsCol = -1;
  for (let c = 0; c < sheet.cols; c++) {
    if (c === typeCol) continue;
    if (cellsAt(c).some((v) => v.includes(';'))) { optsCol = c; break; }
  }

  // Required column: cells are obviously boolean-ish.
  let reqCol = -1;
  for (let c = 0; c < sheet.cols; c++) {
    if (c === typeCol || c === optsCol) continue;
    const cells = cellsAt(c).filter((v) => v.length > 0);
    if (cells.length === 0) continue;
    if (cells.every((v) => /^(true|false|yes|no|y|n|0|1|required|optional)$/i.test(v))) {
      reqCol = c;
      break;
    }
  }

  // Question column: first un-claimed column with non-empty content.
  let questionCol = -1;
  for (let c = 0; c < sheet.cols; c++) {
    if (c === typeCol || c === optsCol || c === reqCol) continue;
    if (cellsAt(c).some((v) => v.length > 0)) { questionCol = c; break; }
  }

  // Help text: next un-claimed text column after question.
  let helpCol = -1;
  for (let c = 0; c < sheet.cols; c++) {
    if (c === typeCol || c === optsCol || c === reqCol || c === questionCol) continue;
    if (cellsAt(c).some((v) => v.length > 0)) { helpCol = c; break; }
  }

  if (questionCol >= 0) out[questionCol] = 'question';
  if (helpCol >= 0) out[helpCol] = 'helpText';
  if (typeCol >= 0) out[typeCol] = 'nodeType';
  if (optsCol >= 0) out[optsCol] = 'options';
  if (reqCol >= 0) out[reqCol] = 'required';
  return out;
}

function autoDetectRows(sheet: Sheet): RowConfig[] {
  // If row 1 is obviously a label header ("Question", "Type", "Options",
  // etc.) auto-uncheck it so the admin doesn't import a node titled
  // "Question". Cheap heuristic: ≥2 cells match a known header word.
  const HEADER_WORDS = new Set([
    'question', 'help', 'help text', 'helptext', 'placeholder', 'type',
    'node type', 'options', 'option', 'choices', 'required', 'optional',
    'description', 'notes',
  ]);
  const looksLikeHeader = (row: string[] | undefined): boolean => {
    if (!row) return false;
    let hits = 0;
    for (const cell of row) {
      if (HEADER_WORDS.has(cell.trim().toLowerCase())) hits++;
    }
    return hits >= 2;
  };
  const skipFirst = looksLikeHeader(sheet.rows[0]);
  return sheet.rows.map((row, i) => ({
    include: row.some((c) => c.trim() !== '') && !(i === 0 && skipFirst),
    asSection: false,
  }));
}

interface RoleCells {
  question: string;
  helpText: string;
  placeholder: string;
  nodeType: string;
  options: string;
  required: string;
}

function collectByRole(row: string[], roles: ColumnRole[]): RoleCells {
  const out: RoleCells = {
    question: '', helpText: '', placeholder: '', nodeType: '', options: '', required: '',
  };
  for (let c = 0; c < row.length; c++) {
    const role = roles[c];
    if (!role || role === 'skip') continue;
    out[role] = (row[c] ?? '').trim();
  }
  return out;
}

export function buildNodes(sheet: Sheet, roles: ColumnRole[], rowConfig: RowConfig[]): ImportNodeInput[] {
  const out: ImportNodeInput[] = [];
  for (let r = 0; r < sheet.rows.length; r++) {
    const cfg = rowConfig[r];
    if (!cfg?.include) continue;

    const cells = collectByRole(sheet.rows[r]!, roles);
    const question = cells.question;
    if (!question) continue;

    const explicitType = cells.nodeType.toLowerCase();
    const nodeType: NodeType = cfg.asSection
      ? 'section'
      : NODE_TYPES_SET.has(explicitType)
        ? (explicitType as NodeType)
        : guessNodeType(question);

    const node: ImportNodeInput = { question, nodeType };
    if (cells.helpText) node.helpText = cells.helpText;
    if (cells.placeholder) node.placeholder = cells.placeholder;
    if (cells.required) {
      const v = cells.required.toLowerCase();
      const skipMarkers = ['false', 'no', 'n', '0', 'optional'];
      node.required = !skipMarkers.includes(v);
    }
    if ((nodeType === 'single_select' || nodeType === 'multi_select') && cells.options) {
      const sep = cells.options.includes(';') ? ';' : ',';
      const labels = cells.options.split(sep).map((s) => s.trim()).filter(Boolean);
      const options: NodeOption[] = labels.map((label) => ({ value: slug(label), label }));
      if (options.length > 0) node.options = options;
    }
    out.push(node);
  }
  return out;
}

function guessNodeType(q: string): NodeType {
  const lower = q.toLowerCase();
  if (q.length > 90 || /\b(describe|details|notes|explain|comments?)\b/.test(lower)) return 'long_text';
  if (/\b(number|count|how many|amount|size|budget|quantity)\b/.test(lower)) return 'number';
  if (/\b(upload|attach|file|document)\b/.test(lower)) return 'file_upload';
  return 'short_text';
}

// Apple Numbers exports keep a Data/ directory at the top of the zip with
// .iwa-derived assets (preset image fills etc.) — a real .xlsx never has
// that path. Sniffing the first KiB is enough to tell them apart without
// pulling in a zip parser.
function looksLikeAppleNumbers(buffer: ArrayBuffer): boolean {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096));
  // Look for the "Data/" prefix or .iwa filename inside the central
  // directory. ASCII-decode the head bytes; gzip/deflate compression
  // wouldn't apply to filenames in a zip header.
  const decoder = new TextDecoder('latin1');
  const probe = decoder.decode(head);
  return probe.includes('Data/') && (probe.includes('.iwa') || probe.includes('PresetImage'));
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'opt';
}
