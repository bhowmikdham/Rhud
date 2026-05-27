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
  const fromLineRe = /^[ \t]*From:\s*(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = fromLineRe.exec(args.bodyText)) !== null) {
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
 * Pull structured key/value pairs out of HTML tables in the body.
 *
 * Heuristics:
 *   - 2-column rows  → [label, value]
 *   - 3-column rows  → [serial, label, value]   (e.g. "1 | Foo | Bar")
 *   - >3 columns     → first non-empty as label, last non-empty as value
 *   - Header rows (cells like "S. No.", "Parameter", "Description") skipped
 *   - Repeated labels deduped (questionnaires often re-state a section
 *     header across multiple tables)
 *   - Empty values are kept (`"—"` placeholder produced client-side) so
 *     the rep sees which fields the prospect left blank
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
    // Skip tables that look like layout wrappers — single row, single
    // cell, or no rows at all. These show up in Outlook's signature
    // blocks and forwarded-header containers.
    const rows = tbl.querySelectorAll('tr');
    if (rows.length === 0) continue;

    for (const row of rows) {
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
      if (isHeaderLabel(label) && isHeaderLabel(value)) continue;

      const key = label.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ label, value });
    }
  }
  return out;
}

const HEADER_TOKENS = new Set([
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
  'sr no',
  'parameter',
  'parameters',
  'description',
  'value',
  'field',
  'fields',
]);

function isHeaderLabel(s: string): boolean {
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return HEADER_TOKENS.has(t);
}

function normaliseCell(text: string): string {
  // Replace non-breaking spaces (U+00A0, HTML's &nbsp;). Outlook
  // table cells almost always contain them; without this they survive
  // the \s+ collapse and print as sticky-nbsp blocks in the panel.
  return text.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
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
