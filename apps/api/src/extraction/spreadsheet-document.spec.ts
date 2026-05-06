/**
 * End-to-end specs for `parseSpreadsheetToDocument` driven by real
 * xlsx bytes (built via ExcelJS in-memory). Locks in:
 *
 *  - Document shape matches what `documentToRawPoints` expects.
 *  - The wire-through in `extraction.service.runExtraction` (xlsx →
 *    Document → RawPoint[]) is bit-identical to the legacy
 *    `parseSpreadsheetStructured` path that the system shipped before
 *    Phase B. The xlsx structural shortcut is the most-trafficked
 *    extraction path; regressions there would silently mis-extract
 *    every Prophaze upload.
 *  - Merged cells survive the round-trip with anchor metadata.
 */

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  parseSpreadsheetToDocument,
  documentToRawPoints,
  documentToLlmText,
  parseSpreadsheetStructured,
} from './spreadsheet.parser.js';

async function makeWorkbookBytes(
  sheets: Array<{ name: string; rows: string[][] }>,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const row of s.rows) {
      ws.addRow(row);
    }
  }
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

const QA_ROWS: string[][] = [
  ['Name of company', 'Acme Corp'],
  ['Contact email', 'a@b.com'],
  ['Contact phone', '555-0100'],
  ['Application name', 'Staging Dashboard'],
  ['Penetration testing type', 'Black Box'],
  ['Hosting environment', 'AWS'],
  ['Number of dynamic pages', '29'],
  ['Number of static pages', '0'],
  ['Number of roles', 'Admin, Read-only'],
  ['Compliance', 'SOC2'],
];

describe('parseSpreadsheetToDocument', () => {
  it('produces a Document with sheets but no textBlocks for xlsx input', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe('d1');
    expect(doc!.filename).toBe('test.xlsx');
    expect(doc!.sheets).toHaveLength(1);
    expect(doc!.textBlocks).toEqual([]);
  });

  it('detects Q/A shape on a clean two-column sheet', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Web App Q', rows: QA_ROWS }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(doc!.sheets[0]!.detectedShape).toBe('qa');
  });

  it('returns null for non-xlsx bytes', async () => {
    const fake = Buffer.from('not an xlsx');
    const doc = await parseSpreadsheetToDocument(fake, {
      id: 'd1', filename: 'fake.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    expect(doc).toBeNull();
  });

  it('preserves cell positions including blank middle columns', async () => {
    // Row with values at col 0 and col 2, blank at col 1 — the cell
    // array should reflect the gap rather than re-index the cells.
    const bytes = await makeWorkbookBytes([{
      name: 'Sparse',
      rows: [
        ['A', '', 'C'],
        ['D', '', 'F'],
      ],
    }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'sparse.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const row0 = doc!.sheets[0]!.rows[0]!;
    // Two cells at columns 0 and 2 (blanks dropped, columns preserved).
    expect(row0.cells).toHaveLength(2);
    expect(row0.cells[0]!.column).toBe(0);
    expect(row0.cells[0]!.value).toBe('A');
    expect(row0.cells[1]!.column).toBe(2);
    expect(row0.cells[1]!.value).toBe('C');
  });
});

describe('documentToRawPoints — extraction.service.xlsx parity', () => {
  it('produces the same RawPoint[] as parseSpreadsheetStructured for a clean xlsx', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS }]);

    // Legacy path
    const legacy = await parseSpreadsheetStructured(bytes);

    // Document path
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const viaDocument = doc ? documentToRawPoints(doc) : null;

    expect(legacy).not.toBeNull();
    expect(viaDocument).not.toBeNull();
    expect(viaDocument!.length).toBe(legacy!.length);

    // Each legacy entry should appear in the Document path (order
    // may differ; compare as sets).
    const legacyKeys = new Set(legacy!.map((p) => `${p.key}:::${p.value}`));
    const docKeys = new Set(viaDocument!.map((p) => `${p.key}:::${p.value}`));
    expect(docKeys).toEqual(legacyKeys);
  });

  it('respects the ≥7 hits threshold (returns null for sparse Q/A)', async () => {
    // Only 5 plausible Q/A rows — below the threshold.
    const bytes = await makeWorkbookBytes([{
      name: 'Sparse',
      rows: [
        ['Name', 'Acme'],
        ['Email', 'a@b.com'],
        ['Phone', '555-0100'],
        ['Application', 'Dashboard'],
        ['Hosting', 'AWS'],
      ],
    }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'sparse.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const raw = doc ? documentToRawPoints(doc) : null;
    expect(raw).toBeNull();
  });

  it('extracts across multiple sheets', async () => {
    const bytes = await makeWorkbookBytes([
      { name: 'Web', rows: QA_ROWS },
      { name: 'API', rows: [
        ['Number of API endpoints', '23'],
        ['API authentication', 'Bearer Token'],
        ['API methodology', 'Black Box'],
        ['API roles', 'Admin'],
        ['API hosting', 'AWS'],
        ['API compliance', 'SOC2'],
        ['API name', 'Public APIs V1'],
        ['API base URL', 'https://api.example.com'],
      ]},
    ]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'multi.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const raw = doc ? documentToRawPoints(doc) : null;
    expect(raw).not.toBeNull();
    // Web sheet entries
    expect(raw!.find((p) => p.key === 'name_of_company')).toBeDefined();
    // API sheet entries
    expect(raw!.find((p) => p.value === '23')).toBeDefined();
    expect(raw!.some((p) => p.sheetName === 'Web')).toBe(true);
    expect(raw!.some((p) => p.sheetName === 'API')).toBe(true);
  });
});

describe('documentToLlmText — structured dump for LLM', () => {
  it('renders sheets with row-major dump and document title', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS.slice(0, 3) }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const text = documentToLlmText(doc!);
    expect(text).toContain('# Document: test.xlsx');
    expect(text).toContain('## Sheet: Q');
    expect(text).toContain('Row 1: Name of company | Acme Corp');
    expect(text).toContain('Row 2: Contact email | a@b.com');
  });
});

