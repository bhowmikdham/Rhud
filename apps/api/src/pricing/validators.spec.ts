/**
 * Unit tests for the publish-time validators introduced as part of the
 * P0 critique fixes:
 *   - findOverlappingTiers (pricing.service.ts) — flags tier-overlap
 *     within a (serviceLine, methodology, customerType) bucket so the
 *     publish endpoint refuses order-dependent rate cards.
 *   - validateTemplate's `loop_body_slug_collision` issue (engine.ts)
 *     — flags templates where a loop's main slug also appears on a
 *     body-node binding, causing the pricing engine to double-emit the
 *     entity for that iteration.
 */

import { describe, it, expect } from 'vitest';
import { validateTemplate, type RateCard, type TemplateWithNodes } from '@rhud/shared';
import { findOverlappingTiers } from './pricing.service.js';

function tier(over: { rangeMin: number; rangeMax: number | null; methodology?: string | null; customerType?: 'internal' | 'external' }) {
  return {
    id: `t-${over.rangeMin}`,
    rangeMin: over.rangeMin,
    rangeMax: over.rangeMax,
    methodology: over.methodology ?? null,
    customerType: over.customerType ?? 'external' as const,
    priceCents: 1000,
    displayLabel: null,
  };
}

function card(tiers: ReturnType<typeof tier>[]): RateCard {
  return {
    id: 'rc', tenantId: 't',
    name: 'test', version: 1, status: 'draft', currency: 'INR',
    effectiveFrom: null, effectiveTo: null, openPricedServices: [],
    serviceLines: [
      {
        id: 'sl', slug: 'vapt_x', displayName: 'X',
        scopeUnit: 'pages', pricingModel: 'tier_lookup', position: 0,
        tiers,
      },
    ],
  };
}

describe('findOverlappingTiers', () => {
  it('returns empty array when tiers are sequential and non-overlapping', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: 10 }),
      tier({ rangeMin: 11, rangeMax: 50 }),
      tier({ rangeMin: 51, rangeMax: null }),
    ]);
    expect(findOverlappingTiers(c)).toEqual([]);
  });

  it('flags two tiers with overlapping ranges in same bucket', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: 50 }),
      tier({ rangeMin: 25, rangeMax: 100 }),
    ]);
    const overlaps = findOverlappingTiers(c);
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]!.serviceLineSlug).toBe('vapt_x');
    expect(overlaps[0]!.a.rangeMin).toBe(1);
    expect(overlaps[0]!.b.rangeMin).toBe(25);
  });

  it('does NOT flag tiers in different methodology buckets even if ranges overlap', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: 50, methodology: 'black_box' }),
      tier({ rangeMin: 1, rangeMax: 50, methodology: 'grey_box' }),
    ]);
    expect(findOverlappingTiers(c)).toEqual([]);
  });

  it('does NOT flag tiers in different customerType buckets', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: 50, customerType: 'external' }),
      tier({ rangeMin: 1, rangeMax: 50, customerType: 'internal' }),
    ]);
    expect(findOverlappingTiers(c)).toEqual([]);
  });

  it('flags overlap with open-ended (null rangeMax) tier', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: null }),
      tier({ rangeMin: 50, rangeMax: 100 }),
    ]);
    expect(findOverlappingTiers(c)).toHaveLength(1);
  });

  it('flags multiple overlap pairs', () => {
    const c = card([
      tier({ rangeMin: 1, rangeMax: 50 }),
      tier({ rangeMin: 25, rangeMax: 75 }),
      tier({ rangeMin: 60, rangeMax: 100 }),
    ]);
    // (1-50, 25-75) overlap; (25-75, 60-100) overlap; (1-50, 60-100) don't
    expect(findOverlappingTiers(c)).toHaveLength(2);
  });
});

describe('validateTemplate — loop_body_slug_collision', () => {
  function tmpl(nodes: TemplateWithNodes['nodes']): TemplateWithNodes {
    return {
      id: 't', tenantId: 't', serviceLine: 'x', name: 'tpl',
      version: 1, status: 'draft', rootNodeId: nodes[0]?.id ?? null,
      createdAt: '', updatedAt: '', nodes,
    };
  }
  function node(over: Partial<TemplateWithNodes['nodes'][number]>): TemplateWithNodes['nodes'][number] {
    return {
      id: over.id ?? 'n', templateId: 't', tenantId: 't',
      question: over.question ?? 'q',
      helpText: null, placeholder: null, required: true,
      nodeType: over.nodeType ?? 'number',
      options: null, allowFiles: false,
      nextRules: over.nextRules ?? [{ when: { op: 'always' }, goto: 'END' }],
      position: over.position ?? 0,
      parentNodeId: over.parentNodeId ?? null,
      loopConfig: over.loopConfig ?? null,
      binding: over.binding ?? null,
    };
  }

  it('flags when loopConfig.serviceLineSlug == body binding.serviceLineSlug', () => {
    const t = tmpl([
      node({
        id: 'loop',
        nodeType: 'loop',
        loopConfig: { mode: 'open_ended', serviceLineSlug: 'vapt_web_app' },
      }),
      node({
        id: 'body',
        parentNodeId: 'loop',
        binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app' },
      }),
    ]);
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'loop_body_slug_collision')).toBe(true);
  });

  it('does NOT flag when slugs differ (multi-driver intake)', () => {
    const t = tmpl([
      node({
        id: 'loop',
        nodeType: 'loop',
        loopConfig: { mode: 'open_ended', serviceLineSlug: 'vapt_web_app' },
      }),
      node({
        id: 'body',
        parentNodeId: 'loop',
        binding: { field: 'scope_value', serviceLineSlug: 'vapt_web_app_input_fields' },
      }),
    ]);
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'loop_body_slug_collision')).toBe(false);
  });

  it('does NOT flag when body has no serviceLineSlug binding (legacy single-driver)', () => {
    const t = tmpl([
      node({
        id: 'loop',
        nodeType: 'loop',
        loopConfig: { mode: 'open_ended', serviceLineSlug: 'vapt_web_app' },
      }),
      node({
        id: 'body',
        parentNodeId: 'loop',
        binding: { field: 'scope_value' },
      }),
    ]);
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'loop_body_slug_collision')).toBe(false);
  });
});
