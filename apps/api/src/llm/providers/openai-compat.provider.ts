/* global AbortController, Response */
/**
 * OpenAI-compatible chat completions provider.
 *
 * Covers OpenAI itself, Azure OpenAI, Ollama (`/v1/chat/completions`),
 * Together, OpenRouter, vLLM, llama.cpp's server, anything that speaks
 * the same wire format. The differences boil down to the base URL and
 * whether the auth header is required — Ollama accepts (and ignores)
 * any bearer, OpenAI/Azure require a real one.
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

    const ctrl = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`llm timeout after ${opts.timeoutMs}ms`);
      }
      throw new Error(`llm fetch failed: ${(err as Error).message}`);
    } finally {
      if (timer) clearTimeout(timer);
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
}
