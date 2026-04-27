/**
 * Shared LLM types — common interface every provider implements.
 *
 * The shape is OpenAI-flavored because almost every provider speaks it
 * natively (OpenAI, Azure, Ollama, Together, OpenRouter) or has a compat
 * endpoint (Anthropic). The Anthropic provider does the small mapping
 * to/from the native Messages API; everyone else is essentially the
 * OpenAI client with a different base URL.
 */

export type LlmProviderName = 'anthropic' | 'openai' | 'ollama' | 'openai_compat' | 'manual';

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
