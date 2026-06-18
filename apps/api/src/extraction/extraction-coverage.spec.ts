/**
 * Unit tests for the structured-parse coverage gate + merge (the MedTech fix):
 * when the deterministic Q/A parser misses content-bearing sheets, extraction
 * must ESCALATE to the LLM extractor instead of returning a thin partial.
 */
import { describe, it, expect } from 'vitest';
import {
  structuredCoverageComplete,
  mergeExtractedPoints,
  type ExtractedPoint,
} from './extraction.service.js';
import type { RhudDocument, DocumentSheet } from '@rhud/shared';
import type { RawPoint } from './spreadsheet.parser.js';

function sheet(name: string, nonEmptyRows: number): DocumentSheet {
  return {
    name,
    index: 0,
    rowCount: nonEmptyRows,
    columnCount: 2,
    rows: Array.from({ length: nonEmptyRows }, (_, i) => ({
      index: i,
      cells: [{ column: 0, value: `${name} label ${i}` }],
    })),
    detectedShape: null,
  };
}

function doc(sheets: DocumentSheet[]): RhudDocument {
  return {
    id: 'd', filename: 'f.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parsedAt: '2026-01-01T00:00:00.000Z', sheets, textBlocks: [], warnings: [],
  };
}

const rawIn = (sheetName: string): RawPoint => ({ key: 'k', label: 'l', value: 'v', sheetName });

describe('structuredCoverageComplete', () => {
  it('INCOMPLETE when a content-bearing sheet got zero structured points (MedTech)', () => {
    // 7 content sheets, but the Q/A parser only produced points for 3.
    const d = doc([
      sheet('Basic Information', 11), sheet('Web App', 30), sheet('Corporate', 16),
      sheet('Mobile App', 29), sheet('Endpoint', 9), sheet('Network', 10), sheet('API', 22),
    ]);
    const raw = [rawIn('Web App'), rawIn('Mobile App'), rawIn('API')];
    const cov = structuredCoverageComplete(d, raw);
    expect(cov.content).toBe(7);
    expect(cov.covered).toBe(3);
    expect(cov.complete).toBe(false); // → escalate to LLM
  });

  it('COMPLETE when every content sheet contributed a point', () => {
    const d = doc([sheet('Infra', 18), sheet('Apps', 15)]);
    const raw = [rawIn('Infra'), rawIn('Apps')];
    expect(structuredCoverageComplete(d, raw).complete).toBe(true);
  });

  it('ignores tiny title/legend sheets (< 5 non-empty rows)', () => {
    const d = doc([sheet('Title', 2), sheet('Q&A', 12)]);
    const raw = [rawIn('Q&A')]; // Title has only 2 rows → not counted as content
    const cov = structuredCoverageComplete(d, raw);
    expect(cov.content).toBe(1);
    expect(cov.complete).toBe(true);
  });
});

describe('mergeExtractedPoints', () => {
  const p = (key: string, value: string, sheet: string): ExtractedPoint =>
    ({ key, value, sheet, sourceQuote: '', relatedQuestion: null });

  it('de-dupes by sheet+key+value, structured first', () => {
    const structured = [p('roles', '3', 'API')];
    const llm = [p('roles', '3', 'API'), p('endpoints', '20', 'API')];
    const merged = mergeExtractedPoints(structured, llm);
    expect(merged).toHaveLength(2); // duplicate roles collapsed
    expect(merged[0]!.key).toBe('roles'); // structured kept
    expect(merged.some((x) => x.key === 'endpoints')).toBe(true); // LLM-only kept
  });
});
