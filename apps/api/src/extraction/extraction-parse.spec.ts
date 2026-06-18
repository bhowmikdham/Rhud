import { describe, expect, it } from 'vitest';
import { ExtractionService } from './extraction.service.js';
import type { ChatMessage, ChatOptions, ChatResult } from '../llm/llm.types.js';

/**
 * Direct coverage of the extraction-side malformed-JSON fix (the MedTech bug):
 * `parsePointsResponse` (now repair-backed) and `runLlmExtractionOnChunk` (the
 * re-draw loop, structuredOutputApplied handling, and the draw-variation on
 * retry). We reach the private methods via a thin subclass — they only touch
 * `this.logger` (a field initializer) and the injected `llm`, so the other
 * constructor deps are safe to pass as null, exactly like the email-extractor
 * spec does.
 */
type ChatFn = (tenantId: string, messages: ChatMessage[], opts: ChatOptions) => Promise<ChatResult>;

class Probe extends ExtractionService {
  constructor(chat: ChatFn) {
    const llm = { chat } as unknown as ConstructorParameters<typeof ExtractionService>[3];
    super(
      null as never, null as never, null as never,
      llm,
      null as never, null as never, null as never, null as never, null as never,
    );
  }
  parse(raw: string) {
    return (this as unknown as { parsePointsResponse(r: string): unknown[] }).parsePointsResponse(raw);
  }
  runChunk(text: string) {
    return (this as unknown as {
      runLlmExtractionOnChunk(t: string, q: unknown[], c: string): Promise<unknown[]>;
    }).runLlmExtractionOnChunk('t', [], text);
  }
}

/** Returns a chat fn that yields the canned responses in sequence (last repeats)
 *  and records the opts of every call. */
function seqChat(responses: Array<Partial<ChatResult> & { text: string }>) {
  const calls: ChatOptions[] = [];
  let i = 0;
  const chat: ChatFn = async (_t, _m, opts) => {
    calls.push(opts);
    const r = responses[Math.min(i, responses.length - 1)]!;
    i++;
    return r as ChatResult;
  };
  return { chat, calls };
}

describe('ExtractionService.parsePointsResponse', () => {
  const probe = new Probe(async () => ({ text: '' }));

  it('parses a clean response', () => {
    const pts = probe.parse('{"points":[{"key":"team","value":"40"}]}') as Array<{ key: string }>;
    expect(pts).toHaveLength(1);
    expect(pts[0]!.key).toBe('team');
  });

  it('recovers a malformed-but-repairable response instead of dropping the chunk', () => {
    // A raw newline inside a verbatim sourceQuote — the unconstrained-Gemini shape.
    const pts = probe.parse('{"points":[{"key":"a","value":"line1\nline2","sourceQuote":"x"}]}') as unknown[];
    expect(pts).toHaveLength(1);
  });

  it('throws llm_response_not_json on an unrecoverable response (→ structured fallback)', () => {
    expect(() => probe.parse('the model produced no JSON whatsoever')).toThrow('llm_response_not_json');
  });
});

describe('ExtractionService.runLlmExtractionOnChunk', () => {
  it('returns points in ONE call when the response is clean', async () => {
    const { chat, calls } = seqChat([
      { text: '{"points":[{"key":"team","value":"40"}]}', structuredOutputApplied: true },
    ]);
    const out = await new Probe(chat).runChunk('doc');
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('RECOVERS via repair in one call even when the schema was stripped (the MedTech path)', async () => {
    // structuredOutputApplied=false ⇒ provider fell back to unconstrained, and the
    // JSON is malformed (trailing comma). The fix must still extract the point.
    const { chat, calls } = seqChat([
      { text: '{"points":[{"key":"net","value":"5 firewalls"},]}', structuredOutputApplied: false },
    ]);
    const out = await new Probe(chat).runChunk('doc');
    expect(out).toHaveLength(1);
    expect(calls).toHaveLength(1); // repaired in place — no wasted re-draw
  });

  it('varies the draw on re-draw and throws after EXTRACTION_PARSE_ATTEMPTS on persistent garbage', async () => {
    const { chat, calls } = seqChat([{ text: 'no json here at all, sorry' }]);
    await expect(new Probe(chat).runChunk('doc')).rejects.toThrow();
    expect(calls).toHaveLength(3); // EXTRACTION_PARSE_ATTEMPTS
    // Attempt 1 is deterministic (seed, temp 0); retries warm up + drop the seed
    // so a re-draw can actually differ (the deterministic-repeat fix).
    expect(calls[0]!.temperature).toBe(0);
    expect(calls[0]!.seed).toBe(1);
    expect(calls[1]!.temperature).toBeGreaterThan(0);
    expect(calls[1]!.seed).toBeUndefined();
  });
});
