/**
 * LLM service — single entry point for everything LLM-shaped in the app.
 *
 * Two responsibilities:
 *   1. Per-tenant config CRUD (provider choice, model, base URL, encrypted
 *      API key, enabled toggle, monthly budget).
 *   2. `chat()` — load the tenant's config, instantiate the right provider,
 *      run the request. Callers (quote-justification, parser fallback,
 *      etc.) only ever talk to this method.
 *
 * Failure posture: the API key is encrypted at rest with envelope crypto
 * (see llm.crypto.ts). Decryption happens only inside this service; the
 * plaintext never leaves the call frame.
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import {
  decryptApiKey,
  encryptApiKey,
  type EncryptedKey,
} from './llm.crypto.js';
import type {
  ChatMessage,
  ChatOptions,
  ChatResult,
  LlmProvider,
  LlmProviderName,
  ResolvedConfig,
} from './llm.types.js';
import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OpenAiCompatProvider } from './providers/openai-compat.provider.js';

const VALID_PROVIDERS: LlmProviderName[] = ['anthropic', 'openai', 'ollama', 'openai_compat', 'manual'];

export interface PublicConfig {
  provider: LlmProviderName;
  model: string;
  baseUrl: string | null;
  /** Whether an API key is on file. We never expose the value itself. */
  apiKeySet: boolean;
  enabled: boolean;
  monthlyTokenBudget: number;
  updatedAt: string;
}

