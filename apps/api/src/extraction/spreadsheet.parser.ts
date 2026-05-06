/**
 * Deterministic structured parser for client-uploaded spreadsheets.
 *
 * Most security questionnaires + scoping documents follow a clean
 * two-column shape:
 *
 *   ┌──────────────────────────┬───────────────────────────┐
 *   │ Name of the Company      │ Prophaze Technologies     │
 *   │ Contact Phone            │ 9495685326                │
 *   │ Number of Web Apps       │ 11                        │
 *   │ Hosting Environment      │ AWS                       │
 *   └──────────────────────────┴───────────────────────────┘
 *
 * Rather than dump that to an LLM (rate-limited, slow, costs tokens),
 * we scan the workbook structurally and pull `(label, value)` pairs
 * directly. The LLM remains the fallback for documents this parser
 * can't make sense of (free-form prose, complex tables, etc.).
 *
 * The output shape mirrors `ExtractedPoint` so the rest of the
 * extraction pipeline (auto-promotion, display) consumes it
 * unchanged.
 */

import ExcelJS from 'exceljs';
import type {
  RhudDocument,
  DocumentSheet,
  DocumentRow,
  DocumentCell,
} from '@rhud/shared';

export interface RawPoint {
  /** Snake_case key derived from the label — e.g. `name_of_company`. */
  key: string;
  /** The raw label as it appeared in the document. */
  label: string;
  /** The cell value, stringified + trimmed. */
  value: string;
  /** Sheet the pair was lifted from — surfaced in `sourceQuote`. */
  sheetName: string;
}

/** Workbook size cap. Rejects files that would dominate the API
 *  process's memory budget; the caller falls through to LLM-only. */
const MAX_ROWS = 10_000;
const MAX_COLS = 60;

/**
 * Try to extract Q/A pairs from a workbook buffer. Returns null when
 * the file looks structurally unparseable (not enough Q/A signal),
 * letting the caller fall through to LLM extraction.
 */
export async function parseSpreadsheetStructured(bytes: Buffer): Promise<RawPoint[] | null> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    return null; // not an xlsx, or corrupt
  }

  // Reject pathologically large workbooks before they OOM the
  // process. Over the cap → fall through to LLM-only path which
  // sees a chunk-trimmed text dump rather than the full grid.
  for (const sheet of wb.worksheets) {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLS) {
      return null;
    }
  }

  const points: RawPoint[] = [];
  const seenKeys = new Set<string>();

  for (const sheet of wb.worksheets) {
    // Pre-compute merge-cell expansion: for every merged range, the
    // header cell holds the value, the others are blank. We treat
    // the merged range as if every cell carried the header value, so
    // section headers that span 5 rows don't make the next 4 rows
    // look empty. P1-9 in majestic-whistling-whistle.md.
    const mergedFill = expandMergedCells(sheet);

    // Per-sheet detection: figure out which two columns are most
    // plausibly the label/value pair, then extract.
    const cols = detectQAColumns(sheet, mergedFill);
    if (!cols) continue;

    sheet.eachRow({ includeEmpty: false }, (row) => {
      const labelRaw = cellTextWithMerge(row, cols.label, mergedFill);
      const valueRaw = cellTextWithMerge(row, cols.value, mergedFill);
      if (!isPlausibleQAPair(labelRaw, valueRaw)) return;

      // Preserve newlines in cells (multi-line answers like bulleted
      // lists). Collapsing all whitespace to single spaces was
      // destroying structure in verbose answers. We only collapse
      // runs of spaces/tabs, not newlines.
      const label = compactSpaces(labelRaw).trim();
      const value = compactSpaces(valueRaw).trim();
      const key = makeKey(label);
      if (!key) return;

      // De-dupe across sheets when both label + value match — the
      // second sheet's repeat is almost always a copy/paste header.
      const dedup = `${key}::${value.toLowerCase()}`;
      if (seenKeys.has(dedup)) return;
      seenKeys.add(dedup);

      points.push({ key, label, value, sheetName: sheet.name });
    });
  }

  // Heuristic guardrail: if we got fewer than 3 points across the whole
  // workbook, the structural assumption probably doesn't hold and the
  // LLM should take over. This avoids returning a pseudo-success that
  // hides a richer extraction.
  if (points.length < 3) return null;
  return points;
}

