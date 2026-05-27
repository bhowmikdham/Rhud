/**
 * Pure helpers used by the Outlook-add-in preview flow.
 *
 * Two responsibilities:
 *
 *   1. **Forwarded-sender disambiguation.** The Outlook `From:` header
 *      points at whoever forwarded the email last — which is usually
 *      a teammate inside the tenant, not the real prospect. Walk the
 *      body's forwarded headers to find the first external sender.
 *
 *   2. **Structured-field extraction.** Inbound RFPs are very often
 *      questionnaires laid out as HTML tables ("1 | Application Name |
 *      MESA"). Pull those rows out so the panel can show them as a
 *      key/value preview instead of a wall of text-coerced gibberish.
 *
 * Pure functions, no DB, no Nest deps — straight unit tests.
 */

import { parse as parseHtml, HTMLElement } from 'node-html-parser';

export interface ParsedSender {
  email: string;
  name?: string;
}

export interface StructuredField {
  label: string;
  value: string;
}

/** Hard cap on how many rows we return from `extractStructuredFields`.
 *  A pathological email with thousands of `<table>` rows could otherwise
 *  freeze the add-in's `innerHTML` render and bloat the API response.
 *  100 is well past the largest RFP questionnaires we've seen (~40 rows).
 *  Truncation is silent — the add-in's "Detected fields (N)" chip will
 *  just stop counting at 100; nothing breaks. */
export const MAX_STRUCTURED_FIELDS = 100;

/**
 * If the apparent sender is internal (same address or same domain as
 * the signed-in tenant user), walk the forwarded thread headers in the
 * plain-text body to find the first external sender.
 *
 * Returns null when no resolution is needed (sender already external)
 * or when the body has no extractable forwarded headers.
 *
 * Why text and not HTML: the `From:` lines Outlook injects on forward
 * land in both representations, but the text form is regex-stable across
 * Outlook web / desktop / mobile. The HTML form differs per host (Word
 * mso classes on desktop, plain divs on web).
 */
export function disambiguateForwardedSender(args: {
  sender: { email: string; name?: string | undefined };
  tenantUserEmail: string;
  bodyText: string;
}): ParsedSender | null {
  const tenantUserEmail = args.tenantUserEmail.toLowerCase();
  const tenantDomain = domainOf(tenantUserEmail);
  const sender = args.sender.email.toLowerCase();

  const isInternal =
    sender === tenantUserEmail ||
    (tenantDomain !== null && domainOf(sender) === tenantDomain);
  if (!isInternal) return null;

  // Walk every "From:" header line in the body, top to bottom. In an
  // Outlook forwarded chain the first one is the outermost forwarder
  // (closest to current), the last is the original sender. We want the
  // *first non-internal* one — that's the closest external party, the
  // real prospect.
  //
  // Only accept a `From:` line as a real forwarded header if it's
  // followed within the next ~5 non-empty lines by one of `To:`,
  // `Date:`, `Sent:`, or `Subject:`. Bare `From:` lines in quoted
  // blocks, code snippets, and body prose ("From now on we'll do…")
  // would otherwise produce false-positive senders.
  const fromLineRe = /^[ \t]*From:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = fromLineRe.exec(args.bodyText)) !== null) {
    if (!looksLikeForwardedHeaderBlock(args.bodyText, m.index)) continue;
    const parsed = parseFromHeader(m[1]!);
    if (!parsed) continue;
    const d = domainOf(parsed.email.toLowerCase());
    if (d !== null && d !== tenantDomain) {
      return parsed;
    }
  }
  return null;
}

/**
 * Confirm the `From:` line at byteOffset is part of an Outlook-style
 * forwarded header block by looking for any of To:/Date:/Sent:/Subject:
 * within the next few non-empty lines. Without this guard the disambiguator
 * latches onto bare `From:` mentions in body prose.
 */
function looksLikeForwardedHeaderBlock(body: string, byteOffset: number): boolean {
  // Look at the next ~600 chars (typically covers 5-6 lines including
  // long display names). Outlook's forwarded block fits well within this;
  // anything beyond is almost certainly not a real header block.
  const window = body.slice(byteOffset, byteOffset + 600);
  return /^[ \t]*(To|Date|Sent|Subject)\s*:/im.test(window);
}