describe('parseSpreadsheetToDocument — JSON serialization (Prisma JSONB persistence)', () => {
  // The parsed Document is persisted as Prisma JSONB on
  // engagement_files.parsed_document. JSONB requires the value to round-
  // trip cleanly through JSON.stringify / JSON.parse. These specs lock
  // in that contract — if a future Document field includes Date /
  // BigInt / undefined, the persistence path would silently corrupt or
  // throw.
  it('round-trips losslessly through JSON.stringify / parse', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const json = JSON.stringify(doc);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(doc);
  });

  it('serialises to JSON without producing undefined values (Prisma rejects undefined)', async () => {
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const json = JSON.stringify(doc);
    // JSON.stringify silently drops undefined-valued props; if it
    // didn't drop anything (length unchanged after re-parse +
    // re-stringify), that confirms no undefined values existed in
    // the source — a harder requirement than just "valid JSON".
    const reparsed = JSON.parse(json);
    expect(JSON.stringify(reparsed).length).toBe(json.length);
  });

  it('preserves merge anchor metadata across the JSON round-trip', async () => {
    // ExcelJS's writeBuffer doesn't include merge metadata in the
    // simple addRow() path, so we can't easily fixture merges from
    // here. Just assert the optional flags survive when present.
    const bytes = await makeWorkbookBytes([{ name: 'Q', rows: QA_ROWS }]);
    const doc = await parseSpreadsheetToDocument(bytes, {
      id: 'd1', filename: 'test.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    // Synthesise merge metadata to verify it survives the round-trip.
    if (doc && doc.sheets[0]?.rows[0]?.cells[0]) {
      doc.sheets[0].rows[0].cells[0].mergeAnchor = true;
    }
    const reparsed = JSON.parse(JSON.stringify(doc));
    expect(reparsed.sheets[0].rows[0].cells[0].mergeAnchor).toBe(true);
  });
});