/** Build a `(row, col) → string` map of merged-cell values. ExcelJS
 *  exposes only the top-left cell of each merged range; we copy that
 *  value to every cell the merge spans so the per-row read sees the
 *  same value for every row in the range. */
function expandMergedCells(sheet: ExcelJS.Worksheet): Map<string, string> {
  const out = new Map<string, string>();
  // Underlying merges live on `sheet.model.merges` (e.g. "A1:A5").
  // ExcelJS doesn't have a typed accessor, so we reach through the
  // model with a narrow cast.
  const merges = ((sheet as unknown as { model?: { merges?: string[] } }).model?.merges) ?? [];
  for (const range of merges) {
    const m = range.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!m) continue;
    const c1 = colLetterToIdx(m[1]!);
    const r1 = Number(m[2]);
    const c2 = colLetterToIdx(m[3]!);
    const r2 = Number(m[4]);
    const headerVal = cellText(sheet.getRow(r1).getCell(c1));
    if (!headerVal) continue;
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        out.set(`${r}:${c}`, headerVal);
      }
    }
  }
  return out;
}

function colLetterToIdx(letter: string): number {
  let n = 0;
  for (const ch of letter.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

function cellTextWithMerge(
  row: ExcelJS.Row,
  col: number,
  mergedFill: Map<string, string>,
): string {
  const direct = cellText(row.getCell(col));
  if (direct) return direct;
  return mergedFill.get(`${row.number}:${col}`) ?? '';
}

/** Collapse runs of spaces/tabs to a single space WITHOUT touching
 *  newlines. Preserves bulleted-list / paragraph structure. */
function compactSpaces(s: string): string {
  return s.replace(/[ \t]+/g, ' ').replace(/\n +/g, '\n');
}

/**
 * Pick the most likely (label, value) column pair for a sheet.
 *
 * Heuristic: walk the first ~30 rows, count rows where column N looks
 * like a label and column N+1 looks like a value. Pick the (N, N+1)
 * pair with the highest hit rate, scoring at least 4 hits.
 *
 * Most questionnaires put labels in column A and answers in column B,
 * but some have a leading "section" or "#" column that shifts
 * everything by one. Trying both A→B and B→C handles that without
 * special-casing.
 */
function detectQAColumns(
  sheet: ExcelJS.Worksheet,
  mergedFill: Map<string, string>,
): { label: number; value: number } | null {
  const candidates: Array<{ label: number; value: number }> = [
    { label: 1, value: 2 }, // A → B (most common)
    { label: 2, value: 3 }, // B → C (numbered/sectioned questionnaires)
    { label: 1, value: 3 }, // A → C (when B holds a category code)
  ];

  let best: { label: number; value: number; hits: number } | null = null;
  const sampleRows = Math.min(sheet.rowCount, 40);

  for (const cand of candidates) {
    let hits = 0;
    for (let r = 1; r <= sampleRows; r++) {
      const row = sheet.getRow(r);
      const l = cellTextWithMerge(row, cand.label, mergedFill);
      const v = cellTextWithMerge(row, cand.value, mergedFill);
      if (isPlausibleQAPair(l, v)) hits += 1;
    }
    if (!best || hits > best.hits) {
      best = { ...cand, hits };
    }
  }
  // Tightened threshold from 4 → 7. A genuine Q/A questionnaire trips
  // ≥10 hits in the first 40 rows easily; the lower 4-hit bar was
  // over-matching wider tables that happen to have a few label-shaped
  // cells in the first column. P1-9.
  if (!best || best.hits < 7) return null;
  return { label: best.label, value: best.value };
}

function isPlausibleQAPair(label: string, value: string): boolean {
  if (!label || !value) return false;
  const l = label.trim();
  const v = value.trim();
  if (l.length < 3 || l.length > 200) return false;
  if (v.length < 1 || v.length > 1000) return false;
  // Pure-numeric labels are usually row indices, not questions.
  if (/^\d+$/.test(l)) return false;
  // Label === value is almost always a header row (label repeats
  // in both columns).
  if (l.toLowerCase() === v.toLowerCase()) return false;
  // The label should look "labely" — at least two letters, ideally
  // resembling a phrase. Skip cells that are just punctuation / junk.
  if (!/[a-z]{2}/i.test(l)) return false;
  return true;
}

/**
 * Pull a printable string out of a cell regardless of how exceljs
 * encoded it (rich text, hyperlink, formula, primitive).
 */
function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // Rich text + hyperlink + formula cells expose `.text` or `.result`.
  const obj = v as unknown as { text?: unknown; result?: unknown; richText?: Array<{ text: string }> };
  if (Array.isArray(obj.richText)) {
    return obj.richText.map((r) => r.text).join('');
  }
  if (typeof obj.text === 'string') return obj.text;
  if (obj.result != null) return String(obj.result);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Last-ditch — exceljs error cells, etc.
  try {
    return String(v);
  } catch {
    return '';
  }
}

/**
 * Snake_case the label so the resulting `key` is usable as a stable
 * identifier across re-extractions. Drops most punctuation, collapses
 * whitespace, caps at 60 chars.
 */
function makeKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

// ── Fuzzy label → template-question matching ─────────────────────────

/**
 * Score how well a structured label matches a template question.
 * Token Jaccard similarity — straightforward, good enough for the
 * common case where the questionnaire's wording is a paraphrase of
 * the template's wording. Above ~0.4 is a confident match.
 */
export function scoreLabelMatch(label: string, question: string): number {
  const a = tokenise(label);
  const b = tokenise(question);
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersect / union;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'is', 'are', 'and', 'or', 'to', 'in', 'on', 'at',
  'for', 'with', 'by', 'as', 'be', 'do', 'you', 'your', 'this', 'that',
  'no', 'yes', 'please', 'enter', 'specify', 'list', 'name',
]);

