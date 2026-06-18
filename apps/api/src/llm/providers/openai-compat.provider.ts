/* global AbortController, Response */
/**
 * OpenAI-compatible chat completions provider.
 *
 * Covers OpenAI itself, Azure OpenAI, Ollama (`/v1/chat/completions`),
 * Together, OpenRouter, vLLM, llama.cpp's server, anything that speaks
 * the same wire format. The differences boil down to the base URL and
 * whether the auth header is required — Ollama accepts (and ignores)
 * any bearer, OpenAI/Azure require a real one.
 *
 * Rate-limit posture: 429s are retried with exponential backoff up to
 * 4 attempts. Honours `Retry-After` (seconds) when present, otherwise
 * doubles a base 2s delay (2s → 4s → 8s, capped at 32s). After the
 * last attempt we surface the upstream error so the caller can show
 * a clean "Please try again later" UX. Per-request `timeoutMs` is the
 * overall budget — backoff sleeps eat into it.
 */

import { Logger } from '@nestjs/common';

import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  LlmProviderName,
  ResolvedConfig,
} from '../llm.types.js';

const DEFAULT_BASE_BY_PROVIDER: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
  // Google's OpenAI-compatible endpoint for Gemini. Same wire format
  // as OpenAI's /v1/chat/completions, just hosted on Google's domain.
  // Docs: https://ai.google.dev/gemini-api/docs/openai
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

interface RawResponse {
  model?: string;
  choices?: Array<{
    message?: { content?: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class OpenAiCompatProvider implements LlmProvider {
  readonly name: LlmProviderName;
  private readonly baseUrl: string;
  private readonly apiKey: string | null;
  private readonly model: string;
  /** True when this client actually talks to Gemini's OpenAI-compat endpoint —
   *  either provider==='gemini' OR a tenant pointed the generic `openai_compat`
   *  provider at Gemini's base URL. Drives the json_schema dialect fix; keying
   *  only on the provider NAME would miss the latter case. */
  private readonly geminiDialect: boolean;
  private readonly logger = new Logger(OpenAiCompatProvider.name);

  constructor(config: ResolvedConfig) {
    this.name = config.provider;
    this.model = config.model;
    this.apiKey = config.apiKey;

    const base = config.baseUrl ?? DEFAULT_BASE_BY_PROVIDER[config.provider] ?? null;
    if (!base) {
      throw new Error(`provider ${config.provider} requires baseUrl`);
    }
    // Trim trailing slash so we can append /chat/completions cleanly.
    this.baseUrl = base.replace(/\/$/, '');
    this.geminiDialect =
      this.name === 'gemini' || /generativelanguage\.googleapis\.com/i.test(this.baseUrl);
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages,
      ...(opts.temperature != null && { temperature: opts.temperature }),
      ...(opts.maxTokens != null && { max_tokens: opts.maxTokens }),
    };

    // Gemini-only thinking control. gemini-2.5/3.x flash run a large DYNAMIC
    // thinking budget that dominates token usage even on mechanical JSON
    // mapping. `reasoning_effort` caps it. Gated to Gemini (by name OR base URL)
    // — a real OpenAI/openai_compat target 400s on unknown params. If the target
    // still rejects it, the surgical 4xx strip below removes just that field, so
    // a bad param can never make a call fail; maxTokens stays the safety net.
    if (this.geminiDialect && opts.reasoningEffort != null) {
      body.reasoning_effort = opts.reasoningEffort;
    }
    // Structured output (constrained JSON). If the provider rejects it with a
    // 4xx the strip-and-retry below removes it, so it can only help — but the
    // strip is now SURGICAL (see below), so an unrelated bad field (e.g. seed)
    // no longer drags the schema down with it.
    if (opts.responseSchema != null) {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: opts.responseSchema.name,
          // Defensive: Gemini's OpenAI-compat layer can also reject a json_schema
          // carrying `additionalProperties` (it's outside its supported subset),
          // so we strip it for Gemini. (The PRIMARY cause of structured output
          // not engaging on Gemini was the `seed` field 400 above dragging the
          // schema down in a bundled strip — fixed by not sending seed + the
          // surgical strip below. This sanitization guards the remaining case.)
          schema: sanitizeSchemaForProvider(
            opts.responseSchema.schema,
            this.geminiDialect ? 'gemini' : this.name,
          ),
        },
      };
    }
    // Determinism seed — but NOT for Gemini. Gemini's OpenAI-compat endpoint
    // 400s on `seed` ("Unknown name seed: Cannot find field") and, because a
    // 4xx used to strip ALL extras together, that 400 silently took down
    // `response_format` too — which is the ACTUAL reason structured output never
    // engaged on Gemini (so it free-formed verbatim cell text → malformed JSON,
    // the MedTech bug). `seed` is also a no-op there (Gemini ignores it), so we
    // simply never send it. Other providers still get it for best-effort
    // determinism.
    if (opts.seed != null && !this.geminiDialect) {
      body.seed = opts.seed;
    }
    // Optional fields we've removed (and won't re-add) after the provider
    // rejected them with a 4xx. We strip SURGICALLY — the single named field —
    // so one unsupported param can't disable structured output for the others.
    const strippedFields = new Set<string>();
    // Last-resort bundled strip happened? (generic 4xx with no field named.)
    let bundledStripped = false;
    // Did we have to drop `response_format` specifically? Drives
    // `structuredOutputApplied` so callers know the response is unconstrained.
    let responseFormatStripped = false;

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    } else if (this.name !== 'ollama') {
      // Ollama is the only key-optional provider in this family. Anything
      // else: refuse fast with a clear error rather than sending a bogus
      // "Bearer none" that surfaces as an opaque upstream 401.
      throw new Error(
        `provider ${this.name} requires an API key — set it in Settings → AI`,
      );
    }

