/**
 * Unit tests for the new multi-driver `normaliseScope`.
 *
 * Three behaviours:
 *   1. Legacy single-driver loop (loopConfig.serviceLineSlug + body's
 *      `binding.field='scope_value'` without slug) — backwards compatible
 *      with the CSaaS-shape templates already in production.
 *   2. Multi-driver loop (each body node carries `binding.serviceLineSlug`)
 *      — one iteration emits N ScopedEntities, one per driver. This is
 *      what unblocks the Prophaze intake.
 *   3. Top-level scope_value with serviceLineSlug — used for "single
 *      occurrence" sections like Network and Cloud, where the engagement
 *      has at most one set of values for that driver.
 *
 * Plus the binary-trigger pattern (yes/no via valueMap), and customer_type
 * propagation from a top-level node into loop iterations.
 */

import { describe, it, expect } from 'vitest';
import {
  normaliseScope,
  type AnswersByIter,
  type Answer,
  type RateCard,
  type TemplateWithNodes,
} from '@rhud/shared';

function makeRateCard(): RateCard {
  return {
    id: 'rc',
    tenantId: 't',
    name: 'Test',
    version: 1,
    status: 'published',
    currency: 'INR',
    effectiveFrom: null,
    effectiveTo: null,
    openPricedServices: [],
    serviceLines: [
      // Legacy single-driver shape
      {
        id: 'sl_web', slug: 'vapt_web_app', displayName: 'Web App',
        scopeUnit: 'pages', pricingModel: 'tier_lookup', position: 0, tiers: [],
      },
      // Multi-driver shape (Prophaze-style)
      {
        id: 'sl_dyn', slug: 'vapt_web_app_dynamic_pages', displayName: 'Dynamic',
        scopeUnit: 'pages', pricingModel: 'per_unit', position: 1, tiers: [],
      },
      {
        id: 'sl_inf', slug: 'vapt_web_app_input_fields', displayName: 'Inputs',
        scopeUnit: 'other', pricingModel: 'per_unit', position: 2, tiers: [],
      },
      // Top-level / network slug
      {
        id: 'sl_fw', slug: 'vapt_network_firewalls', displayName: 'Firewalls',
        scopeUnit: 'devices', pricingModel: 'per_unit', position: 3, tiers: [],
      },
      // Binary IDS
      {
        id: 'sl_ids', slug: 'vapt_network_ids', displayName: 'IDS',
        scopeUnit: 'devices', pricingModel: 'flat', position: 4, tiers: [],
      },
    ],
  };
}

// Minimal node helper — only fields normaliseScope reads.
function node(over: Partial<TemplateWithNodes['nodes'][number]>): TemplateWithNodes['nodes'][number] {
  return {
    id: 'n_' + Math.random().toString(36).slice(2),
    templateId: 't',
    tenantId: 't',
    question: 'q',
    helpText: null,
    placeholder: null,
    required: false,
    nodeType: 'number',
    options: null,
    allowFiles: false,
    nextRules: [],
    position: 0,
    parentNodeId: null,
    loopConfig: null,
    binding: null,
    ...over,
  };
}

function makeTemplate(nodes: TemplateWithNodes['nodes']): TemplateWithNodes {
  return {
    id: 't', tenantId: 't', serviceLine: 'x', name: 'tpl',
    version: 1, status: 'published', rootNodeId: nodes[0]?.id ?? null,
    createdAt: '', updatedAt: '', nodes,
  };
}

