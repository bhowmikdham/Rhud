/**
 * End-to-end Prophaze regression test.
 *
 * Exercises the full mapper→kernel path that the user said the app
 * is dead without:
 *
 *   InferredEntity[] (with appId grouping)
 *     → toScopedEntities (mapper)
 *     → computeBasePrice (kernel)
 *     → exact rupee assertion against hand-calculation
 *
 * If anything in this chain regresses (per-unit math, methodology
 * resolution, slug naming, tier ranges, multi-app dedup), this test
 * fails LOUD before a wrong number reaches a quote.
 *
 * Scenario: a security questionnaire describing a Prophaze-shaped
 * engagement with 2 web apps, 1 API surface, IDS + IAM toggles, and
 * source-code review on the backend.
 */

import { describe, it, expect } from 'vitest';
import { computeBasePrice } from '@rhud/shared';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';
import {
  RateCardFieldMapperService,
  type InferredEntity,
} from './rate-card-mapper.service.js';

// Stub LlmService — toScopedEntities never calls it; only inferEntities
// does. We're testing the synchronous map → kernel path.
const noopLlm = {
  getProviderName: async () => null,
  chat: async () => ({ text: '{"entities":[]}' }),
} as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];

const RATE_CARD = buildProphazeRateCardFixture({
  rateCardId: 'rc-prophaze-e2e',
  tenantId: 'tenant-test',
  ids: 'deterministic',
});

const mapper = new RateCardFieldMapperService(noopLlm);

function entity(over: Partial<InferredEntity> & Pick<InferredEntity, 'serviceLineSlug' | 'scopeValue'>): InferredEntity {
  return {
    methodology: null,
    customerType: 'external',
    confidence: 0.9,
    reasoning: 'test',
    sourceQuote: 'test',
    source: 'llm',
    ...over,
  };
}

