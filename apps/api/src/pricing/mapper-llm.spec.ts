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

/** Mock that returns a SEQUENCE of responses (the last one repeats once the
 *  list is exhausted) and counts how many times `chat` was invoked — used to
 *  assert the malformed-JSON re-draw loop in `llmInfer`. */
function makeSeqLlm(responses: string[]) {
  const calls = { count: 0 };
  let i = 0;
  const llm = {
    getProviderName: async () => 'mock' as const,
    chat: async () => {
      calls.count++;
      const text = responses[Math.min(i, responses.length - 1)]!;
      i++;
      return { text };
    },
  } as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];
  return { llm, calls };
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

  it('drops a web app\'s consumed-API endpoints when the API is scoped standalone (dedup)', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        // Standalone API instance (the real API).
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '~91 REST endpoints', appId: 'api_qms_backend' },
        // Web app that CONSUMES that API: its own pages + a DUPLICATE api_endpoints.
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'qms_web' },
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 91, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: 'uses the QMS backend API ~91 endpoints', appId: 'qms_web' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    const api = out.filter((e) => e.serviceLineSlug === 'vapt_api_endpoints');
    expect(api).toHaveLength(1); // the web app's duplicate is dropped
    expect(api[0]!.appId).toBe('api_qms_backend'); // the standalone API survives
    // the web app's own pages are untouched
    expect(out.some((e) => e.serviceLineSlug === 'vapt_web_app_dynamic_pages' && e.appId === 'qms_web')).toBe(true);
  });

  it('keeps a web app\'s api_endpoints when NO standalone API is scoped (only record)', async () => {
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 44, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'qms_web' },
        { serviceLineSlug: 'vapt_api_endpoints', scopeValue: 30, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '', appId: 'qms_web' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out.filter((e) => e.serviceLineSlug === 'vapt_api_endpoints')).toHaveLength(1);
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

  it('rounds a fractional scopeValue to an integer count (scope can\'t be half a unit)', async () => {
    // If structured output was stripped the model can emit a float; a count must
    // be a whole number before it feeds pickTier ranges / Math.round(price×scope).
    const llm = makeMockLlm(JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 10.5, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
      ],
    }));
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
    expect(Number.isInteger(out[0]!.scopeValue)).toBe(true);
    expect(out[0]!.scopeValue).toBe(11); // Math.round(10.5)
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

  // ── Malformed-JSON repair + re-draw (gg / Link-18 under-quote fix) ─────
  // A thinking model intermittently emits broken JSON. Before the re-draw a
  // single bad draw dropped the whole call to the heuristic (and the cache
  // froze that degraded quote). jsonrepair now recovers SYNTACTIC breaks on the
  // first draw (no wasted call); the re-draw loop remains the safety net for
  // draws that repair can't turn into usable entities.

  it('RECOVERS a syntactically-broken draw via jsonrepair WITHOUT a re-draw', async () => {
    // Valid content (real slug, real scope) but a missing comma between fields
    // — exactly the per-draw structural fault jsonrepair fixes. The old code
    // would have dropped this to the heuristic and burned a second LLM call.
    const broken =
      '{"entities":[{"serviceLineSlug":"vapt_web_app_dynamic_pages" "scopeValue":29,' +
      '"customerType":"external","confidence":0.9,"reasoning":"","sourceQuote":""}]}';
    const { llm, calls } = makeSeqLlm([broken]);
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(calls.count).toBe(1); // repaired in place — no re-draw needed
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_web_app_dynamic_pages');
    expect(out[0]!.source).toBe('llm'); // recovered the LLM mapping, NOT the heuristic
  });

  it('re-draws when the first draw is unrepairable, then RECOVERS the clean draw', async () => {
    const valid = JSON.stringify({
      entities: [
        { serviceLineSlug: 'vapt_web_app_dynamic_pages', scopeValue: 29, customerType: 'external', confidence: 0.9, reasoning: '', sourceQuote: '' },
      ],
    });
    // First draw carries no recoverable object structure (repair yields a bare
    // string → no `entities` field → re-drawable); second is clean.
    const { llm, calls } = makeSeqLlm(['the model declined to answer', valid]);
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(calls.count).toBe(2); // re-drew once, then succeeded
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_web_app_dynamic_pages');
    expect(out[0]!.source).toBe('llm');
  });

  it('drops a truncated trailing entity (fabricated scopeValue) instead of pricing it', async () => {
    // finish_reason=length cut the 2nd entity mid-scopeValue; jsonrepair completes
    // it to a valid-but-WRONG number (6, when the real value was cut off). The
    // leading entity (scope 29) was emitted in full and is trustworthy. The fix
    // must keep the first and DROP the reconstructed second so we never price a
    // fabricated count.
    const truncated =
      '{"entities":[' +
      '{"serviceLineSlug":"vapt_web_app_dynamic_pages","scopeValue":29,"customerType":"external","confidence":0.9,"reasoning":"","sourceQuote":""},' +
      '{"serviceLineSlug":"vapt_web_app_input_fields","customerType":"external","confidence":0.9,"scopeValue":6';
    let calls = 0;
    const llm = {
      getProviderName: async () => 'mock' as const,
      chat: async () => {
        calls++;
        return { text: truncated, finishReason: 'length' };
      },
    } as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(out).toHaveLength(1);
    expect(out[0]!.serviceLineSlug).toBe('vapt_web_app_dynamic_pages');
    expect(out[0]!.scopeValue).toBe(29);
    // No 6-page input_fields line should survive.
    expect(out.some((e) => e.serviceLineSlug === 'vapt_web_app_input_fields')).toBe(false);
  });

  it('does NOT price a fabricated count when a SINGLE entity is truncated (repair-whole)', async () => {
    // No complete object brace survives → repair-whole reconstructs the lone
    // entity with a cut-off scopeValue. The fix must refuse to price it (drop →
    // re-draw → heuristic), never emit the fabricated number.
    const truncated =
      '{"entities":[{"serviceLineSlug":"vapt_web_app_dynamic_pages","customerType":"external","confidence":0.9,"scopeValue":2';
    let calls = 0;
    const llm = {
      getProviderName: async () => 'mock' as const,
      chat: async () => {
        calls++;
        return { text: truncated, finishReason: 'length' };
      },
    } as unknown as ConstructorParameters<typeof RateCardFieldMapperService>[0];
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    // The lone fabricated entity is dropped; heuristic finds nothing for k/v.
    expect(out.every((e) => e.source !== 'llm')).toBe(true);
    expect(out.some((e) => e.scopeValue === 2)).toBe(false);
  });

  it('exhausts re-draws on PERSISTENT malformed JSON, then falls back to heuristic', async () => {
    const { llm, calls } = makeSeqLlm(['still not valid json']);
    const mapper = new RateCardFieldMapperService(llm);
    const out = await mapper.inferEntities(
      't',
      [{ key: 'firewalls', label: 'Firewalls in scope', value: '5' }],
      RATE_CARD,
    );
    expect(calls.count).toBe(3); // MAPPER_PARSE_ATTEMPTS draws before giving up
    // The throw was caught and the heuristic took over (firewalls × 5).
    expect(out.some((e) => e.serviceLineSlug === 'vapt_network_firewalls' && e.source === 'heuristic')).toBe(true);
  });

  it('does NOT re-draw a VALID empty response (doc genuinely maps nothing)', async () => {
    const { llm, calls } = makeSeqLlm([JSON.stringify({ entities: [] })]);
    const mapper = new RateCardFieldMapperService(llm);
    await mapper.inferEntities('t', [{ key: 'k', value: 'v' }], RATE_CARD);
    expect(calls.count).toBe(1); // clean parse → returned immediately, no re-draw
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
