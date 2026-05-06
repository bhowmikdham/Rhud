/**
 * Mapper LLM-path specs with a mocked LlmService.
 *
 * Exercises `RateCardFieldMapperService.inferEntities` end-to-end with
 * canned LLM responses to assert that:
 *   - Multi-app `appId` grouping survives parsing
 *   - Confidence outside [0,1] gets clamped (with logged warning)
 *   - Hallucinated slugs are dropped
 *   - Mangled JSON falls back gracefully (no entities, no crash)
 *
 * Without these specs, the LLM-path failure modes regress invisibly —
 * we'd see a 0 INR quote on a perfectly valid doc and not know why.
 */

import { describe, it, expect } from 'vitest';
import { buildProphazeRateCardFixture } from './prophaze-rate-card.fixture.js';
import { RateCardFieldMapperService } from './rate-card-mapper.service.js';

const RATE_CARD = buildProphazeRateCardFixture({
  rateCardId: 'rc-mapper-test',
  tenantId: 'tenant-test',
  ids: 'deterministic',
});

/** Tiny mocked LlmService — the mapper calls `getProviderName` to
 *  decide which path to take, then `chat` for the actual call. We
 *  return canned responses keyed by what the test sets. */
function makeMockLlm(responseText: string) {
  return {
    getProviderName: async () => 'mock' as const,
    chat: async () => ({ text: responseText }),
  } as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];
}

describe('mapper LLM path — canned responses', () => {
  it('parses multi-app response with appIds preserved', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'web_app_1' },
        { serviceLineSlug: 'vapt_web_app_input_fields', scopeValue: 60, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'web_app_1' },
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 50, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'web_app_2' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(3);
    expect(out.filter((e) => e.appId === 'web_app_1')).toHaveLength(2);
    expect(out.filter((e) => e.appId === 'web_app_2')).toHaveLength(1);
  });

  it('clamps confidence > 1 to 1.0', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, customerType: 'external', confidence: 1.5, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(1);
  });

  it('clamps negative confidence to 0 (entity drops below threshold)', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, customerType: 'external', confidence: -0.5, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    // Confidence becomes 0 → still emitted but below the 0.6 threshold.
    // toScopedEntities will filter it out at quote time.
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBe(0);
  });

  it('drops hallucinated slugs (not in rate card) silently', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
        { serviceLineSlug: 'vapt_completely_made_up', scopeValue: 5, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_api_endpoints');
  });

  it('drops zero-scope entities', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 0, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 23, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
    expect(out[0]!.scopeValue).toBe(23);
  });

  it('handles markdown-fenced JSON', async () => {
    const llm = makeMockLlm(
      '```json\n{"entities":[{"serviceLineSlug":"vapt_api_endpoints","scopeValue":23,"customerType":"external","confidence":0.9,"reasoning":"","sourceQuote":""}]}\n```',
    );
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
  });

  it('falls back to heuristic when LLM returns mangled JSON', async () => {
    const llm = makeMockLlm('this is definitely not JSON at all');
    const mapper = new RateCardFieldMapperService(llm);
    // Heuristic gates on slug-mention; with this minimal point set it
    // produces no entities. The key assertion: no crash.
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(Array.isArray(out)).toBe(true);
  });

  it('falls back to heuristic when LLM returns empty entities array', async () => {
    const llm = makeMockLlm(JSON.stringify({ entities: [] }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    // Heuristic should pick up firewalls × 5 from the keyword gate.
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((e) => e.serviceLineSlug === 'vapt_network_firewalls')).toBe(true);
    expect(out.every((e) => e.source === 'heuristic')).toBe(true);
  });

  // ── New behaviour: heuristic suppression when LLM succeeds ─────────────
  // (Tier 1 of majestic-whistling-whistle.md — kills the spurious heuristic
  //  rows that contaminated the user's screenshot.)

  it('suppresses heuristic entirely when LLM returned ≥1 entity', async () => {
    // The LLM emits one good entity. The doc ALSO contains a string the
    // heuristic would over-match — but because the LLM succeeded, the
    // heuristic must NOT run. This is the regression net for the
    // sca-matches-scope and roles-stuffed-with-23-from-apis bugs.
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [
        { key: 'how_many_dynamic_pages', label: 'How many dynamic pages?', value: '29' },
        // Pre-fix, these would each trigger spurious heuristic emissions:
        { key: 'scope_url', label: 'Scope URL', value: 'https://staging.example.com' },
        { key: 'firewalls', label: 'Firewalls in scope', value: '5' },
        { key: 'iam_in_scope', label: 'IAM in scope', value: 'Yes' },
      ],
      RATE_CARD,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_web_app_dynamic_pages');
    expect(out[0]!.source).toBe('llm');
    // Crucially: no heuristic rows appended.
    expect(out.every((e) => e.source === 'llm')).toBe(true);
  });

  it('still runs heuristic fallback when LLM returns zero entities', async () => {
    // Symmetric case: LLM legitimately returns nothing → heuristic must
    // still take over, otherwise we'd silently emit no entities at all
    // when the LLM is conservative.
    const llm = makeMockLlm(JSON.stringify({ entities: [] }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => e.source === 'heuristic')).toBe(true);
  });

  // ── New behaviour: `considered` array gates heuristic backfill ─────────

  it('parses considered array and uses it to gate heuristic when LLM zero-emits', async () => {
    // LLM returns no entities BUT explicitly lists firewalls in
    // `considered` with reason="negated". The heuristic would otherwise
    // pick up firewalls=5 via the keyword gate; the `considered` signal
    // should suppress that backfill.
    const llm = makeMockLlm(JSON.stringify({
      entities: [],
      considered: [
        { serviceLineSlug: 'vapt_network_firewalls', reason: 'negated' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    // Without `considered`, heuristic would emit firewalls=5. With it,
    // the LLM's "no" is honoured.
    expect(out.find((e) => e.serviceLineSlug === 'vapt_network_firewalls')).toBeUndefined();
  });

  it('ignores considered entries with unknown slugs', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [],
      considered: [
        { serviceLineSlug: 'totally_made_up_slug', reason: 'negated' },
        { serviceLineSlug: 'vapt_network_firewalls', reason: 'negated' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    // Hallucinated slugs in `considered` are filtered (slugs not in the
    // rate card don't exist to suppress in the first place); valid
    // suppressions still apply.
    expect(out.find((e) => e.serviceLineSlug === 'vapt_network_firewalls')).toBeUndefined();
  });

  it('handles missing considered field gracefully (legacy LLM responses)', async () => {
    // Older mocks / smaller models may not include `considered`. The
    // mapper must still work — heuristic fallback runs unguarded.
    const llm = makeMockLlm(JSON.stringify({ entities: [] }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    expect(out.some((e) => e.serviceLineSlug === 'vapt_network_firewalls')).toBe(true);
  });

  it('treats malformed considered field as empty', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [],
      considered: 'not-an-array',
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    expect(out.some((e) => e.serviceLineSlug === 'vapt_network_firewalls')).toBe(true);
  });
});
