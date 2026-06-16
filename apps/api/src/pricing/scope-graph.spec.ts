/**
 * Unit tests for the Phase-2 canonical scope resolver. Pure function, no LLM —
 * the deterministic guarantee that each real-world asset is priced once.
 */

import { describe, it, expect } from 'vitest';
import { resolveCanonicalScope } from './scope-graph.js';
import type { InferredEntity } from './rate-card-mapper.service.js';

const e = (over: Partial<InferredEntity> & Pick<InferredEntity, 'serviceLineSlug'>): InferredEntity => ({
  scopeValue: 1,
  methodology: null,
  customerType: 'external',
  confidence: 0.9,
  reasoning: '',
  sourceQuote: '',
  source: 'llm',
  ...over,
});

describe('resolveCanonicalScope', () => {
  it('drops a web app\'s consumed API when a standalone API is scoped', () => {
    const { entities, dropped } = resolveCanonicalScope([
      e({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, appId: 'qms_web' }),
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, appId: 'qms_web' }), // consumed dup
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, appId: 'qms_backend' }), // standalone
    ]);
    const api = entities.filter((x) => x.serviceLineSlug === 'vapt_api_endpoints');
    expect(api).toHaveLength(1);
    expect(api[0]!.appId).toBe('qms_backend');
    expect(dropped.some((d) => d.reason === 'consumed_already_scoped')).toBe(true);
    // the web app keeps its pages
    expect(entities.some((x) => x.serviceLineSlug === 'vapt_web_app_dynamic_pages')).toBe(true);
  });

  it('KEEPS a web app\'s API when no standalone API exists (sole record)', () => {
    const { entities } = resolveCanonicalScope([
      e({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, appId: 'qms_web' }),
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 30, appId: 'qms_web' }),
    ]);
    expect(entities.filter((x) => x.serviceLineSlug === 'vapt_api_endpoints')).toHaveLength(1);
  });

  it('does NOT merge distinct API instances (different appIds, same count)', () => {
    const { entities } = resolveCanonicalScope([
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 50, appId: 'crm_backend' }),
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 50, appId: 'payments_backend' }),
    ]);
    expect(entities).toHaveLength(2); // two real, distinct APIs — never collapsed
  });

  it('collapses duplicate mentions of the same asset+driver (survivorship: max scope)', () => {
    const { entities, dropped } = resolveCanonicalScope([
      e({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 40, appId: 'app_1', confidence: 0.7 }),
      e({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, appId: 'app_1', confidence: 0.9 }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.scopeValue).toBe(44); // max stated count wins
    expect(entities[0]!.confidence).toBe(0.9);
    expect(dropped.some((d) => d.reason === 'duplicate_mention')).toBe(true);
  });

  it('resolves a within-run internal/external flip deterministically (external wins)', () => {
    const { entities } = resolveCanonicalScope([
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 18, appId: 'ml_api', customerType: 'internal' }),
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 18, appId: 'ml_api', customerType: 'external' }),
    ]);
    expect(entities).toHaveLength(1);
    expect(entities[0]!.customerType).toBe('external');
  });

  it('is order-independent (same result regardless of input order)', () => {
    const input: InferredEntity[] = [
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, appId: 'qms_web' }),
      e({ serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, appId: 'qms_web' }),
      e({ serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, appId: 'qms_backend' }),
    ];
    const a = JSON.stringify(resolveCanonicalScope(input).entities);
    const b = JSON.stringify(resolveCanonicalScope([...input].reverse()).entities);
    expect(a).toBe(b);
  });
});
