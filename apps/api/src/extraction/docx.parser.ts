/**
 * Word `.docx` text extraction.
 *
 * Wraps `mammoth` to convert `.docx` bytes → plain text. We only use
 * `extractRawText` (not `convertToHtml`) because the LLM extractor
 * downstream wants prose, not formatted HTML — markup tokens would
 * waste budget without adding signal for security-questionnaire scoping.
 *
 * `.doc` (the legacy binary format) is NOT supported; mammoth is for
 * the OOXML `.docx` only. The orchestrator returns null for `.doc` and
 * the file ends in `extraction_status='skipped'` with a clear reason.
 */

import * as mammoth from 'mammoth';
import type { RhudDocument, DocumentTextBlock } from '@rhud/shared';

export async function extractDocxText(bytes: Buffer): Promise<string> {
  // mammoth's NodeJS API takes either a path or a buffer. We pass the
  // buffer so the caller stays in control of S3 fetch + temp-file
  // policy. Errors bubble up so the extraction service can mark the
  // file `failed` with the underlying message.
  const result = await mammoth.extractRawText({ buffer: bytes });
  return result.value ?? '';
}

/**
 * Phase B canonical-Document parser for `.docx`. Splits the raw text
 * into heading-bounded text blocks so the LLM extractor sees section
 * structure (which it loses when we pass a single text blob).
 *
 * Heading detection is text-shape based: lines that are short, non-
 * trailing-punctuation, and ALL-CAPS / Title Case are treated as
 * headings. This is a heuristic — mammoth does expose richer docx
 * metadata via convertToHtml, but text-based detection keeps the
 * payload small and avoids HTML token noise in the LLM prompt.
 */
export async function parseDocxToDocument(
  bytes: Buffer,
  meta: { id: string; filename: string; contentType: string },
): Promise<RhudDocument> {
  const result = await mammoth.extractRawText({ buffer: bytes });
  const raw = result.value ?? '';
  const blocks = splitIntoTextBlocks(raw);
  return {
    id: meta.id,
    filename: meta.filename,
    contentType: meta.contentType,
    parsedAt: new Date().toISOString(),
    sheets: [],
    textBlocks: blocks,
    warnings: result.messages.filter((m) => m.type === 'warning').map((m) => m.message),
  };
}

/**
 * Split raw text into heading-bounded blocks. A line is treated as a
 * heading when:
 *   - It's between 3 and 80 chars long.
 *   - It contains no trailing sentence punctuation (`.` `:` `,`).
 *   - At least one of: ALL-CAPS / Title Case starts every word /
 *     starts with a number followed by `.` or `)` (numbered headings).
 *
 * Conservative — false negatives (heading missed → folded into prior
 * block) are better than false positives (sentence treated as heading,
 * splitting a paragraph mid-thought).
 *
 * Exported for unit testing — ESM bindings make it hard to mock the
 * mammoth wrapper directly, so we test the pure splitter against
 * synthetic raw text.
 */
export function splitIntoTextBlocks(raw: string): DocumentTextBlock[] {
  if (!raw.trim()) return [];
  const lines = raw.split(/\r?\n/);
  const blocks: DocumentTextBlock[] = [];
  let currentHeading: string | null = null;
  let currentDepth: number | null = null;
  let bodyLines: string[] = [];

  const flush = () => {
    if (bodyLines.length === 0 && currentHeading == null) return;
    const body = bodyLines.join('\n').trim();
    if (body.length === 0 && currentHeading == null) return;
    blocks.push({
      heading: currentHeading,
      headingDepth: currentDepth,
      body,
      page: null,
    });
    bodyLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      bodyLines.push(''); // preserve paragraph breaks
      continue;
    }
    const heading = detectHeading(trimmed);
    if (heading) {
      flush();
      currentHeading = heading.text;
      currentDepth = heading.depth;
    } else {
      bodyLines.push(trimmed);
    }
  }
  flush();
  return blocks;
}

interface DetectedHeading {
  text: string;
  depth: number;
}

function detectHeading(line: string): DetectedHeading | null {
  if (line.length < 3 || line.length > 80) return null;
  if (/[.:,;]$/.test(line)) return null;

  // Numbered headings — two patterns:
  //   1. "1.2 Foo" / "1.2.3 Foo" — multi-segment dotted number, trailing
  //      punct optional. Depth = number of dots + 1.
  //   2. "1. Foo" / "3) Baz"     — single number, trailing `.` or `)`
  //      REQUIRED so we don't match plain sentences like "5 things…".
  const multiSegment = line.match(/^(\d+(?:\.\d+)+)[.)]?\s+.+$/);
  if (multiSegment) {
    const depth = (multiSegment[1]!.match(/\./g) ?? []).length + 1;
    return { text: line, depth };
  }
  const singleNumber = line.match(/^\d+[.)]\s+.+$/);
  if (singleNumber) {
    return { text: line, depth: 1 };
  }

  // ALL-CAPS line ≥3 chars, ≥1 letter.
  if (/^[A-Z0-9 \-_/&]+$/.test(line) && /[A-Z]/.test(line)) {
    return { text: line, depth: 1 };
  }

  // Title Case: every word capitalised, ≤8 words.
  const words = line.split(/\s+/);
  if (words.length <= 8 && words.every((w) => /^[A-Z][a-zA-Z0-9]*$/.test(w))) {
    return { text: line, depth: 2 };
  }

  return null;
}
