import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAiCompatProvider, sanitizeSchemaForProvider } from './openai-compat.provider.js';
import type { ResolvedConfig } from '../llm.types.js';

const SCHEMA = {
  name: 'extracted_points',
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      points: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { key: { type: 'string' }, value: { type: 'string' } },
          required: ['key', 'value'],
        },
      },
    },
    required: ['points'],
  },
};

function config(provider: ResolvedConfig['provider']): ResolvedConfig {
  return {
    tenantId: 't1',
    provider,
    model: 'gemini-2.5-flash',
    baseUrl: null,
    apiKey: 'k',
    enabled: true,
  };
}

function okResponse(content = '{"points":[]}') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content }, finish_reason: 'stop' }] }),
    text: async () => content,
    headers: { get: () => null },
  } as unknown as Response;
}

function errResponse(status: number, body = 'bad') {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

describe('sanitizeSchemaForProvider', () => {
  it('strips additionalProperties recursively for gemini', () => {
    const out = sanitizeSchemaForProvider(SCHEMA.schema, 'gemini');
    expect(JSON.stringify(out)).not.toContain('additionalProperties');
    // ...while preserving the rest of the schema.
    expect((out as { properties: { points: unknown } }).properties.points).toBeDefined();
  });

  it('leaves the schema untouched for openai', () => {
    const out = sanitizeSchemaForProvider(SCHEMA.schema, 'openai');
    expect(out).toEqual(SCHEMA.schema);
  });

  it('does not mutate the input schema object', () => {
    const original = JSON.stringify(SCHEMA.schema);
    sanitizeSchemaForProvider(SCHEMA.schema, 'gemini');
    expect(JSON.stringify(SCHEMA.schema)).toBe(original);
  });
});

describe('OpenAiCompatProvider structured-output handling', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function bodyOf(callIndex: number): Record<string, unknown> {
    const init = fetchMock.mock.calls[callIndex]![1] as { body: string };
    return JSON.parse(init.body);
  }

  it('sends a gemini schema WITHOUT additionalProperties on the wire', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const p = new OpenAiCompatProvider(config('gemini'));
    const res = await p.chat([{ role: 'user', content: 'hi' }], { responseSchema: SCHEMA });
    const sent = bodyOf(0);
    expect(JSON.stringify(sent.response_format)).not.toContain('additionalProperties');
    expect(res.structuredOutputApplied).toBe(true);
  });

  it('marks structuredOutputApplied=false and drops response_format when the provider 4xxs the schema', async () => {
    // First call (with schema) → 400; provider strips + retries → 200.
    fetchMock.mockResolvedValueOnce(errResponse(400, 'additionalProperties is not supported'));
    fetchMock.mockResolvedValueOnce(okResponse('{"points":[]}'));
    const p = new OpenAiCompatProvider(config('gemini'));
    const res = await p.chat([{ role: 'user', content: 'hi' }], {
      responseSchema: SCHEMA,
      seed: 1,
      reasoningEffort: 'low',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect('response_format' in bodyOf(0)).toBe(true);
    // Retry must be fully stripped of all optional extras.
    const retry = bodyOf(1);
    expect('response_format' in retry).toBe(false);
    expect('seed' in retry).toBe(false);
    expect('reasoning_effort' in retry).toBe(false);
    expect(res.structuredOutputApplied).toBe(false);
  });

  it('sanitizes the schema when openai_compat points at Gemini base URL', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const cfg: ResolvedConfig = {
      tenantId: 't1',
      provider: 'openai_compat',
      model: 'gemini-2.5-flash',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiKey: 'k',
      enabled: true,
    };
    const p = new OpenAiCompatProvider(cfg);
    await p.chat([{ role: 'user', content: 'hi' }], { responseSchema: SCHEMA });
    expect(JSON.stringify(bodyOf(0).response_format)).not.toContain('additionalProperties');
  });

  it('leaves structuredOutputApplied undefined when no schema was requested', async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    const p = new OpenAiCompatProvider(config('openai'));
    const res = await p.chat([{ role: 'user', content: 'hi' }], {});
    expect(res.structuredOutputApplied).toBeUndefined();
  });
});
