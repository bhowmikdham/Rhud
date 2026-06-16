/**
 * Phase-2 canonical scope resolver — the ONE general mechanism that makes
 * "each real-world asset is priced once" a structural invariant, replacing the
 * per-pattern regex patches (the old `dedupeConsumedApis`).
 *
 * It treats the inferred entities as a tiny scope graph:
 *   - each appId is an ASSET INSTANCE, classified by the drivers it carries
 *     (a web_app if it has any vapt_web_app_* driver; an api if it has
 *     vapt_api_* and is not a web app; etc.);
 *   - a "consumes" relationship (a web app carrying api_* drivers for an API it
 *     merely uses) must NOT add scope — that API is already a node, billed once;
 *   - duplicate MENTIONS of the same canonical asset+driver collapse via
 *     deterministic survivorship (max stated scope wins; external>internal;
 *     most-specific methodology), which also removes within-run drift.
 *
 * Pure + order-independent + idempotent. Runs on both the LLM and heuristic
 * outputs. Deliberately CONSERVATIVE — it only collapses things that share an
 * appId (or are a consumed dependency of a separately-scoped asset); it never
 * merges two genuinely distinct application instances, so it can't under-count.
 */

import type { InferredEntity } from './rate-card-mapper.service.js';

export interface ScopeResolution {
  entities: InferredEntity[];
  dropped: Array<{ entity: InferredEntity; reason: 'consumed_already_scoped' | 'duplicate_mention' }>;
}

const WEB_APP_RE = /^vapt_web_app_/;
const API_RE = /^vapt_api_/;

/** external is the safer/standard default for VAPT (black-box from outside);
 *  used to resolve a within-run customerType flip deterministically. */
function customerTypeRank(ct: InferredEntity['customerType']): number {
  return ct === 'external' ? 1 : 0;
}

/** Prefer the more specific (non-null) methodology when collapsing mentions. */
function methodologyIsMoreSpecific(
  a: InferredEntity['methodology'],
  b: InferredEntity['methodology'],
): boolean {
  if (a != null && b == null) return true;
  if (a == null) return false;
  return a.length > (b ?? '').length;
}

export function resolveCanonicalScope(entities: InferredEntity[]): ScopeResolution {
  const dropped: ScopeResolution['dropped'] = [];

  // ── 1. Classify appIds by asset kind ────────────────────────────────
  const webAppIds = new Set(
    entities.filter((e) => e.appId && WEB_APP_RE.test(e.serviceLineSlug)).map((e) => e.appId!),
  );
  const standaloneApiAppIds = new Set(
    entities
      .filter((e) => e.appId && API_RE.test(e.serviceLineSlug) && !webAppIds.has(e.appId!))
      .map((e) => e.appId!),
  );

  // ── 2. Drop consumed-dependency duplicates ──────────────────────────
  // A web app carrying vapt_api_* drivers is describing an API it CONSUMES.
  // If that API is separately scoped (a standalone API instance exists), the
  // endpoints are already a node — bill them once. Only drop when a standalone
  // API exists, so an API that lives ONLY inside a web app is never lost.
  const afterConsumed = entities.filter((e) => {
    if (
      e.appId &&
      webAppIds.has(e.appId) &&
      API_RE.test(e.serviceLineSlug) &&
      standaloneApiAppIds.size > 0
    ) {
      dropped.push({ entity: e, reason: 'consumed_already_scoped' });
      return false;
    }
    return true;
  });

  // ── 3. Survivorship: collapse duplicate mentions of the same asset ──
  // Same (appId, slug) = the same driver on the same asset instance. Keep ONE,
  // resolving conflicts deterministically: max stated scope, external>internal,
  // most-specific methodology, highest confidence. Iterate in a stable order so
  // the result is identical regardless of input ordering.
  const order = [...afterConsumed]
    .map((e, i) => ({ e, i }))
    .sort((a, b) => {
      const ka = `${a.e.appId ?? ''}::${a.e.serviceLineSlug}`;
      const kb = `${b.e.appId ?? ''}::${b.e.serviceLineSlug}`;
      return ka === kb ? a.i - b.i : ka.localeCompare(kb);
    })
    .map((x) => x.e);

  const byKey = new Map<string, InferredEntity>();
  for (const e of order) {
    const key = `${e.appId ?? ''}::${e.serviceLineSlug}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, e);
      continue;
    }
    const merged: InferredEntity = {
      ...prev,
      scopeValue: Math.max(prev.scopeValue, e.scopeValue),
      confidence: Math.max(prev.confidence, e.confidence),
      customerType: customerTypeRank(e.customerType) > customerTypeRank(prev.customerType)
        ? e.customerType
        : prev.customerType,
      ...(methodologyIsMoreSpecific(e.methodology, prev.methodology)
        ? { methodology: e.methodology }
        : {}),
    };
    byKey.set(key, merged);
    dropped.push({ entity: e, reason: 'duplicate_mention' });
  }

  return { entities: [...byKey.values()], dropped };
}
