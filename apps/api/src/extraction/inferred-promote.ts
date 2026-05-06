/**
 * Pure helpers for `promoteInferredToAnswers` — extracted so we can
 * unit-test the bucketing logic without spinning up a database.
 *
 * The DB-touching path lives in `extraction.service.ts`; this file
 * holds the deterministic logic that takes:
 *
 *   - the inferred entities (filtered by confidence + scope)
 *   - the template's `slug → bodyNode | topLevelNode` lookups
 *
 * and emits the writes the service should make + a list of slugs
 * that didn't match anything in the template (used for the stale-slug
 * warning).
 */

import type { InferredEntity } from '../pricing/rate-card-mapper.service.js';

export interface BodyTarget {
  nodeId: string;
  loopId: string;
}

export interface PromotionWrite {
  nodeId: string;
  iter: number;
  value: number;
}

export interface PromotionPlan {
  /** One row per (nodeId, iter) the service should insert. */
  writes: PromotionWrite[];
  /** Map of slug → number of inferred entities that referenced it but
   *  found no template binding. The service logs these as stale. */
  staleSlugCounts: Map<string, number>;
  /** How many distinct iterations the loop entities cover (for telemetry). */
  iterationsCreated: number;
}

/**
 * Build a promotion plan from inferred entities + template lookups.
 *
 * Bucketing rules:
 *   - Body-node entities (slug binds inside a loop) bucket by
 *     `(loopId, appId)`. Each unique appId becomes one iteration.
 *     `_solo` is the bucket key for entities without an appId, so a
 *     single-app doc still produces iter 0.
 *   - Top-level entities (slug binds outside any loop) always go to
 *     iteration 0.
 *   - Existing `(nodeId, iter)` answers are NEVER overwritten — the
 *     service passes them in via `existingAnswers` so this function
 *     stays pure.
 */
export function buildPromotionPlan(args: {
  passing: InferredEntity[];
  bodyNodeBySlug: Map<string, BodyTarget>;
  topLevelNodeBySlug: Map<string, string>;
  existingAnswers: Set<string>; // keys: `${nodeId}:${iter}`
}): PromotionPlan {
  const { passing, bodyNodeBySlug, topLevelNodeBySlug, existingAnswers } = args;
  const bucketsByLoop = new Map<string, Map<string, InferredEntity[]>>();
  const topLevelEntities: InferredEntity[] = [];
  const staleSlugCounts = new Map<string, number>();

  for (const e of passing) {
    const bodyHit = bodyNodeBySlug.get(e.serviceLineSlug);
    if (bodyHit) {
      const groupKey = e.appId ?? '_solo';
      const groups = bucketsByLoop.get(bodyHit.loopId) ?? new Map<string, InferredEntity[]>();
      const list = groups.get(groupKey) ?? [];
      list.push(e);
      groups.set(groupKey, list);
      bucketsByLoop.set(bodyHit.loopId, groups);
    } else if (topLevelNodeBySlug.has(e.serviceLineSlug)) {
      topLevelEntities.push(e);
    } else {
      staleSlugCounts.set(
        e.serviceLineSlug,
        (staleSlugCounts.get(e.serviceLineSlug) ?? 0) + 1,
      );
    }
  }

  const writes: PromotionWrite[] = [];
  const seenInPlan = new Set<string>(existingAnswers);
  let iterationsCreated = 0;

  // Loop iterations.
  for (const [, groups] of bucketsByLoop) {
    const sortedAppIds = [...groups.keys()].sort();
    for (let iter = 0; iter < sortedAppIds.length; iter++) {
      const appId = sortedAppIds[iter]!;
      const entities = groups.get(appId) ?? [];
      let writtenInIter = 0;
      for (const e of entities) {
        const hit = bodyNodeBySlug.get(e.serviceLineSlug);
        if (!hit) continue;
        const key = `${hit.nodeId}:${iter}`;
        if (seenInPlan.has(key)) continue;
        seenInPlan.add(key);
        writes.push({ nodeId: hit.nodeId, iter, value: e.scopeValue });
        writtenInIter++;
      }
      if (writtenInIter > 0) iterationsCreated++;
    }
  }

  // Top-level entities (always iter 0).
  for (const e of topLevelEntities) {
    const nodeId = topLevelNodeBySlug.get(e.serviceLineSlug);
    if (!nodeId) continue;
    const key = `${nodeId}:0`;
    if (seenInPlan.has(key)) continue;
    seenInPlan.add(key);
    writes.push({ nodeId, iter: 0, value: e.scopeValue });
  }

  return { writes, staleSlugCounts, iterationsCreated };
}
