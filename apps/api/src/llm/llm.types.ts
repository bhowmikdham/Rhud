/**
 * Shared LLM types — common interface every provider implements.
 *
 * The shape is OpenAI-flavored because almost every provider speaks it
 * natively (OpenAI, Azure, Ollama, Together, OpenRouter) or has a compat
 * endpoint (Anthropic). The Anthropic provider does the small mapping
 * to/from the native Messages API; everyone else is essentially the
 * OpenAI client with a different base URL.
 */

export type LlmProviderName =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'openai_compat'
  | 'manual';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  /** Override the configured model for this call. */
  model?: string;
  temperature?: number;
  /** Soft upper bound on output tokens. */
  maxTokens?: number;
  /** Per-call timeout in ms. Hard ceiling — provider call is aborted on miss. */
  timeoutMs?: number;
  /**
   * Gemini-only: cap the model's hidden "thinking" tokens (which otherwise
   * run a large DYNAMIC budget and dominate token usage even on a mechanical
   * JSON-mapping task). Maps to the OpenAI-compat `reasoning_effort` field.
   * IGNORED by every other provider. If Gemini rejects it the provider
   * transparently retries WITHOUT it, so it can never break a call.
   */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  /**
   * Constrain the model to emit JSON matching this schema (OpenAI-compat
   * `response_format: { type: 'json_schema', json_schema }`; Gemini honours it
   * via its OpenAI-compat layer). Eliminates markdown fences / prose preamble /
   * hallucinated slugs so the response always parses. Self-healing: if the
   * provider rejects the schema (4xx) it is stripped and the call retried, so
   * it can never break inference — worst case is the prior unstructured path.
   */
  responseSchema?: { name: string; schema: Record<string, unknown> };
  /** Best-effort determinism seed. Honoured by some providers; ignored by
   *  others (Gemini ignores it for hidden thinking tokens). Also stripped +
   *  retried on a 4xx. */
  seed?: number;
}

export interface ChatResult {
  text: string;
  /** Total tokens (prompt + completion) when the provider reports them. */
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Provider-reported model id — useful when the request used a default. */
  model?: string;
  /** Raw stop reason string from the provider, normalised to lowercase. */
  finishReason?: string;
  /**
   * Whether the response was actually generated under the requested
   * `responseSchema` (json_schema) constraint. `true` when a schema was sent
   * and the provider accepted it; `false` when a schema was requested but the
   * provider REJECTED it (4xx) and the call silently fell back to unconstrained
   * generation — the case that produces malformed free-form JSON (see Gemini +
   * `additionalProperties`). `undefined` when no schema was requested or the
   * provider doesn't track it. Callers use `false` to parse defensively and to
   * log that structured output is not actually engaged for this provider.
   */
  structuredOutputApplied?: boolean;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  chat(messages: ChatMessage[], opts: ChatOptions): Promise<ChatResult>;
}

export interface ResolvedConfig {
  tenantId: string;
  provider: LlmProviderName;
  model: string;
  baseUrl: string | null;
  apiKey: string | null;
  enabled: boolean;
}
