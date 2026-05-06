/**
 * Unit tests for the `promoteInferredToAnswers` bucketing logic.
 *
 * The pure helper (`buildPromotionPlan`) lives in `inferred-promote.ts`
 * so we can exercise the multi-app grouping, stale-slug detection,
 * and existing-answer protection without standing up a database.
 */

import { describe, it, expect } from 'vitest';
import type { InferredEntity } from '../pricing/rate-card-mapper.service.js';
import { buildPromotionPlan, type BodyTarget } from './inferred-promote.js';

function ent(over: Partial<InferredEntity> & Pick<InferredEntity, 'serviceLineSlug' | 'scopeValue'>): InferredEntity {
  return {
    methodology: 'black_box',
    customerType: 'external',
    confidence: 0.9,
    reasoning: 'test',
    sourceQuote: 'test',
    source: 'llm',
    ...over,
  };
}

const WEB_LOOP_ID = 'loop-web';
const API_LOOP_ID = 'loop-api';

const bodyMap: Map<string, BodyTarget> = new Map([
  ['vapt_web_app_dynamic_pages', { nodeId: 'n-web-dyn', loopId: WEB_LOOP_ID }],
  ['vapt_web_app_input_fields',  { nodeId: 'n-web-inf', loopId: WEB_LOOP_ID }],
  ['vapt_web_app_roles',         { nodeId: 'n-web-rol', loopId: WEB_LOOP_ID }],
  ['vapt_api_endpoints',         { nodeId: 'n-api-end', loopId: API_LOOP_ID }],
]);

const topMap: Map<string, string> = new Map([
  ['vapt_network_ids', 'n-ids'],
  ['vapt_cloud_iam', 'n-iam'],
]);

describe('buildPromotionPlan', () => {
  it('single-app doc (no appId): writes iter 0 only', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29 }),
      ent({ serviceLineSlug: 'vapt_web_app_input_fields', scopeValue: 60 }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.every((w) => w.iter === 0)).toBe(true);
    expect(plan.iterationsCreated).toBe(1);
  });

  it('multi-app doc with appId: each appId becomes one iteration in sorted order', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, appId: 'web_app_2' }),
      ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 120, appId: 'web_app_2' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_input_fields',  scopeValue: 60,  appId: 'web_app_1' }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.writes).toHaveLength(4);
    expect(plan.iterationsCreated).toBe(2);
    // iter 0 = web_app_1 (sorted first); iter 1 = web_app_2
    const iter0 = plan.writes.filter((w) => w.iter === 0);
    const iter1 = plan.writes.filter((w) => w.iter === 1);
    expect(iter0.find((w) => w.nodeId === 'n-web-dyn')?.value).toBe(29);
    expect(iter0.find((w) => w.nodeId === 'n-web-inf')?.value).toBe(60);
    expect(iter1.find((w) => w.nodeId === 'n-web-dyn')?.value).toBe(50);
    expect(iter1.find((w) => w.nodeId === 'n-web-inf')?.value).toBe(120);
  });

  it('mixed appId + no-appId: unique iteration per group, deterministic order', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 100 }), // _solo
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, appId: 'web_app_2' }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.iterationsCreated).toBe(3);
    // Sorted appIds: ['_solo', 'web_app_1', 'web_app_2']
    expect(plan.writes.find((w) => w.iter === 0)?.value).toBe(100);
    expect(plan.writes.find((w) => w.iter === 1)?.value).toBe(29);
    expect(plan.writes.find((w) => w.iter === 2)?.value).toBe(50);
  });

  it('top-level entities (Network/Cloud) always go to iter 0', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_network_ids', scopeValue: 1 }),
      ent({ serviceLineSlug: 'vapt_cloud_iam', scopeValue: 1 }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.writes).toHaveLength(2);
    expect(plan.writes.every((w) => w.iter === 0)).toBe(true);
    expect(plan.writes.map((w) => w.nodeId).sort()).toEqual(['n-iam', 'n-ids']);
  });

  it('stale slug (not in template) gets logged via staleSlugCounts, not written', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29 }),
      ent({ serviceLineSlug: 'vapt_unknown_future_slug', scopeValue: 5 }),
      ent({ serviceLineSlug: 'vapt_unknown_future_slug', scopeValue: 8 }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.staleSlugCounts.get('vapt_unknown_future_slug')).toBe(2);
  });

  it('existing answer never overwritten — write skipped when (nodeId,iter) is taken', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29 }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(['n-web-dyn:0']), // form already answered
    });
    expect(plan.writes).toHaveLength(0);
  });

  it('multiple entities for same (slug, appId) — first wins, second silently dropped', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 99, appId: 'web_app_1' }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]!.value).toBe(29);
  });

  it('cross-loop entities bucket independently', () => {
    const passing: InferredEntity[] = [
      ent({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      ent({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, appId: 'api_1' }),
    ];
    const plan = buildPromotionPlan({
      passing,
      bodyNodeBySlug: bodyMap,
      topLevelNodeBySlug: topMap,
      existingAnswers: new Set(),
    });
    // Each loop gets its own iter 0 (writes share iter=0 but different nodes/loops)
    expect(plan.writes).toHaveLength(2);
    expect(plan.iterationsCreated).toBe(2);
  });
});
