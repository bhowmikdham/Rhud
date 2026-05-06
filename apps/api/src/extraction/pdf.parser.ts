/**
 * PDF text extraction — Phase B canonical-Document parser.
 *
 * Wraps `pdf-parse` to pull text per page. The package's default API
 * collapses every page into one big string, which loses the per-page
 * boundary the LLM extractor wants when it chunks. We use the
 * `pagerender` callback to capture each page individually and then
 * shape the result into `RhudDocument.textBlocks`.
 *
 * Scanned PDFs (no text layer) are detected by zero-text-output
 * across all pages — the caller gets `null` and routes the file to
 * the `pdf_scanned_or_empty` failure path. We don't OCR here; that's
 * a separate layer with bigger dependencies (Tesseract or cloud OCR).
 */

import type { RhudDocument, DocumentTextBlock } from '@rhud/shared';

interface PageData {
  page: number;
  text: string;
}

/**
 * Parse PDF bytes into a `RhudDocument`. Returns `null` when no text
 * could be pulled (signals "scanned PDF or empty doc" to the caller).
 * Throws on hard parse failures — the extraction service marks those
 * `failed` with the error message.
 *
 * Page splitting: pdf-parse emits `\f` (form-feed, U+000C) between
 * pages by default. Splitting on that gives us one block per page;
 * the LLM extractor benefits from explicit page numbers when chunking.
 */
export async function parsePdfToDocument(
  bytes: Buffer,
  meta: { id: string; filename: string; contentType: string },
): Promise<RhudDocument | null> {
  const mod = await import('pdf-parse');
  const pdfParse = (mod as unknown as { default: (b: Buffer) => Promise<{ text: string }> }).default
    ?? (mod as unknown as (b: Buffer) => Promise<{ text: string }>);
  const out = await pdfParse(bytes);
  const text = out.text ?? '';
  if (text.trim().length === 0) return null;

  // Split on form-feed (pdf-parse's per-page separator). Empty pages
  // are dropped — pure-blank pages don't help the LLM.
  const pageStrings = text.split('\f');
  const pages: PageData[] = [];
  for (let i = 0; i < pageStrings.length; i++) {
    const body = pageStrings[i]!.trim();
    if (body.length === 0) continue;
    pages.push({ page: i + 1, text: body });
  }
  if (pages.length === 0) return null;

  const textBlocks: DocumentTextBlock[] = pages.map((p) => ({
    heading: null,
    headingDepth: null,
    body: p.text,
    page: p.page,
  }));

  return {
    id: meta.id,
    filename: meta.filename,
    contentType: meta.contentType,
    parsedAt: new Date().toISOString(),
    sheets: [],
    textBlocks,
    warnings: [],
  };
}