function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Phase B — canonical Document model integration.
//
// `parseSpreadsheetToDocument` reads the same xlsx bytes as
// `parseSpreadsheetStructured`, but writes a uniform `RhudDocument`
// instead of producing `RawPoint[]` directly. The Document captures
// MORE than the structural Q/A extraction — it preserves every cell
// (with merge anchors), the sheet-shape detection result, and parser
// warnings — so consumers other than Q/A extraction (LLM enrichment,
// the admin-review UI, future PDF-table parsing) read from a single
// shape rather than reaching back into ExcelJS internals.
//
// `documentToRawPoints` then runs the existing Q/A heuristic against
// the Document and emits `RawPoint[]`. Splitting the parse and the
// extraction is what enables the cleaning-layer architecture the user
// asked for: Layer 1 = bytes → Document; Layer 2 = Document → points.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Parse xlsx bytes into a canonical `RhudDocument`. Returns null when
 * the bytes don't load as xlsx OR when any sheet exceeds the size cap
 * (callers fall through to LLM-only extraction). All sheets that DO
 * load are included — even ones with no Q/A signal — so consumers can
 * surface them in the admin-review UI.
 *
 * `id`, `filename`, `contentType`, `parsedAt` are filled in by the
 * caller (extraction.service has the engagement-file row context).
 */
