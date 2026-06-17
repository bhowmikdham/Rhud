/**
 * Real-file regression test for the Link-18 two-sheet workbook
 * (Infrastructure inventory + Application Assessment multi-app), driven on the
 * ACTUAL bytes. This is the gap that let the first parser fix ship: a synthetic
 * fixture passed while the real file broke (a merged "Scope" cell hijacked the
 * label column and the app answers were dropped). Locks in BOTH sheets.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseSpreadsheetToDocument,
  documentToRawPoints,
  type RawPoint,
} from './spreadsheet.parser.js';

const FIXTURE = join(__dirname, '__fixtures__', 'link18-infra-and-apps.xlsx');

async function parse(): Promise<RawPoint[]> {
  const bytes = readFileSync(FIXTURE);
  const doc = await parseSpreadsheetToDocument(bytes, {
    id: 'd-link18',
    filename: 'link18.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  if (!doc) throw new Error('parseSpreadsheetToDocument returned null');
  const points = documentToRawPoints(doc);
  if (!points) throw new Error('documentToRawPoints returned null');
  return points;
}

describe('Link-18 real-file parse', () => {
  it('Infrastructure inventory: clean asset counts, NO bogus appId', async () => {
    const infra = (await parse()).filter((p) => p.sheetName === 'Infrastructure VAPT');

    // The 23 application/operations servers survive as ONE clean countable
    // point — the line my first attempt dropped and this whole fix exists for.
    const servers = infra.find((p) => p.key === 'application_operations_server');
    expect(servers?.value).toBe('23');
    expect(servers?.appId).toBeUndefined();

    expect(infra.find((p) => p.key === 'database_server')?.value).toBe('5');
    expect(infra.find((p) => p.key === 'firewall')?.value).toBe('2');
    expect(infra.find((p) => p.key === 'web_server')?.value).toBe('5');

    // An inventory sheet is single-column: NO appIds at all, and NEVER the
    // count "23" as one.
    expect(infra.every((p) => p.appId === undefined)).toBe(true);
  });

  it('Application Assessment: all 4 apps with their per-app volumetrics', async () => {
    const apps = (await parse()).filter((p) => p.sheetName === 'Application Assessment');

    const appIds = new Set(apps.map((p) => p.appId).filter(Boolean));
    expect(appIds.has('portalx')).toBe(true);
    expect(appIds.has('portaly')).toBe(true);
    expect(appIds.size).toBeGreaterThanOrEqual(4); // 2 mobile + PortalX + PortalY

    // Per-app dynamic-page counts are preserved (the data my first fix wiped).
    const dyn = apps.filter((p) => p.key === 'number_of_dynamic_pages');
    expect(new Set(dyn.map((p) => p.value))).toEqual(new Set(['5', '30']));
    expect(dyn.find((p) => p.appId === 'portalx')?.value).toBe('30');
    expect(dyn.find((p) => p.appId === 'portaly')?.value).toBe('30');

    // APIs per app, and the grey-box methodology, both carried through.
    const apis = apps.filter((p) => p.key === 'no_of_web_services_soap_rest_apis');
    expect(apis.find((p) => p.appId === 'portalx')?.value).toBe('10');
    expect(apps.some((p) => p.value === 'Grey Box')).toBe(true);
  });
});