/**
 * Pull structured key/value pairs out of HTML tables in the body.
 *
 * Heuristics for what counts as a "real" data table (vs. layout / signature
 * / spacer):
 *   - Skip tables nested deeper than 2 levels — these are almost always
 *     Outlook's layout containers wrapping the actual message body.
 *   - Skip tables whose rows are entirely images / nbsp / empty — image
 *     spacer scaffolding that Outlook web emits.
 *   - Skip tables that contribute fewer than 2 data rows (after header
 *     row filtering). One-row "tables" are usually signature cards or
 *     stray inline KV pairs that pollute the panel.
 *
 * Row-shape heuristics:
 *   - 2-column rows  → [label, value]
 *   - 3-column rows  → [serial, label, value]   (e.g. "1 | Foo | Bar")
 *   - >3 columns     → first non-empty as label, last non-empty as value
 *   - Header rows skipped via two rules: any `<th>` in the row, OR the
 *     first cell matches a header token ("S. No.", "Particulars", etc.)
 *   - Repeated labels deduped (questionnaires often re-state a section
 *     header across multiple tables)
 *   - Empty values are kept (`"—"` placeholder produced client-side) so
 *     the rep sees which fields the prospect left blank.
 *
 * Output is hard-capped at {@link MAX_STRUCTURED_FIELDS} rows.
 */