export async function parseSpreadsheetToDocument(
  bytes: Buffer,
  meta: { id: string; filename: string; contentType: string },
): Promise<RhudDocument | null> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  } catch {
    return null; // not an xlsx, or corrupt
  }

  // Same cap as `parseSpreadsheetStructured` — protect the API process
  // from OOM on adversarial 50MB workbooks. Caller falls through to
  // LLM-only.
  for (const sheet of wb.worksheets) {
    if (sheet.rowCount > MAX_ROWS || sheet.columnCount > MAX_COLS) {
      return null;
    }
  }

  const warnings: string[] = [];
  const docSheets: DocumentSheet[] = [];

  for (let sheetIdx = 0; sheetIdx < wb.worksheets.length; sheetIdx++) {
    const sheet = wb.worksheets[sheetIdx]!;
    const mergedFill = expandMergedCells(sheet);
    const mergeAnchors = collectMergeAnchors(sheet);

    const docRows: DocumentRow[] = [];
    let maxCol = 0;

    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      const cells: DocumentCell[] = [];
      // Walk every column up to the sheet's columnCount so blank middle
      // columns become explicit gaps in `cells` (not silently dropped).
      const cap = Math.max(sheet.columnCount, row.actualCellCount);
      for (let c = 1; c <= cap; c++) {
        const direct = cellText(row.getCell(c));
        const merged = mergedFill.get(`${rowNumber}:${c}`);
        const value = direct || merged || '';
        if (!value) continue; // skip blank cells — keep payload small
        const cell: DocumentCell = { column: c - 1, value };
        // Tag merge metadata so downstream consumers (LLM context
        // builder, admin UI) can render anchors specially.
        const isAnchor = mergeAnchors.has(`${rowNumber}:${c}`);
        if (isAnchor) cell.mergeAnchor = true;
        if (!direct && merged) cell.mergedFromAnchor = true;
        cells.push(cell);
        if (c > maxCol) maxCol = c;
      }
      if (cells.length > 0) {
        docRows.push({ index: rowNumber - 1, cells });
      }
    });

    // Detect sheet shape against the same heuristic the Q/A extractor
    // uses — but as INFORMATION, not a gate. The downstream extractor
    // makes its own decision.
    const detectedShape = detectSheetShape(sheet, mergedFill);

    docSheets.push({
      name: sheet.name,
      index: sheetIdx,
      rowCount: docRows.length,
      columnCount: maxCol,
      rows: docRows,
      detectedShape,
    });
  }

  return {
    id: meta.id,
    filename: meta.filename,
    contentType: meta.contentType,
    parsedAt: new Date().toISOString(),
    sheets: docSheets,
    textBlocks: [],
    warnings,
  };
}

/**
 * Pure conversion: given a parsed `RhudDocument` whose sheets carry
 * tabular data, run the same Q/A heuristic `parseSpreadsheetStructured`
 * uses and emit `RawPoint[]`. Returns null when no sheet has enough
 * Q/A signal — callers fall through to LLM-only extraction.
 */
export function documentToRawPoints(doc: RhudDocument): RawPoint[] | null {
  if (doc.sheets.length === 0) return null;

  const points: RawPoint[] = [];
  const seenKeys = new Set<string>();

  for (const sheet of doc.sheets) {
    // Build a (row,col) → value lookup for the cell-pair detection.
    const cellLookup = new Map<string, string>();
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        cellLookup.set(`${row.index}:${cell.column}`, cell.value);
      }
    }
    const cols = detectQAColumnsFromDocument(sheet, cellLookup);
    if (!cols) continue;

    for (const row of sheet.rows) {
      const labelRaw = cellLookup.get(`${row.index}:${cols.label}`) ?? '';
      const valueRaw = cellLookup.get(`${row.index}:${cols.value}`) ?? '';
      if (!isPlausibleQAPair(labelRaw, valueRaw)) continue;
      const label = compactSpaces(labelRaw).trim();
      const value = compactSpaces(valueRaw).trim();
      const key = makeKey(label);
      if (!key) continue;
      const dedup = `${key}::${value.toLowerCase()}`;
      if (seenKeys.has(dedup)) continue;
      seenKeys.add(dedup);
      points.push({ key, label, value, sheetName: sheet.name });
    }
  }

  if (points.length < 3) return null;
  return points;
}

