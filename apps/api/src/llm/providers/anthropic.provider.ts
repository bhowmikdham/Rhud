/* global AbortController, Response */
/**
 * Anthropic Messages API provider — calls /v1/messages natively rather
 * than the OpenAI-compat shim, because:
 *   - Anthropic-specific features (system separation, tool use) come for
 *     free when we're already on the native API.
 *   - The compat endpoint adds a translation hop we don't need.
 *
 * Auth + version are both required headers. We pin the API version so a
 * future Anthropic-side bump can't silently change the response shape.
 */

import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  LlmProviderName,
  ResolvedConfig,
} from '../llm.types.js';

const DEFAULT_BASE = 'https://api.anthropic.com/v1';
const ANTHROPIC_VERSION = '2023-06-01';

interface RawResponse {
  id?: string;
  model?: string;
  content?: Array<{ type: 'text'; text: string } | { type: string }>;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name: LlmProviderName = 'anthropic';
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(config: ResolvedConfig) {
    if (!config.apiKey) {
      throw new Error('anthropic provider requires an api key');
    }
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
  }

  async chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult> {
    // Anthropic separates system from the message list. Concatenate any
    // leading system messages into a single string and pass the rest as-is.
    // A user message carrying images becomes a content-block array using
    // Anthropic's native base64 image source; text-only turns stay plain
    // strings.
    const systemParts: string[] = [];
    const turns: Array<{ role: 'user' | 'assistant'; content: string | unknown[] }> = [];
    for (const m of messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else if (m.role === 'user' && m.images?.length) {
        const blocks: unknown[] = [];
        if (m.content) blocks.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.dataBase64 },
          });
        }
        turns.push({ role: m.role, content: blocks });
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model: opts.model ?? this.model,
      messages: turns,
      // max_tokens is REQUIRED by Anthropic. Default to a sensible cap so
      // a forgetful caller can't crash a request.
      max_tokens: opts.maxTokens ?? 1024,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (opts.temperature != null) body.temperature = opts.temperature;

    const ctrl = new AbortController();
    const timer = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
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
    const text = (json.content ?? [])
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('')
      .trim();

    const inputTokens = json.usage?.input_tokens;
    const outputTokens = json.usage?.output_tokens;
    const finish = json.stop_reason?.toLowerCase();

    const result: ChatResult = { text };
    if (json.model != null) result.model = json.model;
    if (finish != null) result.finishReason = finish;
    if (inputTokens != null) result.inputTokens = inputTokens;
    if (outputTokens != null) result.outputTokens = outputTokens;
    if (inputTokens != null && outputTokens != null) {
      result.totalTokens = inputTokens + outputTokens;
    }
    return result;
  }
}
