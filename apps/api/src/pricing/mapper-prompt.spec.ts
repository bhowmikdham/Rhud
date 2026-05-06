/**
 * Mapper prompt-synthesis specs.
 *
 * Two things to lock in:
 *  1. `synthesizeDefaultHint` produces a usable instruction for any
 *     RateCardServiceLine when its `inferenceHint` is missing — older
 *     rate cards keep working without a one-time data fill.
 *  2. The user prompt the mapper sends to the LLM includes the
 *     tenant-authored ontology (DOMAIN CONTEXT, DEFAULT METHODOLOGY
 *     RULE, per-slug `emit when` lines, worked examples) — i.e. the
 *     mapper actually USES the rate card's inference fields rather
 *     than ignoring them. This is the regression net for the Tier 2
 *     rate-card-driven refactor.
 */

import { describe, it, expect } from 'vitest';
import type { RateCardServiceLine } from '@rhud/shared';
import {
  RateCardFieldMapperService,
  synthesizeDefaultHint,
} from './rate-card-mapper.service.js';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';

const RATE_CARD = buildProphazeRateCardFixture({
  rateCardId: 'rc-prompt-test',
  tenantId: 'tenant-test',
  ids: 'deterministic',
});

/**
 * Capture the user-prompt the mapper sends to the LLM by stubbing
 * `chat()` and snapshotting the second message. Returning entities=[] +
 * considered=[] keeps the mapper happy while we inspect the prompt.
 */
function makeCapturingLlm() {
  let captured: string | null = null;
  const llm = {
    getProviderName: async () => 'mock' as const,
    chat: async (_tenant: string, messages: { role: string; content: string }[]) => {
      // The mapper sends [system, user]. We only care about the user
      // message — that's where the rate-card-derived ontology lives.
      const userMsg = messages.find((m) => m.role === 'user');
      captured = userMsg?.content ?? null;
      return { text: JSON.stringify({ entities: [], considered: [] }) };
    },
  } as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];
  return {
    llm,
    getCaptured: () => captured,
  };
}

describe('synthesizeDefaultHint', () => {
  it('emits a non-empty instruction for any well-formed service line', () => {
    for (const sl of RATE_CARD.serviceLines) {
      const hint = synthesizeDefaultHint(sl);
      expect(hint.length).toBeGreaterThan(20);
      // Must reference the displayName so the LLM knows what slug it's
      // about — stripping that would defeat the purpose.
      expect(hint).toContain(sl.displayName);
    }
  });

  it('flags white-box-only lines explicitly', () => {
    const wbLine = RATE_CARD.serviceLines.find((s) => s.slug === 'vapt_web_app_source_code_backend')!;
    // Source-code lines have only white_box tiers.
    const hint = synthesizeDefaultHint(wbLine);
    expect(hint.toLowerCase()).toContain('white-box');
    expect(hint.toLowerCase()).toContain('explicitly');
  });

  it('handles a minimal service line with no methodologies (cleaning-domain shape)', () => {
    // Simulate a non-cybersec rate card slug: per-unit, methodology
    // axis empty. The synthesiser should still produce something useful.
    const cleaningLike: RateCardServiceLine = {
      id: 'sl-test',
      slug: 'deep_clean_residential',
      displayName: 'Deep Clean — Residential',
      scopeUnit: 'other',
      pricingModel: 'per_unit',
      position: 0,
      tiers: [
        { id: 't0', rangeMin: 1, rangeMax: 99999, methodology: null, customerType: 'external', priceCents: 100 },
      ],
    };
    const hint = synthesizeDefaultHint(cleaningLike);
    expect(hint).toContain('Deep Clean — Residential');
    // No "white-box" mention since the line has no white_box tiers.
    expect(hint.toLowerCase()).not.toContain('white-box');
  });
});

describe('mapper user-prompt composition (Tier 2)', () => {
  it('includes DOMAIN CONTEXT block from rate card when populated', async () => {
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('DOMAIN CONTEXT:');
    expect(prompt!.toLowerCase()).toContain('cybersecurity');
  });

  it('includes DEFAULT METHODOLOGY RULE from rate card', async () => {
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('DEFAULT METHODOLOGY RULE:');
    expect(prompt!.toLowerCase()).toContain('black_box');
    expect(prompt!.toLowerCase()).toContain('grey_box');
  });

  it('includes a per-slug "emit when" line for every service line', async () => {
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    // Every slug must appear with its "emit when" hint.
    for (const sl of RATE_CARD.serviceLines) {
      expect(prompt!).toContain(`slug=${sl.slug}`);
    }
    // The "emit when:" tag itself is what the LLM keys on.
    expect(prompt!).toContain('emit when:');
  });

  it('passes the original question label (not just snake_case key) to the LLM', async () => {
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities(
      't',
      [
        {
          key: 'how_many_dynamic_pages_are_being_assessed_approximate',
          label: 'How many dynamic pages are being assessed (approximate)?',
          value: '29',
        },
      ],
      RATE_CARD,
    );
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    // The full original question must appear so the LLM doesn't have to
    // back-translate snake_case.
    expect(prompt!).toContain('How many dynamic pages are being assessed (approximate)?');
  });

  it('renders tenant-authored worked examples under "WORKED EXAMPLES"', async () => {
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    expect(prompt!).toContain('WORKED EXAMPLES');
    // The Prophaze fixture's Admin/Read-only example should be in there.
    expect(prompt!.toLowerCase()).toContain('admin, read-only');
  });

  it('falls back to synthesized hint for slugs without authored inferenceHint', async () => {
    // Strip all per-slug hints and re-run — the prompt should still
    // contain "emit when:" lines for every slug (synthesized).
    const stripped = {
      ...RATE_CARD,
      serviceLines: RATE_CARD.serviceLines.map((sl) => ({ ...sl, inferenceHint: null, inferenceExamples: [] })),
    };
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], stripped);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    // Synthesized hints reference the displayName.
    for (const sl of stripped.serviceLines) {
      expect(prompt!).toContain(sl.displayName);
    }
  });

  it('omits DOMAIN CONTEXT block when rate card has no inferenceContext', async () => {
    const stripped = { ...RATE_CARD, inferenceContext: null };
    const cap = makeCapturingLlm();
    const mapper = new RateCardFieldMapperService(cap.llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], stripped);
    const prompt = cap.getCaptured();
    expect(prompt).not.toBeNull();
    expect(prompt!).not.toContain('DOMAIN CONTEXT:');
    // Slug ontology must still be present.
    expect(prompt!).toContain('SERVICE LINES:');
  });
});
