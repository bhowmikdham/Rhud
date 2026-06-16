/**
 * Phase B canonical-Document parser specs.
 *
 * Focus on the pure / shape-driven paths:
 *   - documentToRawPoints  (Document → Q/A points, deterministic)
 *   - documentToLlmText    (Document → structured text dump)
 *   - splitIntoTextBlocks  (heading detection in docx flow — exercised
 *                          via parseDocxToDocument's pure path; we
 *                          can't easily mock mammoth at this layer
 *                          without spinning up a fake .docx, so we
 *                          test heading detection through a synthetic
 *                          buffer-free function instead.)
 *
 * The xlsx parser path is exercised end-to-end via ExcelJS in a
 * separate integration spec; that requires real bytes. Unit tests
 * here lock in the parts where regressions would be silent.
 */

import { describe, it, expect } from 'vitest';
import {
  documentToRawPoints,
  documentToLlmText,
} from './spreadsheet.parser.js';
import type { RhudDocument } from '@rhud/shared';

function blankDoc(): RhudDocument {
  return {
    id: 'd1',
    filename: 'test.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    parsedAt: '2026-01-01T00:00:00.000Z',
    sheets: [],
    textBlocks: [],
    warnings: [],
  };
}

/** Helper: build a 2-column Q/A sheet from {label, value} rows.
 *  Column 0 = label, column 1 = value. */
function qaSheet(name: string, rows: Array<{ label: string; value: string }>) {
  return {
    name,
    index: 0,
    rowCount: rows.length,
    columnCount: 2,
    rows: rows.map((r, i) => ({
      index: i,
      cells: [
        { column: 0, value: r.label },
        { column: 1, value: r.value },
      ],
    })),
    detectedShape: 'qa' as const,
  };
}

describe('documentToRawPoints', () => {
  it('returns null when document has no sheets', () => {
    expect(documentToRawPoints(blankDoc())).toBeNull();
  });

  it('returns null when sheet has fewer than 7 plausible Q/A rows (heuristic floor)', () => {
    const doc = blankDoc();
    doc.sheets = [
      qaSheet('Tiny', [
        { label: 'Company name', value: 'Acme' },
        { label: 'Contact email', value: 'a@b.com' },
        { label: 'Phone', value: '555-0100' },
      ]),
    ];
    // Only 3 plausible Q/A pairs — below the 7-hit threshold for the
    // candidate column-pair detection.
    expect(documentToRawPoints(doc)).toBeNull();
  });

  it('extracts Q/A points from a clean two-column sheet', () => {
    const doc = blankDoc();
    doc.sheets = [
      qaSheet('Web App Q', [
        { label: 'Name of company', value: 'Acme' },
        { label: 'Contact phone', value: '555-0100' },
        { label: 'Application name', value: 'Staging Dashboard' },
        { label: 'Penetration testing type', value: 'Black Box' },
        { label: 'Hosting environment', value: 'AWS' },
        { label: 'Number of dynamic pages', value: '29' },
        { label: 'Number of static pages', value: '0' },
        { label: 'Number of roles', value: 'Admin, Read-only' },
      ]),
    ];
    const out = documentToRawPoints(doc);
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThan(0);
    // Find the dynamic-pages row.
    const pages = out!.find((p) => p.key.includes('dynamic_pages'));
    expect(pages).toBeDefined();
    expect(pages!.value).toBe('29');
    expect(pages!.sheetName).toBe('Web App Q');
  });

  it('de-duplicates the same (key,value) pair across sheets', () => {
    const doc = blankDoc();
    const rows = [
      { label: 'Company name', value: 'Acme' },
      { label: 'Contact email', value: 'a@b.com' },
      { label: 'Phone', value: '555-0100' },
      { label: 'Application name', value: 'Dashboard' },
      { label: 'Hosting environment', value: 'AWS' },
      { label: 'Number of pages', value: '10' },
      { label: 'Number of APIs', value: '5' },
      { label: 'Roles defined', value: 'Admin' },
    ];
    doc.sheets = [
      qaSheet('Sheet 1', rows),
      qaSheet('Sheet 2', rows),
    ];
    const out = documentToRawPoints(doc);
    expect(out).not.toBeNull();
    // Across both sheets we should see each unique pair exactly once.
    const dupKeys = out!.filter((p) => p.key === 'company_name');
    expect(dupKeys.length).toBe(1);
  });

  it('skips blank-value rows', () => {
    const doc = blankDoc();
    doc.sheets = [
      {
        name: 'Sparse',
        index: 0,
        rowCount: 8,
        columnCount: 2,
        rows: [
          { index: 0, cells: [{ column: 0, value: 'Company name' }, { column: 1, value: 'Acme' }] },
          { index: 1, cells: [{ column: 0, value: 'Contact email' }, { column: 1, value: 'a@b.com' }] },
          { index: 2, cells: [{ column: 0, value: 'Phone' }] }, // blank value — skip
          { index: 3, cells: [{ column: 0, value: 'Application' }, { column: 1, value: 'Dashboard' }] },
          { index: 4, cells: [{ column: 0, value: 'Hosting' }, { column: 1, value: 'AWS' }] },
          { index: 5, cells: [{ column: 0, value: 'Number of pages' }, { column: 1, value: '29' }] },
          { index: 6, cells: [{ column: 0, value: 'Number of APIs' }, { column: 1, value: '23' }] },
          { index: 7, cells: [{ column: 0, value: 'Roles' }, { column: 1, value: 'Admin' }] },
        ],
        detectedShape: 'qa',
      },
    ];
    const out = documentToRawPoints(doc);
    expect(out).not.toBeNull();
    // The "Phone" row had no value — it should NOT appear.
    expect(out!.find((p) => p.key === 'phone')).toBeUndefined();
  });
});

