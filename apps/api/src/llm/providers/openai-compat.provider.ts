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
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    const body = {
      model: opts.model ?? this.model,
      messages,
      ...(opts.temperature != null && { temperature: opts.temperature }),
      ...(opts.maxTokens != null && { max_tokens: opts.maxTokens }),
    };

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
        throw new Error(`llm http ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = (await res.json()) as RawResponse;
      const text = json.choices?.[0]?.message?.content?.trim() ?? '';
      const finish = json.choices?.[0]?.finish_reason?.toLowerCase();

      const result: ChatResult = { text };
      if (json.model != null) result.model = json.model;
      if (finish != null) result.finishReason = finish;
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

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  // RFC 7231: either delta-seconds or HTTP-date. Most LLM providers
  // emit the former; we only handle that form.
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 1000);
}