/**
 * Render a `RhudDocument` into a structure-aware text dump suitable
 * for LLM consumption. Used by the chunked LLM extractor when the
 * structural Q/A path returns null. Format example:
 *
 *   ## Sheet: Web App Questionnaire (Q/A)
 *   Row 1: Name | Staging Dashboard
 *   Row 2: How many dynamic pages | 29
 *   ...
 *
 *   ## Section: 3. Application Inventory  (page 5)
 *   <text body>
 *
 * The headings and sheet names give the LLM context it loses when
 * we just dump raw text — "this row is in the Web App Questionnaire"
 * helps a lot for `appId` grouping.
 */
export function documentToLlmText(doc: RhudDocument): string {
  const blocks: string[] = [];
  blocks.push(`# Document: ${doc.filename}`);

  for (const sheet of doc.sheets) {
    const shapeNote = sheet.detectedShape === 'qa' ? ' (Q/A)' : '';
    blocks.push(`\n## Sheet: ${sheet.name}${shapeNote}`);
    for (const row of sheet.rows) {
      // Render row as pipe-delimited cells in column order.
      const cellsByCol = new Map(row.cells.map((c) => [c.column, c.value]));
      const maxCol = Math.max(...row.cells.map((c) => c.column), -1);
      const cellStrs: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        cellStrs.push(cellsByCol.get(c) ?? '');
      }
      blocks.push(`Row ${row.index + 1}: ${cellStrs.join(' | ')}`);
    }
  }

  for (const tb of doc.textBlocks) {
    // Markdown heading depth: depth=1 → `## `, depth=2 → `### `, etc.
    // (We start at `## ` because `# ` is reserved for the document
    // title at the very top.)
    const hashes = '#'.repeat((tb.headingDepth ?? 1) + 1);
    const heading = tb.heading ? `${hashes} ${tb.heading}` : '## Section';
    const pageTag = tb.page != null ? ` (page ${tb.page})` : '';
    blocks.push(`\n${heading}${pageTag}\n${tb.body}`);
  }

  return blocks.join('\n');
}

// Helpers used only by the Document path.

function collectMergeAnchors(sheet: ExcelJS.Worksheet): Set<string> {
  const out = new Set<string>();
  const merges = ((sheet as unknown as { model?: { merges?: string[] } }).model?.merges) ?? [];
  for (const range of merges) {
    const m = range.match(/^([A-Z]+)(\d+):/);
    if (!m) continue;
    const c1 = colLetterToIdx(m[1]!);
    const r1 = Number(m[2]);
    out.add(`${r1}:${c1}`);
  }
  return out;
}

function detectSheetShape(
  sheet: ExcelJS.Worksheet,
  mergedFill: Map<string, string>,
): DocumentSheet['detectedShape'] {
  // Same QA detector — promotes the heuristic result to a tag the
  // Document carries forward.
  if (detectQAColumns(sheet, mergedFill)) return 'qa';
  return null;
}

function detectQAColumnsFromDocument(
  sheet: DocumentSheet,
  lookup: Map<string, string>,
): { label: number; value: number } | null {
  const candidates: Array<{ label: number; value: number }> = [
    { label: 0, value: 1 },
    { label: 1, value: 2 },
    { label: 0, value: 2 },
  ];
  let best: { label: number; value: number; hits: number } | null = null;
  const sampleRows = Math.min(sheet.rows.length, 40);
  for (const cand of candidates) {
    let hits = 0;
    for (let i = 0; i < sampleRows; i++) {
      const row = sheet.rows[i]!;
      const l = lookup.get(`${row.index}:${cand.label}`) ?? '';
      const v = lookup.get(`${row.index}:${cand.value}`) ?? '';
      if (isPlausibleQAPair(l, v)) hits += 1;
    }
    if (!best || hits > best.hits) {
      best = { ...cand, hits };
    }
  }
  if (!best || best.hits < 7) return null;
  return { label: best.label, value: best.value };
}
