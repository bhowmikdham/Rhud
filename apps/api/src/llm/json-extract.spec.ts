import { describe, expect, it } from 'vitest';
import { parseLlmJson, LlmJsonParseError, stripCodeFences } from './json-extract.js';

describe('parseLlmJson', () => {
  describe('clean input — never altered, reported as strict', () => {
    it('parses a well-formed object', () => {
      const r = parseLlmJson('{"points":[{"key":"a","value":"1"}]}');
      expect(r.via).toBe('strict');
      expect((r.value as { points: unknown[] }).points).toHaveLength(1);
    });

    it('preserves data exactly for valid JSON containing quotes and braces in strings', () => {
      // A `}` inside a properly-escaped string must NOT trip the repair path.
      const raw = '{"points":[{"key":"snippet","value":"function() { return \\"x\\"; }"}]}';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('strict');
      expect((r.value as { points: Array<{ value: string }> }).points[0]!.value).toBe(
        'function() { return "x"; }',
      );
    });
  });

  describe('structural noise — recovered without repair', () => {
    it('strips ```json fences (substring or strict)', () => {
      const r = parseLlmJson('```json\n{"points":[]}\n```');
      expect(['strict', 'substring']).toContain(r.via);
      expect((r.value as { points: unknown[] }).points).toEqual([]);
    });

    it('drops a prose preamble (substring) — NOT array-wrapped by repair', () => {
      const r = parseLlmJson('Here is the JSON you asked for:\n{"points":[{"key":"a","value":"1"}]}');
      expect(r.via).toBe('substring');
      // Regression guard: jsonrepair would wrap prose+json into an ARRAY, losing
      // `.points`. Substring extraction must run first.
      expect(Array.isArray(r.value)).toBe(false);
      expect((r.value as { points: unknown[] }).points).toHaveLength(1);
    });
  });

  describe('malformed JSON — recovered via jsonrepair (the Gemini bug)', () => {
    it('escapes a simple unescaped inner quote in a value', () => {
      // Gemini, unconstrained, echoes verbatim cell text with raw quotes.
      const raw = '{"points":[{"key":"apps","value":"2 Apps "Health Worker" Andriod"}]}';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('repair');
      expect((r.value as { points: Array<{ value: string }> }).points[0]!.value).toContain('Health');
    });

    it('handles a raw newline inside a string value', () => {
      const r = parseLlmJson('{"points":[{"key":"a","value":"line1\nline2"}]}');
      expect(r.via).toBe('repair');
      expect((r.value as { points: unknown[] }).points).toHaveLength(1);
    });

    it('removes a trailing comma', () => {
      const r = parseLlmJson('{"points":[{"key":"a","value":"1"},]}');
      expect(r.via).toBe('repair');
      expect((r.value as { points: unknown[] }).points).toHaveLength(1);
    });

    it('inserts a missing comma between objects', () => {
      const r = parseLlmJson('{"points":[{"key":"a","value":"1"}{"key":"b","value":"2"}]}');
      expect(r.via).toBe('repair');
      expect((r.value as { points: unknown[] }).points).toHaveLength(2);
    });

    it('closes a truncated array, keeping the complete leading items', () => {
      // Output-token cap cut the response mid-object.
      const raw = '{"points":[{"key":"a","value":"1"},{"key":"b","val';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('repair');
      const pts = (r.value as { points: unknown[] }).points;
      expect(pts.length).toBeGreaterThanOrEqual(1);
    });

    it('repairs a severely-truncated response with no closing brace at all (repair-whole)', () => {
      const raw = '{"points":[{"key":"apps","value":"2 Apps (Doctor & Health Worker) - Andriod"';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('repair-whole'); // no complete slice → riskier variant
      expect((r.value as { points: Array<{ value: string }> }).points[0]!.value).toContain('Doctor');
    });
  });

  describe('known limitation — repair is lossy (signalled via via:repair)', () => {
    it('drops lone backslashes when repairing (documented, logged by caller)', () => {
      // `\U` is not a valid JSON escape; jsonrepair normalises it away. We assert
      // the ACTUAL behaviour so it is a known, tested property — the real defence
      // is the schema fix keeping Gemini from emitting this unescaped at all.
      const raw = '{"points":[{"key":"path","value":"C:\\Users\\bin"}]}';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('repair'); // caller logs this → not silent
      const value = (r.value as { points: Array<{ value: string }> }).points[0]!.value;
      expect(value).toContain('C:'); // recovered, though backslashes are lossy
    });

    it('reports via:repair-whole so pricing callers can guard truncated numbers', () => {
      const raw = '{"entities":[{"serviceLineSlug":"x","scopeValue":12';
      const r = parseLlmJson(raw);
      expect(r.via).toBe('repair-whole');
    });
  });

  describe('known limitation — ambiguous stray quotes fail CLEANLY (not corrupt)', () => {
    it('throws rather than guessing when a stray quote is structurally ambiguous', () => {
      // `... & "Health") - ...` is genuinely ambiguous: a repairer cannot know
      // whether the inner `"` closes the value or opens a new key. We THROW so
      // the extraction caller falls back to its structured points (never worse)
      // and logs loudly — instead of silently corrupting the value. The real
      // defence is `sanitizeSchemaForProvider`, which keeps Gemini's JSON mode
      // engaged so the model escapes the quote at the source and this input
      // never reaches us.
      const raw = '{"points":[{"key":"apps","value":"2 Apps (Doctor & "Health") - Andriod"}]}';
      expect(() => parseLlmJson(raw)).toThrow(LlmJsonParseError);
    });
  });

  describe('unrecoverable', () => {
    it('throws LlmJsonParseError on empty input', () => {
      expect(() => parseLlmJson('')).toThrow(LlmJsonParseError);
      expect(() => parseLlmJson('   ')).toThrow(LlmJsonParseError);
    });

    it('carries a raw preview on the error', () => {
      try {
        parseLlmJson('');
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(LlmJsonParseError);
        expect((e as LlmJsonParseError).rawPreview).toBeDefined();
      }
    });
  });
});

describe('stripCodeFences', () => {
  it('extracts the inner content of a full fenced block', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('strips a lone leading fence (model opened but never closed)', () => {
    expect(stripCodeFences('```json\n{"a":1}')).toBe('{"a":1}');
  });
  it('leaves unfenced text untouched', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });
});