describe('normaliseScope — multi-driver intake', () => {
  it('legacy single-driver loop: one entity per iteration with loopConfig slug', () => {
    const loop = node({
      id: 'loop1', nodeType: 'loop', position: 0,
      loopConfig: { mode: 'open_ended', serviceLineSlug: 'vapt_web_app' },
    });
    const body = node({
      id: 'body1', nodeType: 'number', position: 0, parentNodeId: 'loop1',
      binding: { field: 'scope_value' },
    });
    const tmpl = makeTemplate([loop, body]);
    const answers: AnswersByIter = new Map([['body1', new Map([[0, 75]])]]);

    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_web_app');
    expect(out[0]!.dimensions.pages).toBe(75);
  });

  it('loop-main: a 0 scope answer emits NO entity (P0d zero-scope guard parity)', () => {
    // Pre-fix the loop-main path lacked the `num > 0` guard the top-level and
    // driver paths have, so a "0" answer created a phantom zero-scope entity
    // that priced as a silent unmatched ₹0 line.
    const loop = node({
      id: 'loop1', nodeType: 'loop', position: 0,
      loopConfig: { mode: 'open_ended', serviceLineSlug: 'vapt_web_app' },
    });
    const body = node({
      id: 'body1', nodeType: 'number', position: 0, parentNodeId: 'loop1',
      binding: { field: 'scope_value' },
    });
    const tmpl = makeTemplate([loop, body]);
    const answers: AnswersByIter = new Map([['body1', new Map([[0, 0]])]]);
    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(0);
  });

  it('multi-driver loop: ONE iteration emits N entities, one per body slug', () => {
    const loop = node({
      id: 'loop1', nodeType: 'loop', position: 0,
      loopConfig: { mode: 'open_ended' /* no main slug */ },
    });
    const dynBody = node({
      id: 'dyn', nodeType: 'number', position: 0, parentNodeId: 'loop1',
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_dynamic_pages' },
    });
    const infBody = node({
      id: 'inf', nodeType: 'number', position: 1, parentNodeId: 'loop1',
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_input_fields' },
    });
    const tmpl = makeTemplate([loop, dynBody, infBody]);
    const answers: AnswersByIter = new Map([
      ['dyn', new Map([[0, 29]])],
      ['inf', new Map([[0, 60]])],
    ]);

    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(2);
    const bySlug = new Map(out.map((e) => [e.serviceLineSlug, e]));
    expect(bySlug.get('vapt_web_app_dynamic_pages')?.dimensions.pages).toBe(29);
    expect(bySlug.get('vapt_web_app_input_fields')?.dimensions.other).toBe(60);
  });

  it('multi-driver loop: two iterations × N drivers = 2N entities', () => {
    const loop = node({
      id: 'loop1', nodeType: 'loop', position: 0,
      loopConfig: { mode: 'open_ended' },
    });
    const dynBody = node({
      id: 'dyn', nodeType: 'number', position: 0, parentNodeId: 'loop1',
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_dynamic_pages' },
    });
    const infBody = node({
      id: 'inf', nodeType: 'number', position: 1, parentNodeId: 'loop1',
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_input_fields' },
    });
    const tmpl = makeTemplate([loop, dynBody, infBody]);
    const answers: AnswersByIter = new Map([
      ['dyn', new Map([[0, 29], [1, 50]])],
      ['inf', new Map([[0, 60], [1, 120]])],
    ]);

    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(4);
    const dynScopes = out.filter((e) => e.serviceLineSlug === 'vapt_web_app_dynamic_pages').map((e) => e.dimensions.pages).sort();
    expect(dynScopes).toEqual([29, 50]);
  });

  it('top-level scope_value with serviceLineSlug emits one entity (single-occurrence section)', () => {
    const fw = node({
      id: 'fw', nodeType: 'number', position: 0,
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_network_firewalls' },
    });
    const tmpl = makeTemplate([fw]);
    const answers: AnswersByIter = new Map([['fw', new Map([[0, 3]])]]);

    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_network_firewalls');
    expect(out[0]!.dimensions.devices).toBe(3);
  });

  it('binary trigger: valueMap yes→1 emits scope=1, no→0 emits no entity', () => {
    const idsYes = node({
      id: 'ids_y', nodeType: 'single_select', position: 0,
      binding: {
        field: 'scope_value',
        serviceLineSlug: 'vapt_network_ids',
        valueMap: { yes: '1', no: '0' },
      },
    });
    const tmpl = makeTemplate([idsYes]);

    const yesAnswers: AnswersByIter = new Map();
    yesAnswers.set('ids_y', new Map<number, Answer>([[0, 'yes']]));
    const yesOut = normaliseScope(tmpl, makeRateCard(), yesAnswers);
    expect(yesOut).toHaveLength(1);
    expect(yesOut[0]!.dimensions.devices).toBe(1);

    const noAnswers: AnswersByIter = new Map();
    noAnswers.set('ids_y', new Map<number, Answer>([[0, 'no']]));
    const noOut = normaliseScope(tmpl, makeRateCard(), noAnswers);
    expect(noOut).toHaveLength(0); // scope=0 is filtered out
  });

  it('customer_type at top-level propagates into loop iterations', () => {
    const ct = node({
      id: 'ct', nodeType: 'single_select', position: 0,
      binding: { field: 'customer_type' },
    });
    const loop = node({
      id: 'loop1', nodeType: 'loop', position: 1,
      loopConfig: { mode: 'open_ended' },
    });
    const dynBody = node({
      id: 'dyn', nodeType: 'number', position: 0, parentNodeId: 'loop1',
      binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_dynamic_pages' },
    });
    const tmpl = makeTemplate([ct, loop, dynBody]);
    const answers: AnswersByIter = new Map();
    answers.set('ct', new Map<number, Answer>([[0, 'internal']]));
    answers.set('dyn', new Map<number, Answer>([[0, 29]]));

    const out = normaliseScope(tmpl, makeRateCard(), answers);
    expect(out).toHaveLength(1);
    expect(out[0]!.customerType).toBe('internal');
  });
});