export function extractStructuredFields(bodyHtml: string): StructuredField[] {
  if (!bodyHtml || bodyHtml.length === 0) return [];

  let root: HTMLElement;
  try {
    root = parseHtml(bodyHtml);
  } catch {
    return [];
  }

  const tables = root.querySelectorAll('table');
  const out: StructuredField[] = [];
  const seen = new Set<string>();

  for (const tbl of tables) {
    if (out.length >= MAX_STRUCTURED_FIELDS) break;

    // Skip tables that contain other tables — those are layout wrappers
    // (Outlook desktop nests the actual message in 2-3 layers of these).
    // Only LEAF tables hold real data. This also fixes the descendant-
    // querySelector pitfall: tbl.querySelectorAll('tr') would otherwise
    // pull rows from every nested table too, scrambling the outer
    // table's cell counts.
    if (tbl.querySelectorAll('table').length > 0) continue;

    // Belt-and-braces: skip anything past depth 2 in case a leaf table
    // ever ends up deeply buried (signature footers occasionally do).
    if (tableNestingDepth(tbl) > 2) continue;

    // Skip image-only tables. These are spacers / decorative blocks
    // (calendar invites, marketing-style HTML), never data.
    if (isImageOnlyTable(tbl)) continue;

    const rows = tbl.querySelectorAll('tr');
    if (rows.length === 0) continue;

    // Collect candidate rows from this table first so we can apply the
    // "needs ≥2 data rows" guard. Single-row "tables" are almost always
    // signature cards or stray KV pairs masquerading as questionnaires.
    const candidates: StructuredField[] = [];
    for (const row of rows) {
      if (rowHasHeaderCells(row)) continue;
      const cells = row
        .querySelectorAll('td, th')
        .map((c) => normaliseCell(c.text));
      if (cells.length === 0 || cells.every((c) => !c)) continue;

      let label: string;
      let value: string;
      if (cells.length === 2) {
        label = cells[0]!;
        value = cells[1]!;
      } else if (cells.length === 3) {
        label = cells[1]!;
        value = cells[2]!;
      } else if (cells.length > 3) {
        const first = cells.find((c) => c.length > 0) ?? '';
        const last = [...cells].reverse().find((c) => c.length > 0) ?? '';
        if (first === last) continue;
        label = first;
        value = last;
      } else {
        continue;
      }
      if (!label) continue;
      // Header detection #2: the label cell itself matches a known
      // header token (catches plain-`<td>` header rows where the first
      // rule's `<th>` check doesn't fire).
      if (isHeaderLabel(label)) continue;

      candidates.push({ label, value });
    }
    if (candidates.length < 2) continue;

    for (const c of candidates) {
      if (out.length >= MAX_STRUCTURED_FIELDS) break;
      const key = c.label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}

/** Count how many `<table>` ancestors this table has. Real data tables
 *  live near the top; depth ≥3 is almost always Outlook layout scaffolding. */
function tableNestingDepth(el: HTMLElement): number {
  let depth = 0;
  let cur: HTMLElement | null = el.parentNode as HTMLElement | null;
  while (cur) {
    if (cur.tagName === 'TABLE') depth++;
    cur = cur.parentNode as HTMLElement | null;
  }
  return depth;
}

/** True when every non-empty cell in the table contains only image
 *  elements (or only whitespace). Image-spacer tables are decorative,
 *  never data. */
function isImageOnlyTable(tbl: HTMLElement): boolean {
  const cells = tbl.querySelectorAll('td, th');
  if (cells.length === 0) return false;
  let sawAnyNonEmpty = false;
  for (const cell of cells) {
    const text = normaliseCell(cell.text);
    const hasImg = cell.querySelectorAll('img').length > 0;
    if (text.length > 0) {
      sawAnyNonEmpty = true;
      // Cell has real text → not image-only.
      return false;
    }
    if (hasImg) sawAnyNonEmpty = true;
  }
  return sawAnyNonEmpty;
}

/** Treat the row as a header row if any of its cells is a `<th>`.
 *  Catches the common case where the questionnaire's first row is
 *  `<tr><th>S. No.</th><th>Parameter</th><th>Description</th></tr>`. */
function rowHasHeaderCells(row: HTMLElement): boolean {
  return row.querySelectorAll('th').length > 0;
}

// Header-cell vocabulary. Lowercased, whitespace-normalised before
// comparison. The list is intentionally biased toward "column-header"
// shapes that show up in the FIRST cell of an RFP questionnaire row.
const HEADER_TOKENS = new Set([
  // Serial-number column headers.
  's. no.',
  's. no',
  's no',
  's.no.',
  's.no',
  'sl. no.',
  'sl. no',
  'sl no',
  'sno',
  'sr. no.',
  'sr. no',
  'sr no',
  'no.',
  '#',
  // Generic label-column headers.
  'parameter',
  'parameters',
  'particular',
  'particulars',
  'description',
  'value',
  'field',
  'fields',
  'item',
  'items',
  'aspect',
  'aspects',
  'q',
  'q.',
  'question',
  'questions',
  'remarks',
  'remark',
  'notes',
  'note',
  'criteria',
  'attribute',
  'attributes',
]);

function isHeaderLabel(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return HEADER_TOKENS.has(t);
}

function normaliseCell(text: string): string {
  // Replace non-breaking spaces (U+00A0, HTML's &nbsp;). Outlook
  // table cells almost always contain them; without this they survive
  // the \s+ collapse and print as sticky-nbsp blocks in the panel.
  return text.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Pull an email (and optional display name) out of one `From:` header
 * line. Accepts the shapes Outlook actually emits when forwarding:
 *
 *   "Yash Gupta" <yash.gupta@techspire.co.in>
 *   Yash Gupta <yash.gupta@techspire.co.in>
 *   yash.gupta@techspire.co.in <yash.gupta@techspire.co.in>
 *   yash.gupta@techspire.co.in
 *
 * Returns null if no `@`-shaped token is present.
 */
function parseFromHeader(line: string): ParsedSender | null {
  const angle = line.match(/^(.*?)<\s*([^>\s]+@[^>\s]+)\s*>/);
  if (angle) {
    const rawName = angle[1]!.replace(/["']/g, '').trim();
    const email = angle[2]!.trim();
    if (!email.includes('@')) return null;
    // Suppress redundant "email@x <email@x>" pattern — that's not a
    // human display name, just a courtesy duplicate Outlook injects.
    const name = rawName && rawName.toLowerCase() !== email.toLowerCase()
      ? rawName
      : undefined;
    return name ? { email, name } : { email };
  }
  const bare = line.match(/([^\s<>;,]+@[^\s<>;,]+)/);
  if (bare) {
    return { email: bare[1]!.trim() };
  }
  return null;
}
