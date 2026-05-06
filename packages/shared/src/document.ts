/**
 * Canonical Document model — Layer 1.5 of the extraction pipeline.
 *
 * Different input formats (xlsx, PDF, docx, CSV, …) produce wildly
 * different raw shapes today: xlsx has rows/columns/merged cells, PDF
 * has free-form text with implicit headings, docx has paragraphs with
 * inline styles. Layer-2 (extracted points) collapses everything into
 * Q/A pairs but loses structure along the way — the LLM mapper can't
 * tell which points came from the same sheet, which were beneath a
 * particular heading, or whether a 30-row table is one logical block.
 *
 * The Document model is the bridge: every parser writes into this
 * shape, every Layer-2 extractor reads from it. The shape is
 * deliberately minimal — sheets (for tabular sources) + textBlocks
 * (for prose sources) + provenance metadata — so it stays useful
 * without becoming an "everything bag".
 *
 * Pure data — no methods. Producers are file-format parsers; consumers
 * are extractors and the Layer-3 mapper enrichment step.
 */

/**
 * Top-level Document — one per uploaded file. Sheets and textBlocks
 * coexist: an xlsx with embedded notes / comments can populate both;
 * a PDF that contains tables we OCR'd into structured rows can also
 * populate both.
 */
export interface RhudDocument {
  /** Stable id for cross-referencing — typically the engagement_files row id. */
  id: string;
  filename: string;
  /** MIME type from upload, or sniffed if missing. */
  contentType: string;
  /** When the parser ran. ISO-8601 string for JSON-friendliness. */
  parsedAt: string;
  /** Tabular regions — one entry per sheet (xlsx) or per logical
   *  table block (PDF tables, structured CSVs). Empty for prose-only
   *  sources. */
  sheets: DocumentSheet[];
  /** Prose / free-form text regions — one entry per logical block.
   *  PDFs and docx populate this; xlsx leaves it empty unless the
   *  workbook has a notes sheet. */
  textBlocks: DocumentTextBlock[];
  /** Parser warnings surfaced to the admin-review UI. e.g. "row 47
   *  had no recognisable scope unit", "merged cell expanded across
   *  4 rows". Empty when parsing was fully clean. */
  warnings: string[];
}

/**
 * One tabular region. For xlsx: one Sheet maps to one workbook sheet.
 * For CSVs: one Sheet (filename used as `name`). For PDFs with tables:
 * one Sheet per detected table region.
 */
export interface DocumentSheet {
  /** Sheet/table name as written in the source ("Web App Questionnaire"). */
  name: string;
  /** Zero-based ordinal among sheets in the same Document — preserves
   *  workbook order so downstream summaries can render sheets in the
   *  user's authoring order. */
  index: number;
  /** Logical row count after pruning blank trailing rows. Used by
   *  bound checks and by enrichment heuristics that gate on table size. */
  rowCount: number;
  /** Maximum non-blank column count across all rows. */
  columnCount: number;
  /** Rows in document order. Each row's cells are indexed by their
   *  column position — gaps (blank cells) carry undefined for that
   *  column. Heads / sub-headers are NOT split out — consumers
   *  classify rows themselves. */
  rows: DocumentRow[];
  /** Detected by the parser when applicable: "this sheet looks like a
   *  Q/A questionnaire" / "looks like an asset inventory" / "looks
   *  like a pricing table". Heuristic — used to bias downstream
   *  extraction; never a hard guarantee. Null when no shape detected. */
  detectedShape: 'qa' | 'asset_list' | 'pricing_table' | null;
}

export interface DocumentRow {
  /** Zero-based row index in the sheet (post-blank-trim). */
  index: number;
  cells: DocumentCell[];
}

export interface DocumentCell {
  /** Zero-based column index. */
  column: number;
  /** Cell value as text. Booleans / numbers / dates are stringified by
   *  the parser to keep the consumer side simple. Empty string when
   *  the cell is blank. */
  value: string;
  /** True when the cell is the start of a horizontal/vertical merge —
   *  the value is repeated into masked cells by the parser, but
   *  consumers may want to know the merge anchor. */
  mergeAnchor?: boolean;
  /** True when this cell was originally part of a merged region but
   *  isn't the anchor (parser back-filled the value from the anchor). */
  mergedFromAnchor?: boolean;
}

/**
 * One free-form text region. For PDFs: one block per page (or per
 * detected section break). For docx: one block per heading-bounded
 * run.
 */
export interface DocumentTextBlock {
  /** Heading attached to this block, if the parser detected one
   *  ("3. Application Inventory"). Null when the block has no heading. */
  heading: string | null;
  /** Heading depth — 1 = top-level, 2 = sub-section, etc. Null when
   *  no heading. */
  headingDepth: number | null;
  /** Block body text. Newlines preserved; multiple paragraphs joined
   *  with `\n\n`. */
  body: string;
  /** Page number for PDF sources. Null for docx / non-paginated. */
  page: number | null;
}