describe('documentToRawPoints — wide multi-application questionnaire', () => {
  // col 0 = question, cols 1..N = each application's answers.
  function wideSheet(name: string, rows: string[][]) {
    return {
      name,
      index: 0,
      rowCount: rows.length,
      columnCount: rows[0]!.length,
      rows: rows.map((r, i) => ({
        index: i,
        cells: r.map((value, column) => ({ column, value })),
      })),
      detectedShape: 'qa' as const,
    };
  }

  it('captures EACH application column as a distinct appId (not just the first)', () => {
    // Reproduces the "June" bug: 3 apps as columns, only App 1 was kept.
    const doc = blankDoc();
    doc.sheets = [
      wideSheet('Web App Questionnaire', [
        ['Name of the application', 'QMS', 'CRM Backend', 'CRM Frontend'],
        ['Penetration testing type', 'Black Box', 'Black Box', 'Black Box'],
        ['Number of static pages', '5', 'N/A', '6'],
        ['Number of dynamic pages', '44', 'N/A', '20'],
        ['How many roles', '7', '7', '4'],
        ['Hosting environment', 'AWS', 'AWS', 'AWS'],
        ['Web server in use', 'Nginx', 'Nginx', 'Nginx'],
        ['Backend database', 'MongoDB', 'MySQL', 'Postgres'],
      ]),
    ];
    const out = documentToRawPoints(doc);
    expect(out).not.toBeNull();

    const appIds = new Set(out!.map((p) => p.appId).filter(Boolean));
    expect(appIds.size).toBe(3); // all three apps, not one
    expect(appIds.has('qms')).toBe(true); // appId derived from the name row

    // Each app's dynamic-pages answer is preserved separately (not collapsed).
    const dyn = out!.filter((p) => p.key.includes('dynamic_pages'));
    expect(new Set(dyn.map((p) => p.value))).toEqual(new Set(['44', 'N/A', '20']));
  });

  it('leaves appId undefined for an ordinary single-answer-column sheet', () => {
    const doc = blankDoc();
    doc.sheets = [
      qaSheet('Web App Q', [
        { label: 'Name of company', value: 'Acme' },
        { label: 'Contact phone', value: '555-0100' },
        { label: 'Application name', value: 'Dashboard' },
        { label: 'Penetration testing type', value: 'Black Box' },
        { label: 'Hosting environment', value: 'AWS' },
        { label: 'Number of dynamic pages', value: '29' },
        { label: 'Number of static pages', value: '0' },
        { label: 'Number of roles', value: 'Admin' },
      ]),
    ];
    const out = documentToRawPoints(doc);
    expect(out!.every((p) => p.appId === undefined)).toBe(true);
  });

  it('does not mistake a sparse incidental column for a second application', () => {
    const rows = [
      ['Name of the application', 'Dashboard', 'see note'],
      ['Penetration testing type', 'Black Box', 'tbd'],
      ['Number of static pages', '5', ''],
      ['Number of dynamic pages', '44', ''],
      ['How many roles', '7', ''],
      ['Hosting environment', 'AWS', ''],
      ['Web server in use', 'Nginx', ''],
      ['Backend database', 'MongoDB', ''],
    ];
    const doc = blankDoc();
    doc.sheets = [
      {
        name: 'S',
        index: 0,
        rowCount: rows.length,
        columnCount: 3,
        rows: rows.map((r, i) => ({
          index: i,
          cells: r.map((value, column) => ({ column, value })).filter((c) => c.value !== ''),
        })),
        detectedShape: 'qa' as const,
      },
    ];
    const out = documentToRawPoints(doc);
    // col 2 has only 2 populated cells (< 7-hit floor) → single app.
    expect(out!.every((p) => p.appId === undefined)).toBe(true);
  });
});

