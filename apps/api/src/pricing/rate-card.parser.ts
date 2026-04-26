/**
 * Phase 2 — Structural parser for rate-card xlsx (layer 1 of the
 * three-layer ingestion pipeline described in Pricing PDF §2.3).
 *
 * Today this is calibrated to the CSaaS partner's specific layout:
 *
 *   • Two parallel pricing blocks, internal on the left and external
 *     on the right, sharing the same row scaffold.
 *   • Service-category text in column A on the row that opens a new
 *     section; blank thereafter until the next section.
 *   • Methodology sub-headers ("Grey Box Testing", "Black Box Testing")
 *     in column C of a row whose column A is blank (continuing the
 *     current service line) or non-blank (starting a new one).
 *   • Tier rows: column B = range label ("0-30", "Upto 50",
 *     "200 & Above", "1000 & above"), columns C/E = prices.
 *   • An "Other Services/ Audit/ Compliance" section toward the end
 *     where prices are intentionally blank (open-priced services).
 *
 * Phase 2 layer 2 is an LLM classifier that handles arbitrary layouts
 * by re-typing each region against the canonical schema. That's where
 * generality lives. This parser only covers the layout we can verify
 * end-to-end with the sample file in the repo — anything weirder
 * surfaces as a `warning` so the admin-review UI can flag it.
 */

import type { CreateRateCardInput } from './pricing.service.js';
import type { CustomerType, Methodology, ScopeUnit } from '@rhud/shared';

export interface ParseResult {
  draft: CreateRateCardInput;
  warnings: string[];
}

interface ServiceLineDraft {
  slug: string;
  displayName: string;
  scopeUnit: ScopeUnit;
  position: number;
  // Pending tiers we'll attach once we know the methodology of the
  // currently active subgroup.
  tiers: NonNullable<CreateRateCardInput['serviceLines'][number]['tiers']>;
}

interface OpenPriced {
  slug: string;
  displayName: string;
  category?: string | null;
}

const SCOPE_UNIT_BY_LABEL: Record<string, ScopeUnit> = {
  'no. of pages': 'pages',
  'no. of screens': 'screens',
  "no. of api's": 'apis',
  'no. of apis': 'apis',
  'no. of lines': 'loc',
  'server/ device type': 'devices',
  'server / device type': 'devices',
  'service/ audit/ compliance': 'other',
  'service / audit / compliance': 'other',
};

