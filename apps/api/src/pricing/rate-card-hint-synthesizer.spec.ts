/**
 * RateCardHintSynthesizerService specs.
 *
 * The synthesiser is what makes the system handle ANY new rate card
 * without us hand-authoring hints first. It calls the LLM once per
 * rate-card creation and parses the response into the
 * inferenceContext / defaultMethodologyRule / inferenceExamples /
 * per-slug inferenceHint fields. These specs lock in:
 *
 *   - A well-formed LLM response is parsed correctly.
 *   - Hints for slugs that don't exist in the rate card are dropped.
 *   - Malformed JSON is handled gracefully (returns null, no crash).
 *   - When LlmService isn't injected, synthesize() returns null
 *     (the rate card still saves, just without authored hints).
 *   - When the tenant's LLM provider isn't configured, returns null.
 */

import { describe, it, expect } from 'vitest';
import {
  RateCardHintSynthesizerService,
  type SynthesiserInput,
} from './rate-card-hint-synthesizer.service.js';

const TEST_INPUT: SynthesiserInput = {
  name: 'Acme Cleaning Services Rate Card',
  serviceLines: [
    { slug: 'deep_clean_residential', displayName: 'Deep Clean — Residential', scopeUnit: 'other', methodologies: [] },
    { slug: 'office_pest_control',     displayName: 'Office Pest Control',     scopeUnit: 'devices', methodologies: [] },
  ],
};

function makeMockLlm(responseText: string) {
  return {
    getProviderName: async () => 'mock' as const,
    chat: async () => ({ text: responseText }),
  } as unknown as ConstructorParameters<typeof RateCardHintSynthesizerService>[0];
}

describe('RateCardHintSynthesizerService', () => {
  it('returns null when no LlmService is injected', async () => {
    const svc = new RateCardHintSynthesizerService();
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('returns null when tenant has no LLM provider configured', async () => {
    const llm = {
      getProviderName: async () => null,
      chat: async () => ({ text: '' }),
    } as unknown as ConstructorParameters<typeof RateCardHintSynthesizerService>[0];
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('returns null when tenant provider is "manual" (LLM disabled)', async () => {
    const llm = {
      getProviderName: async () => 'manual' as const,
      chat: async () => ({ text: '' }),
    } as unknown as ConstructorParameters<typeof RateCardHintSynthesizerService>[0];
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('parses a well-formed LLM response into the ontology shape', async () => {
    const llm = makeMockLlm(JSON.stringify({
      inferenceContext: 'B2B commercial cleaning engagements. Single-occurrence service lines.',
      defaultMethodologyRule: 'No methodology axis — leave methodology=null for every entity.',
      inferenceExamples: ['"3,500 sq ft residential" → deep_clean_residential scope=3500'],
      hints: {
        deep_clean_residential: 'Emit when doc names sq ft of residential property.',
        office_pest_control: 'Emit when doc names a count of pest-control devices/traps.',
      },
    }));
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).not.toBeNull();
    expect(out!.inferenceContext).toContain('cleaning');
    expect(out!.defaultMethodologyRule).toContain('No methodology axis');
    expect(out!.inferenceExamples).toHaveLength(1);
    expect(out!.hints.get('deep_clean_residential')).toContain('sq ft');
    expect(out!.hints.get('office_pest_control')).toContain('pest-control');
  });

  it('drops hints for slugs that are not in the rate card', async () => {
    const llm = makeMockLlm(JSON.stringify({
      inferenceContext: 'ctx',
      defaultMethodologyRule: 'rule',
      inferenceExamples: [],
      hints: {
        deep_clean_residential: 'valid hint',
        // The LLM hallucinated a slug that doesn't exist:
        invented_slug_lol: 'should be dropped',
      },
    }));
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out!.hints.has('deep_clean_residential')).toBe(true);
    expect(out!.hints.has('invented_slug_lol')).toBe(false);
  });

  it('drops empty / non-string hint values', async () => {
    const llm = makeMockLlm(JSON.stringify({
      inferenceContext: 'ctx',
      defaultMethodologyRule: 'rule',
      hints: {
        deep_clean_residential: 'valid',
        office_pest_control: '',     // empty
      },
    }));
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out!.hints.has('deep_clean_residential')).toBe(true);
    expect(out!.hints.has('office_pest_control')).toBe(false);
  });

  it('handles markdown-fenced JSON', async () => {
    const llm = makeMockLlm(
      '```json\n' +
      JSON.stringify({
        inferenceContext: 'ctx',
        defaultMethodologyRule: 'rule',
        hints: { deep_clean_residential: 'h' },
      }) +
      '\n```',
    );
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).not.toBeNull();
    expect(out!.hints.size).toBe(1);
  });

  it('falls back to substring extraction when JSON has trailing/leading text', async () => {
    const llm = makeMockLlm(
      'Here is the ontology you requested:\n' +
      JSON.stringify({
        inferenceContext: 'ctx',
        hints: { deep_clean_residential: 'h' },
      }) +
      '\nHope that helps!',
    );
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).not.toBeNull();
    expect(out!.hints.size).toBe(1);
  });

  it('returns null on completely mangled JSON', async () => {
    const llm = makeMockLlm('this is not json at all');
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('returns null when the response is empty', async () => {
    const llm = makeMockLlm('');
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('returns null when ontology has neither context nor hints', async () => {
    const llm = makeMockLlm(JSON.stringify({
      inferenceContext: '',
      defaultMethodologyRule: '',
      inferenceExamples: [],
      hints: {},
    }));
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('returns null when LLM throws (rate limit, timeout, etc.)', async () => {
    const llm = {
      getProviderName: async () => 'mock' as const,
      chat: async () => { throw new Error('429 rate limit'); },
    } as unknown as ConstructorParameters<typeof RateCardHintSynthesizerService>[0];
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out).toBeNull();
  });

  it('caps hint length at 600 chars (defensive against runaway LLM output)', async () => {
    const longHint = 'x'.repeat(2_000);
    const llm = makeMockLlm(JSON.stringify({
      inferenceContext: 'ctx',
      hints: { deep_clean_residential: longHint },
    }));
    const svc = new RateCardHintSynthesizerService(llm);
    const out = await svc.synthesize('t', TEST_INPUT);
    expect(out!.hints.get('deep_clean_residential')!.length).toBeLessThanOrEqual(600);
  });
});
