/**
 * Tiny mapping engine for Rhud → Odoo field translation.
 *
 * Mappings can be customised per tenant (OdooFieldMapping rows), but a
 * sensible default lives in `@rhud/shared#ODOO_DEFAULT_MAPPINGS`. This
 * module flattens both into a single applied map at runtime.
 */

import type { OdooFieldMapping } from '@rhud/shared';
import { ODOO_DEFAULT_MAPPINGS } from '@rhud/shared';

/** Resolve a dotted path against a record. "quote.baseTotalCents" → record.quote.baseTotalCents. */
export function resolvePath(record: unknown, path: string): unknown {
  if (record == null) return undefined;
  const parts = path.split('.');
  let cur: unknown = record;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Apply the named transform to a value. Unknown transforms = identity. */
export function applyTransform(value: unknown, transform: string | null | undefined): unknown {
  if (!transform) return value;

  // constant:<literal> wins over the source — useful for "always set
  // priority='2' on outgoing".
  if (transform.startsWith('constant:')) {
    return transform.slice('constant:'.length);
  }

  if (value == null) return value;
  switch (transform) {
    case 'cents_to_currency': {
      const n = typeof value === 'bigint' ? Number(value) : Number(value);
      return Number.isFinite(n) ? Number((n / 100).toFixed(2)) : 0;
    }
    case 'json_stringify':
      return JSON.stringify(value);
    case 'uppercase':
      return typeof value === 'string' ? value.toUpperCase() : value;
    case 'lowercase':
      return typeof value === 'string' ? value.toLowerCase() : value;
    default:
      return value;
  }
}

export interface CompiledMapping {
  rhudEntity: string;
  rhudField: string;
  odooModel: string;
  odooField: string;
  transform: string | null;
  required: boolean;
  direction: 'push' | 'pull' | 'both';
}

/**
 * Merge default mappings + tenant customisations into a single list.
 * Tenant rows override defaults that match on (rhudEntity, rhudField,
 * odooModel, odooField, direction).
 */
export function compileMappings(custom: OdooFieldMapping[]): CompiledMapping[] {
  const customKey = (m: { rhudEntity: string; rhudField: string; odooModel: string; odooField: string; direction: string }) =>
    `${m.rhudEntity}|${m.rhudField}|${m.odooModel}|${m.odooField}|${m.direction}`;

  const customSet = new Set(custom.map(customKey));
  const out: CompiledMapping[] = [];

  for (const def of ODOO_DEFAULT_MAPPINGS) {
    if (customSet.has(customKey(def))) continue; // overridden
    out.push({
      rhudEntity: def.rhudEntity,
      rhudField: def.rhudField,
      odooModel: def.odooModel,
      odooField: def.odooField,
      transform: def.transform,
      required: def.required,
      direction: def.direction,
    });
  }

  for (const m of custom) {
    out.push({
      rhudEntity: m.rhudEntity,
      rhudField: m.rhudField,
      odooModel: m.odooModel,
      odooField: m.odooField,
      transform: m.transform,
      required: m.required,
      direction: m.direction,
    });
  }
  return out;
}

/**
 * Build the Odoo write payload for a given Rhud entity by walking the
 * compiled mappings.
 *
 * Returns `{ fields, missingRequired }` — caller decides whether a
 * missingRequired list aborts the sync (typically yes).
 */
export function buildOdooPayload(
  mappings: CompiledMapping[],
  rhudEntityName: string,
  source: unknown,
  targetOdooModel: string,
): { fields: Record<string, unknown>; missingRequired: string[] } {
  const fields: Record<string, unknown> = {};
  const missingRequired: string[] = [];

  for (const m of mappings) {
    if (m.rhudEntity !== rhudEntityName) continue;
    if (m.odooModel !== targetOdooModel) continue;
    if (m.direction === 'pull') continue; // not a push mapping

    const raw = resolvePath(source, m.rhudField);
    const transformed = applyTransform(raw, m.transform);

    if (transformed == null || transformed === '') {
      if (m.required) missingRequired.push(`${m.rhudEntity}.${m.rhudField}`);
      continue;
    }
    fields[m.odooField] = transformed;
  }

  return { fields, missingRequired };
}