    const deadline = opts.timeoutMs ? Date.now() + opts.timeoutMs : null;
    const maxAttempts = 4;
    let lastErr: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const remaining = deadline ? deadline - Date.now() : null;
      if (remaining != null && remaining <= 0) {
        throw new Error(`llm timeout after ${opts.timeoutMs}ms`);
      }

      const ctrl = new AbortController();
      const timer = remaining != null ? setTimeout(() => ctrl.abort(), remaining) : null;

      let res: Response;
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (err) {
        if (timer) clearTimeout(timer);
        if ((err as Error).name === 'AbortError') {
          throw new Error(`llm timeout after ${opts.timeoutMs}ms`);
        }
        // Network blip — also retryable with backoff.
        lastErr = new Error(`llm fetch failed: ${(err as Error).message}`);
        if (attempt < maxAttempts && (await this.backoff(attempt, null, deadline))) {
          continue;
        }
        throw lastErr;
      } finally {
        if (timer) clearTimeout(timer);
      }

      // Retryable 429 / 5xx. 4xx other than 429 is the user's problem
      // (bad model name, bad key, content policy) — no point retrying.
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const text = await res.text().catch(() => '');
        const retryAfterHeader = res.headers.get('retry-after');
        const retryAfterMs = parseRetryAfter(retryAfterHeader);
        lastErr = new Error(`llm http ${res.status}: ${text.slice(0, 300)}`);