export function parseCsaasRateCard(matrix: string[][], opts: { name?: string } = {}): ParseResult {
  const warnings: string[] = [];
  const lines: ServiceLineDraft[] = [];
  const openPriced: OpenPriced[] = [];
  let position = 0;
  let openPricedMode = false;

  // Iteration state — most recent service line and methodology subgroup.
  let current: ServiceLineDraft | null = null;
  let currentMethodology: Methodology = null;

  // Header rows (row 0 + 1). The CSaaS layout uses two; if the file is
  // shorter or shaped differently, we still try and just emit a warning.
  for (let r = 2; r < matrix.length; r++) {
    const row = matrix[r] ?? [];
    const colA = (row[0] ?? '').trim();
    const colB = (row[1] ?? '').trim();
    const colC = (row[2] ?? '').trim();
    const colD = (row[3] ?? '').trim();
    const colE = (row[4] ?? '').trim();

    if (!colA && !colB && !colC && !colD && !colE) continue;

    if (colA) {
      // New service line OR open-priced section header.
      const lower = colA.toLowerCase();
      if (lower.includes('other services') || lower.includes('audit/ compliance') || lower.includes('audit / compliance')) {
        openPricedMode = true;
        current = null;
        // The header row itself can carry the first item too on some
        // sheets; on the CSaaS sample column B = "Service/ Audit/
        // Compliance" — that's a label, not data. Skip it here and let
        // subsequent rows fill the list.
        continue;
      }

      openPricedMode = false;
      const cleanedName = colA.replace(/\s+/g, ' ').replace(/\s*\(.*?roles?\)/i, '').trim();
      const scopeUnit = lookupScopeUnit(colB) ?? 'other';
      if (scopeUnit === 'other') {
        warnings.push(`Row ${r + 1}: unrecognised scope unit "${colB}" for "${cleanedName}".`);
      }
      const slug = makeSlug(cleanedName);
      current = {
        slug,
        displayName: cleanedName,
        scopeUnit,
        position: position++,
        tiers: [],
      };
      lines.push(current);
      currentMethodology = methodologyFromHeader(colC, cleanedName);
      continue;
    }

    // Column A blank.
    if (openPricedMode) {
      const display = (colB || colD).trim();
      if (display) {
        openPriced.push({ slug: makeSlug(display), displayName: display, category: null });
      }
      continue;
    }

    if (!current) {
      // Stray row before we found a header — skip with a warning.
      warnings.push(`Row ${r + 1}: data outside any service line; ignored.`);
      continue;
    }

    // Methodology sub-header? Recognised by C being a header label
    // ("Grey Box Testing"/etc) rather than a number.
    const headerLike = looksLikeMethodologyHeader(colC);
    if (headerLike) {
      currentMethodology = methodologyFromHeader(colC, current.displayName);
      continue;
    }

    // Tier row: parse range from column B and prices from C / E.
    const range = parseRange(colB);
    const internalCents = parseRupees(colC);
    const externalCents = parseRupees(colE);
    if (range && (internalCents !== null || externalCents !== null)) {
      if (internalCents !== null) {
        current.tiers.push(makeTier(range, currentMethodology, 'internal', internalCents, colB));
      }
      if (externalCents !== null) {
        current.tiers.push(makeTier(range, currentMethodology, 'external', externalCents, colD || colB));
      }
      continue;
    }

    // Device-priced row: scope_unit === 'devices', column B is a
    // device-class label like "Servers (VA)", price columns are flat
    // per-device rates. Treat the row's display label as the tier label
    // and emit a single open-ended tier per customer-type. The methodology
    // is read from the parenthesised suffix.
    if (current.scopeUnit === 'devices' && (internalCents !== null || externalCents !== null)) {
      const m = colB.match(/\(([^)]+)\)\s*$/);
      const methodTag = m?.[1]?.toLowerCase().trim() ?? '';
      const meth: Methodology =
        methodTag === 'va' ? 'va' :
        methodTag === 'pt' ? 'pt' :
        currentMethodology;
      if (internalCents !== null) {
        current.tiers.push(makeTier({ min: 1, max: null, raw: colB }, meth, 'internal', internalCents, colB));
      }
      if (externalCents !== null) {
        current.tiers.push(makeTier({ min: 1, max: null, raw: colB }, meth, 'external', externalCents, colD || colB));
      }
      continue;
    }

    if (range && internalCents === null && externalCents === null) {
      // Range with empty prices — likely an inherited row in a section
      // the source author left blank. Emit as a warning so the admin
      // can fill it in during review.
      warnings.push(`Row ${r + 1}: tier "${colB}" in "${current.displayName}" has no prices.`);
    }
  }

  // The Network / Infra section in the CSaaS layout enumerates devices
  // (Servers VA / FW VA / Desktops VA / …) within a single service line.
  // Split each into its own service line so the canonical schema has
  // one slug per priceable axis (matches the fixture). Only triggers
  // when scope_unit === 'devices'.
  const splitOut: ServiceLineDraft[] = [];
  for (const sl of lines) {
    if (sl.scopeUnit !== 'devices' || sl.tiers.length === 0) {
      splitOut.push(sl);
      continue;
    }
    splitOut.push(...splitDeviceLine(sl, position));
    position += sl.tiers.length;
  }

  const draft: CreateRateCardInput = {
    name: opts.name ?? 'Imported Rate Card',
    serviceLines: splitOut.map((sl) => ({
      slug: sl.slug,
      displayName: sl.displayName,
      scopeUnit: sl.scopeUnit,
      position: sl.position,
      tiers: sl.tiers,
    })),
    openPricedServices: openPriced,
  };

  return { draft, warnings };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function lookupScopeUnit(label: string): ScopeUnit | null {
  const k = label.toLowerCase().replace(/\s+/g, ' ').trim();
  return SCOPE_UNIT_BY_LABEL[k] ?? null;
}

function makeSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s\-/&]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^vapt_(.+)/, 'vapt_$1')
    .slice(0, 60) || 'item';
}