describe('Prophaze E2E — mapper to quote', () => {
  it('two web apps + one API + IDS + IAM + source code → exact rupee total', () => {
    const inferred: InferredEntity[] = [
      // Web App 1 — 29 dynamic pages, 60 input fields, 8 roles
      entity({
        serviceLineSlug: 'vapt_web_app_dynamic_pages',
        scopeValue: 29,
        appId: 'web_app_1',
      }),
      entity({
        serviceLineSlug: 'vapt_web_app_input_fields',
        scopeValue: 60,
        appId: 'web_app_1',
      }),
      entity({
        serviceLineSlug: 'vapt_web_app_roles',
        scopeValue: 8,
        customerType: 'internal', // grey-box service
        appId: 'web_app_1',
      }),
      // Web App 2 — 50 dynamic pages, 120 input fields
      entity({
        serviceLineSlug: 'vapt_web_app_dynamic_pages',
        scopeValue: 50,
        appId: 'web_app_2',
      }),
      entity({
        serviceLineSlug: 'vapt_web_app_input_fields',
        scopeValue: 120,
        appId: 'web_app_2',
      }),
      // API — 23 endpoints
      entity({
        serviceLineSlug: 'vapt_api_endpoints',
        scopeValue: 23,
        appId: 'api_1',
      }),
      // Network IDS toggle (binary, no appId)
      entity({
        serviceLineSlug: 'vapt_network_ids',
        scopeValue: 1,
      }),
      // Cloud IAM toggle (binary, no appId)
      entity({
        serviceLineSlug: 'vapt_cloud_iam',
        scopeValue: 1,
      }),
      // Backend source code review (1 lakh LOC)
      entity({
        serviceLineSlug: 'vapt_web_app_source_code_backend',
        scopeValue: 100_000,
        methodology: 'white_box',
      }),
    ];

    const scope = mapper.toScopedEntities(inferred, RATE_CARD);
    const result = computeBasePrice(RATE_CARD, scope);

    // Hand calculation against the rate card fixture:
    //   web_app_dynamic_pages: 29 pages @ Low (15-49) = ₹100/page → ₹2,900   (× black_box external)
    //                          50 pages @ Mid (50-99) = ₹70/page  → ₹3,500
    //   web_app_input_fields: 60 fields × ₹70/field   → wait: 60 falls in 25+ extrapolation tier @ ₹70/field = ₹4,200
    //                         120 fields × ₹70/field  → ₹8,400
    //   web_app_roles (grey, internal): 8 roles × ₹4,000 (5-8 bracket) = ₹32,000
    //   api_endpoints: 23 × ₹1,300 (16-25 bracket) = ₹29,900
    //   network_ids: flat ₹10,000
    //   cloud_iam: flat ₹30,000
    //   source_code_backend (1 lakh LOC, white_box): ₹60,000 (first lakh)
    //                                       ──────
    //   Total                                       ₹180,900 = 18,090,000 cents
    expect(result.hasUnmatched).toBe(false);
    expect(result.totalCents).toBe(180_900_00);
  });

  it('mapper preserves multi-app entityIds (no slug collisions)', () => {
    const inferred: InferredEntity[] = [
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, appId: 'web_app_2' }),
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 75, appId: 'web_app_3' }),
    ];
    const scope = mapper.toScopedEntities(inferred, RATE_CARD);
    expect(scope).toHaveLength(3);
    const ids = scope.map((s) => s.entityId);
    expect(new Set(ids).size).toBe(3); // all three entityIds must be unique
    expect(ids).toEqual([
      'extracted-llm:vapt_web_app_dynamic_pages:0',
      'extracted-llm:vapt_web_app_dynamic_pages:1',
      'extracted-llm:vapt_web_app_dynamic_pages:2',
    ]);
  });

  it('three same-slug entities all price separately (no implicit dedup)', () => {
    const inferred: InferredEntity[] = [
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, appId: 'web_app_1' }),
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, appId: 'web_app_2' }),
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 100, appId: 'web_app_3' }),
    ];
    const scope = mapper.toScopedEntities(inferred, RATE_CARD);
    const result = computeBasePrice(RATE_CARD, scope);
    // 29 × ₹100 = ₹2,900   (Low bracket 1-49)
    // 50 × ₹70  = ₹3,500   (Mid bracket 50-99)
    // 100 × ₹50 = ₹5,000   (High bracket 100-249)
    // ─────
    // ₹11,400 = 1,140,000 cents
    expect(result.totalCents).toBe(11_400_00);
    expect(result.lines).toHaveLength(3);
  });

  it('source code methodology auto-resolves to white_box (suffix matching)', () => {
    const inferred: InferredEntity[] = [
      // Note: methodology omitted; the mapper must auto-pick white_box
      // because the slug ends in '_source_code_backend'.
      entity({
        serviceLineSlug: 'vapt_web_app_source_code_backend',
        scopeValue: 100_000,
      }),
    ];
    const scope = mapper.toScopedEntities(inferred, RATE_CARD);
    expect(scope[0]!.methodology).toBe('white_box');
  });

  it('binary trigger (IDS) at scope=1 prices flat regardless of value', () => {
    const oneIds = mapper.toScopedEntities(
      [entity({ serviceLineSlug: 'vapt_network_ids', scopeValue: 1 })],
      RATE_CARD,
    );
    expect(computeBasePrice(RATE_CARD, oneIds).totalCents).toBe(10_000_00);
    // scope=5 should still flat-price at ₹10k since the model is `flat`
    const manyIds = mapper.toScopedEntities(
      [entity({ serviceLineSlug: 'vapt_network_ids', scopeValue: 5 })],
      RATE_CARD,
    );
    expect(computeBasePrice(RATE_CARD, manyIds).totalCents).toBe(10_000_00);
  });

  it('low-confidence entities (<0.6) silently filtered before pricing', () => {
    const inferred: InferredEntity[] = [
      entity({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, confidence: 0.55 }),
      entity({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, confidence: 0.85 }),
    ];
    const scope = mapper.toScopedEntities(inferred, RATE_CARD);
    expect(scope).toHaveLength(1);
    expect(scope[0]!.serviceLineSlug).toBe('vapt_api_endpoints');
  });
});