        // 429 retry policy: try ONCE inline with a wait long enough to
        // cross a minute boundary (Gemini's RPM/TPM buckets reset on
        // the minute). Burst-protection 429s also recover within ~30s.
        // After that single retry, bubble up so the persistent extraction
        // retry queue can take over for the long-tail case (true quota
        // exhaustion). 5xx still gets the full backoff schedule.
        const isThrottle = res.status === 429;
        if (isThrottle && attempt === 1) {
          // Honour upstream Retry-After if provided; otherwise wait 35s
          // — long enough to cross a minute boundary in most cases.
          const wait = Math.min(retryAfterMs ?? 35_000, 60_000);
          if (deadline == null || deadline - Date.now() > wait) {
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
        }
        if (!isThrottle && attempt < maxAttempts && (await this.backoff(attempt, retryAfterMs, deadline))) {
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        // Resilience: a 4xx caused by an OPTIONAL extra (reasoning_effort,
        // response_format/json_schema, seed) must never break the call. We
        // prefer a SURGICAL strip — remove only the field the provider names as
        // unknown — so an unsupported `seed` doesn't drag down `response_format`
        // (the bug that disabled structured output on Gemini). Only when no
        // field is identifiable do we fall back to stripping the whole bundle.
        if (res.status >= 400 && res.status < 500) {
          const OPTIONAL = ['seed', 'reasoning_effort', 'response_format'];
          // Gemini: `Invalid JSON payload received. Unknown name "seed": …`
          const named = text.match(/[Uu]nknown name \\?"?([a-zA-Z_]+)\\?"?/)?.[1];
          if (named && OPTIONAL.includes(named) && named in body && !strippedFields.has(named)) {
            strippedFields.add(named);
            if (named === 'response_format') responseFormatStripped = true;
            this.logger.warn(
              `${this.name}: provider rejected '${named}' (http ${res.status}) — ` +
                `removing just that field and retrying${named === 'response_format'
                  ? ' UNCONSTRAINED (output will not be schema-validated)'
                  : ' (structured output preserved)'}. Upstream: ${text.slice(0, 200)}`,
            );
            delete body[named];
            continue;
          }
          // Fallback: a generic 4xx with no named field, or a repeat failure —
          // strip the whole bundle once. Last resort before surfacing the error.
          const hasExtras =
            'reasoning_effort' in body || 'response_format' in body || 'seed' in body;
          if (hasExtras && !bundledStripped) {
            bundledStripped = true;
            if ('response_format' in body) responseFormatStripped = true;
            this.logger.warn(
              `${this.name}: provider rejected request (http ${res.status}); stripping all ` +
                `optional params (response_format/seed/reasoning) and retrying — output may ` +
                `not be schema-validated. Upstream: ${text.slice(0, 300)}`,
            );
            delete body.reasoning_effort;
            delete body.response_format;
            delete body.seed;
            continue;
          }
        }
        throw new Error(`llm http ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as RawResponse;
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      const finish = json.choices?.[0]?.finish_reason?.toLowerCase();

      const result: ChatResult = { text };
      if (json.model != null) result.model = json.model;
      if (finish != null) result.finishReason = finish;
      if (opts.responseSchema != null) {
        // True only if the schema survived to this successful request.
        result.structuredOutputApplied = !responseFormatStripped;
      }
      if (json.usage?.prompt_tokens != null) result.inputTokens = json.usage.prompt_tokens;
      if (json.usage?.completion_tokens != null) result.outputTokens = json.usage.completion_tokens;
      if (json.usage?.total_tokens != null) result.totalTokens = json.usage.total_tokens;
      return result;
    }

    // Defensive — loop always either returns or throws above.
    throw lastErr ?? new Error('llm: exhausted retries');
  }

  /**
   * Wait before the next retry. Returns true if the wait fits inside
   * the remaining budget, false if the deadline has been blown (caller
   * should give up). Honours upstream-suggested `Retry-After` when set;
   * otherwise exponential 2s → 4s → 8s, capped at 32s.
   */
  private async backoff(
    attempt: number,
    retryAfterMs: number | null,
    deadline: number | null,
  ): Promise<boolean> {
    const fallback = Math.min(2_000 * 2 ** (attempt - 1), 32_000);
    const wait = retryAfterMs != null ? Math.min(retryAfterMs, 60_000) : fallback;
    if (deadline != null && Date.now() + wait >= deadline) return false;
    await new Promise<void>((r) => setTimeout(r, wait));
    return true;
  }
}

/**
 * Adapt a json_schema to a provider's supported dialect before it goes on the
 * wire. Currently Gemini-specific: its OpenAI-compat layer rejects (or ignores)
 * schemas that carry `additionalProperties` — the field OpenAI's strict mode
 * REQUIRES but Gemini's `responseJsonSchema` translation chokes on. Dropping it
 * recursively lets Gemini accept the schema and engage constrained JSON
 * decoding (which guarantees syntactically valid output) instead of silently
 * falling back to free-form text. Other providers (OpenAI, Ollama, generic
 * openai_compat) get the schema untouched.
 *
 * Pure + deep-cloned — never mutates the caller's schema object (it's a module
 * constant shared across requests).
 */
export function sanitizeSchemaForProvider(
  schema: Record<string, unknown>,
  provider: LlmProviderName,
): Record<string, unknown> {
  if (provider !== 'gemini') return schema;
  return stripKeysDeep(schema, ['additionalProperties']) as Record<string, unknown>;
}

/** Deep-clone `value`, omitting any object keys in `keys` at every level. */
function stripKeysDeep(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) return value.map((v) => stripKeysDeep(v, keys));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (keys.includes(k)) continue;
      out[k] = stripKeysDeep(v, keys);
    }
    return out;
  }
  return value;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  // RFC 7231: either delta-seconds or HTTP-date. Most LLM providers
  // emit the former; we only handle that form.
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}