describe('documentToLlmText', () => {
  it('formats a sheet-only Document with row-major dump', () => {
    const doc = blankDoc();
    doc.sheets = [
      qaSheet('Web App Q', [
        { label: 'Name', value: 'Acme' },
        { label: 'Pages', value: '29' },
      ]),
    ];
    const out = documentToLlmText(doc);
    expect(out).toContain('# Document: test.xlsx');
    expect(out).toContain('## Sheet: Web App Q (Q/A)');
    expect(out).toContain('Row 1: Name | Acme');
    expect(out).toContain('Row 2: Pages | 29');
  });

  it('formats a textBlock-only Document with heading + body', () => {
    const doc = blankDoc();
    doc.textBlocks = [
      { heading: '1. Introduction', headingDepth: 1, body: 'This is the intro.', page: 1 },
      { heading: '2. Scope',         headingDepth: 1, body: 'Scope details here.', page: 2 },
    ];
    const out = documentToLlmText(doc);
    expect(out).toContain('## 1. Introduction (page 1)');
    expect(out).toContain('This is the intro.');
    expect(out).toContain('## 2. Scope (page 2)');
  });

  it('renders a sheet without detected shape without the (Q/A) tag', () => {
    const doc = blankDoc();
    doc.sheets = [{
      name: 'Inventory',
      index: 0,
      rowCount: 1,
      columnCount: 2,
      rows: [{ index: 0, cells: [{ column: 0, value: 'a' }, { column: 1, value: 'b' }] }],
      detectedShape: null,
    }];
    const out = documentToLlmText(doc);
    expect(out).toContain('## Sheet: Inventory');
    expect(out).not.toContain('## Sheet: Inventory (Q/A)');
  });

  it('handles gaps in column indices (sparse rows)', () => {
    const doc = blankDoc();
    doc.sheets = [{
      name: 'Sparse',
      index: 0,
      rowCount: 1,
      columnCount: 3,
      rows: [{
        index: 0,
        cells: [
          { column: 0, value: 'A' },
          { column: 2, value: 'C' },
        ],
      }],
      detectedShape: null,
    }];
    const out = documentToLlmText(doc);
    // Column 1 is blank in the source — rendered as an empty slot.
    expect(out).toContain('Row 1: A |  | C');
  });

  it('handles a Document with both sheets and textBlocks', () => {
    const doc = blankDoc();
    doc.sheets = [qaSheet('Q', [
      { label: 'Name', value: 'Acme' },
      { label: 'Pages', value: '29' },
    ])];
    doc.textBlocks = [
      { heading: 'Notes', headingDepth: 1, body: 'See attached.', page: null },
    ];
    const out = documentToLlmText(doc);
    expect(out).toContain('## Sheet: Q');
    expect(out).toContain('Row 1: Name | Acme');
    expect(out).toContain('## Notes');
    expect(out).toContain('See attached.');
  });
});