function methodologyFromHeader(header: string, serviceLineName: string): Methodology {
  const h = header.toLowerCase();
  if (!h) return null;
  if (h.includes('grey box') && h.includes('apk')) return 'grey_box_apk';
  if (h.includes('grey box') && h.includes('ipa')) return 'grey_box_ipa';
  if (h.includes('black box') && h.includes('apk')) return 'black_box_apk';
  if (h.includes('black box') && h.includes('ipa')) return 'black_box_ipa';
  if (h.includes('grey box')) return 'grey_box';
  if (h.includes('black box')) return 'black_box';
  // "Pricing per API (total)" / "Pricing per Application" / "Pricing
  // per Sever/Device" → single-axis, no methodology distinction.
  if (h.includes('pricing per')) return null;
  // Fallbacks based on service-line name when the header is blank.
  if (!header) {
    if (serviceLineName.toLowerCase().includes('api')) return null;
    if (serviceLineName.toLowerCase().includes('source code')) return null;
  }
  return null;
}

function looksLikeMethodologyHeader(s: string): boolean {
  const lower = s.toLowerCase();
  return (
    lower.includes('grey box') ||
    lower.includes('black box') ||
    lower.startsWith('pricing per')
  );
}

interface Range { min: number; max: number | null; raw: string; }

function parseRange(raw: string): Range | null {
  const s = raw.trim();
  if (!s) return null;
  // "X - Y" / "X-Y"
  const m1 = s.match(/^(\d[\d,]*)\s*[-–]\s*(\d[\d,]*)/);
  if (m1) return { min: int(m1[1]!), max: int(m1[2]!), raw: s };
  // "Upto N" / "upto N"
  const m2 = s.match(/^upto\s+(\d[\d,]*)/i);
  if (m2) return { min: 0, max: int(m2[1]!), raw: s };
  // "X & Above" / "X & above" — exclusive of X (the previous tier
  // already covers exactly X). Using min = X+1 matches the canonical
  // fixture in csaas-rate-card.fixture.ts.
  const m3 = s.match(/^(\d[\d,]*)\s*&\s*above/i);
  if (m3) return { min: int(m3[1]!) + 1, max: null, raw: s };
  // "X to Y" — Source Code Review uses this form.
  const m4 = s.match(/^(\d[\d,]*)\s+to\s+(\d[\d,]*)/i);
  if (m4) return { min: int(m4[1]!), max: int(m4[2]!), raw: s };
  // "0-30 " trailing whitespace handled implicitly.
  return null;
}

function int(s: string): number {
  return Number.parseInt(s.replace(/,/g, ''), 10);
}

function parseRupees(s: string): number | null {
  const cleaned = s.replace(/[,\s₹]/g, '').trim();
  if (!cleaned) return null;
  // Some cells are formula text like "40000 upto exceding next 99K LOC"
  // — pull the leading integer if any.
  const m = cleaned.match(/^\d+/);
  if (!m) return null;
  return Number.parseInt(m[0]!, 10) * 100;
}

function makeTier(
  range: Range,
  methodology: Methodology,
  customerType: CustomerType,
  priceCents: number,
  label: string,
): NonNullable<CreateRateCardInput['serviceLines'][number]['tiers']>[number] {
  return {
    rangeMin: range.min,
    rangeMax: range.max,
    methodology,
    customerType,
    priceCents,
    displayLabel: label,
  };
}

function splitDeviceLine(sl: ServiceLineDraft, basePosition: number): ServiceLineDraft[] {
  // Group by (display_label, methodology code) — the source row label
  // ("Servers (VA)") doubles as the device class identifier.
  const buckets = new Map<string, ServiceLineDraft>();
  for (const t of sl.tiers) {
    const label = t.displayLabel ?? 'device';
    const m = label.match(/\(([^)]+)\)/);
    const tag = (m?.[1] ?? '').toLowerCase().trim(); // 'va' | 'pt'
    const cleaned = label.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const key = `${cleaned}|${tag}`;
    const slug = `net_${makeSlug(cleaned)}_${tag}`;
    let existing = buckets.get(key);
    if (!existing) {
      existing = {
        slug,
        displayName: `Network — ${cleaned} (${tag.toUpperCase()})`,
        scopeUnit: 'devices',
        position: basePosition + buckets.size,
        tiers: [],
      };
      buckets.set(key, existing);
    }
    existing.tiers.push({
      ...t,
      methodology: tag === 'va' ? 'va' : tag === 'pt' ? 'pt' : t.methodology,
      // Replace the per-row range_min=range_max with an open-ended one
      // so any device count multiplies the per-device rate.
      rangeMin: 1,
      rangeMax: null,
      displayLabel: 'per device',
    });
  }
  return [...buckets.values()];
}