export interface UpsertConfigInput {
  provider: LlmProviderName;
  model: string;
  baseUrl?: string | null;
  /** Plaintext key. Pass `undefined` to leave the existing key untouched
   *  on update; pass `null` (or empty string) to clear it. */
  apiKey?: string | null;
  enabled?: boolean;
  monthlyTokenBudget?: number;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);

  constructor(private readonly tenantDb: TenantDb) {}

  // ── Config ──────────────────────────────────────────────────────────────

  async getConfig(tenantId: string): Promise<PublicConfig | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenantLlmConfig.findUnique({ where: { tenantId } });
      if (!row) return null;
      return this.toPublic(row);
    });
  }

  async upsertConfig(tenantId: string, input: UpsertConfigInput): Promise<PublicConfig> {
    if (!VALID_PROVIDERS.includes(input.provider)) {
      throw new BadRequestException('invalid_provider');
    }
    if (!input.model.trim()) throw new BadRequestException('model_required');

    // Providers that require a base URL when there's no built-in default.
    const needsBaseUrl = input.provider === 'openai_compat';
    if (needsBaseUrl && !input.baseUrl) {
      throw new BadRequestException('base_url_required_for_openai_compat');
    }

    // Manual + Ollama are the only key-optional providers — anything else
    // must end up with an encrypted key on disk after this call. We can't
    // judge that from `input` alone (undefined means "keep existing"); the
    // check has to run after we've fetched the prior row.
    const keyRequired = ['anthropic', 'openai', 'openai_compat'].includes(input.provider);

    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.tenantLlmConfig.findUnique({ where: { tenantId } });

      if (keyRequired) {
        const willHaveKey =
          (typeof input.apiKey === 'string' && input.apiKey.length > 0) ||
          (input.apiKey === undefined && existing?.apiKeyCiphertext != null);
        if (!willHaveKey) {
          throw new BadRequestException('api_key_required_for_provider');
        }
      }

      // Resolve API key columns based on the input:
      //   - undefined    → keep existing (or null if no prior row)
      //   - empty/null   → explicitly clear all 4 columns
      //   - non-empty    → encrypt fresh
      let apiKeyCiphertext: Buffer | null;
      let apiKeyIv: Buffer | null;
      let apiKeyDekCiphertext: Buffer | null;
      let apiKeyDekIv: Buffer | null;

      if (input.apiKey === undefined) {
        apiKeyCiphertext = existing?.apiKeyCiphertext ?? null;
        apiKeyIv = existing?.apiKeyIv ?? null;
        apiKeyDekCiphertext = existing?.apiKeyDekCiphertext ?? null;
        apiKeyDekIv = existing?.apiKeyDekIv ?? null;
      } else if (input.apiKey === null || input.apiKey === '') {
        apiKeyCiphertext = apiKeyIv = apiKeyDekCiphertext = apiKeyDekIv = null;
      } else {
        const enc: EncryptedKey = encryptApiKey(input.apiKey);
        apiKeyCiphertext = enc.apiKeyCiphertext;
        apiKeyIv = enc.apiKeyIv;
        apiKeyDekCiphertext = enc.apiKeyDekCiphertext;
        apiKeyDekIv = enc.apiKeyDekIv;
      }

      const data = {
        tenantId,
        provider: input.provider,
        model: input.model,
        baseUrl: input.baseUrl ?? null,
        apiKeyCiphertext,
        apiKeyIv,
        apiKeyDekCiphertext,
        apiKeyDekIv,
        enabled: input.enabled ?? existing?.enabled ?? true,
        monthlyTokenBudget: input.monthlyTokenBudget ?? existing?.monthlyTokenBudget ?? 0,
        updatedAt: new Date(),
      };

      const upserted = await db.tenantLlmConfig.upsert({
        where: { tenantId },
        create: data,
        update: {
          provider: data.provider,
          model: data.model,
          baseUrl: data.baseUrl,
          apiKeyCiphertext: data.apiKeyCiphertext,
          apiKeyIv: data.apiKeyIv,
          apiKeyDekCiphertext: data.apiKeyDekCiphertext,
          apiKeyDekIv: data.apiKeyDekIv,
          enabled: data.enabled,
          monthlyTokenBudget: data.monthlyTokenBudget,
          updatedAt: data.updatedAt,
        },
      });

      return this.toPublic(upserted);
    });
  }

  async deleteConfig(tenantId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.tenantLlmConfig.delete({ where: { tenantId } }).catch(() => undefined);
    });
  }

  // ── Chat (consumed by other modules) ────────────────────────────────────

  async chat(
    tenantId: string,
    messages: ChatMessage[],
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
    const resolved = await this.resolveConfig(tenantId);
    if (!resolved.enabled) throw new ForbiddenException('llm_disabled_for_tenant');
    const provider = this.providerFor(resolved);
    return provider.chat(messages, opts);
  }

  /**
   * Round-trip a tiny prompt to verify the configured provider actually
   * works. Used by the "Test connection" button in the UI. Doesn't write
   * to the config table — purely a probe.
   */
  async testCurrentConfig(tenantId: string): Promise<{ ok: boolean; error?: string; sample?: string }> {
    let resolved: ResolvedConfig;
    try {
      resolved = await this.resolveConfig(tenantId);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }

    try {
      const result = await this.providerFor(resolved).chat(
        [{ role: 'user', content: 'Reply with the single word: ok' }],
        { maxTokens: 8, timeoutMs: 15_000, temperature: 0 },
      );
      return { ok: true, sample: result.text };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async resolveConfig(tenantId: string): Promise<ResolvedConfig> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantLlmConfig.findUnique({ where: { tenantId } }),
    );
    if (!row) throw new NotFoundException('llm_config_not_set');

    let apiKey: string | null = null;
    if (row.apiKeyCiphertext && row.apiKeyIv && row.apiKeyDekCiphertext && row.apiKeyDekIv) {
      try {
        apiKey = decryptApiKey({
          apiKeyCiphertext: row.apiKeyCiphertext,
          apiKeyIv: row.apiKeyIv,
          apiKeyDekCiphertext: row.apiKeyDekCiphertext,
          apiKeyDekIv: row.apiKeyDekIv,
        });
      } catch (e) {
        // Most likely the master key changed (rotation, dev restart). The
        // admin needs to re-enter the key. Surface a clear error.
        this.logger.error(`llm key decryption failed for tenant ${tenantId}: ${(e as Error).message}`);
        throw new BadRequestException('llm_key_decryption_failed_reenter_key');
      }
    }

    return {
      tenantId,
      provider: row.provider as LlmProviderName,
      model: row.model,
      baseUrl: row.baseUrl,
      apiKey,
      enabled: row.enabled,
    };
  }

  private providerFor(config: ResolvedConfig): LlmProvider {
    switch (config.provider) {
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'openai':
      case 'ollama':
      case 'openai_compat':
        return new OpenAiCompatProvider(config);
      case 'manual':
        // Sanity guard — features that need a provider should check
        // `getProviderName()` first and route to the manual UI flow
        // instead of calling chat().
        throw new BadRequestException('manual_provider_requires_ui_flow');
      default:
        throw new BadRequestException(`unknown_provider:${config.provider}`);
    }
  }

  /** Returns the configured provider name for callers that need to branch
   *  on auto vs manual mode (quote justification, parser fallback, etc.). */
  async getProviderName(tenantId: string): Promise<LlmProviderName | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenantLlmConfig.findUnique({
        where: { tenantId },
        select: { provider: true, enabled: true },
      });
      if (!row || !row.enabled) return null;
      return row.provider as LlmProviderName;
    });
  }

  private toPublic(row: {
    provider: string;
    model: string;
    baseUrl: string | null;
    apiKeyCiphertext: Buffer | null;
    enabled: boolean;
    monthlyTokenBudget: number;
    updatedAt: Date;
  }): PublicConfig {
    return {
      provider: row.provider as LlmProviderName,
      model: row.model,
      baseUrl: row.baseUrl,
      apiKeySet: row.apiKeyCiphertext != null,
      enabled: row.enabled,
      monthlyTokenBudget: row.monthlyTokenBudget,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
