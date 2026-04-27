/**
 * Gamma integration — config CRUD + the actual deck-generation call.
 *
 * Two responsibilities:
 *   1. Per-tenant config: workspace name + id, encrypted API key,
 *      proposal-driver preference (llm | gamma), enabled toggle.
 *   2. `draftForEngagement()` — builds a markdown brief from a quote +
 *      scope, sends it to Gamma's Generate API, polls until ready,
 *      returns the deck URL. Persistence onto the engagement is
 *      handled by ProposalDraftService so both drivers (LLM + Gamma)
 *      land in the same place.
 *
 * The API key is stored using the same envelope encryption as
 * TenantLlmConfig — see encryptApiKey/decryptApiKey in llm/llm.crypto.ts.
 * Plaintext only exists inside this service; never leaves.
 */

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import {
  decryptApiKey,
  encryptApiKey,
  type EncryptedKey,
} from '../llm/llm.crypto.js';
import { GammaClient, RateLimitError, type GeneratedDeck, type GammaCreateInput, type GammaCreateFromTemplateInput } from './gamma.client.js';

export type ProposalDriver = 'llm' | 'gamma';

export interface PublicGammaConfig {
  workspaceName: string | null;
  workspaceId: string | null;
  /** True when an encrypted key is on file. The plaintext is never returned. */
  apiKeySet: boolean;
  proposalDriver: ProposalDriver;
  enabled: boolean;
  updatedAt: string;
}

export interface UpsertGammaConfig {
  workspaceName?: string | null;
  workspaceId?: string | null;
  /** undefined leaves the existing key alone; '' or null clears it. */
  apiKey?: string | null;
  proposalDriver?: ProposalDriver;
  enabled?: boolean;
}

interface DraftBrief {
  /** The markdown / freeform text Gamma will turn into a deck. */
  inputText: string;
  /** Optional name for the deck — Gamma derives a title otherwise. */
  title: string;
  /** When set, forwarded to Gamma so the deck inherits that template's
   *  layout/theme. Sourced from the Rhud template's `gammaTemplateId`. */
  gammaTemplateId?: string | null;
}

@Injectable()
export class GammaService {
  private readonly logger = new Logger(GammaService.name);

  constructor(private readonly tenantDb: TenantDb) {}

  // ── Config CRUD ────────────────────────────────────────────────────────

  async getConfig(tenantId: string): Promise<PublicGammaConfig | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenantGammaConfig.findUnique({ where: { tenantId } });
      if (!row) return null;
      return this.toPublic(row);
    });
  }

  async upsertConfig(tenantId: string, input: UpsertGammaConfig): Promise<PublicGammaConfig> {
    if (input.proposalDriver && !['llm', 'gamma'].includes(input.proposalDriver)) {
      throw new BadRequestException('invalid_proposal_driver');
    }

    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.tenantGammaConfig.findUnique({ where: { tenantId } });

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

      // If they're switching the driver to gamma, refuse without an API key
      // — same fail-fast principle as the LLM config.
      const newDriver: ProposalDriver = input.proposalDriver ?? (existing?.proposalDriver as ProposalDriver) ?? 'llm';
      if (newDriver === 'gamma' && !apiKeyCiphertext) {
        throw new BadRequestException('api_key_required_when_gamma_is_drafter');
      }

      const data = {
        tenantId,
        workspaceName: input.workspaceName ?? existing?.workspaceName ?? null,
        workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
        apiKeyCiphertext,
        apiKeyIv,
        apiKeyDekCiphertext,
        apiKeyDekIv,
        proposalDriver: newDriver,
        enabled: input.enabled ?? existing?.enabled ?? true,
        updatedAt: new Date(),
      };

      const upserted = await db.tenantGammaConfig.upsert({
        where: { tenantId },
        create: data,
        update: {
          workspaceName: data.workspaceName,
          workspaceId: data.workspaceId,
          apiKeyCiphertext: data.apiKeyCiphertext,
          apiKeyIv: data.apiKeyIv,
          apiKeyDekCiphertext: data.apiKeyDekCiphertext,
          apiKeyDekIv: data.apiKeyDekIv,
          proposalDriver: data.proposalDriver,
          enabled: data.enabled,
          updatedAt: data.updatedAt,
        },
      });
      return this.toPublic(upserted);
    });
  }

  async deleteConfig(tenantId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.tenantGammaConfig.delete({ where: { tenantId } }).catch(() => undefined);
    });
  }

  /**
   * Tells the proposal-draft pipeline which driver to use. Callers
   * (ProposalDraftService) check this at routing time. Returns 'llm'
   * for tenants without a Gamma config so behaviour is unchanged.
   */
  async getProposalDriver(tenantId: string): Promise<ProposalDriver> {
    const cfg = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantGammaConfig.findUnique({
        where: { tenantId },
        select: { proposalDriver: true, enabled: true },
      }),
    );
    if (!cfg || !cfg.enabled) return 'llm';
    return (cfg.proposalDriver as ProposalDriver) ?? 'llm';
  }

  /** Test the configured Gamma connection without writing anything. */
  async testCurrentConfig(tenantId: string): Promise<{ ok: boolean; error?: string }> {
    let client: GammaClient;
    try {
      client = await this.clientFor(tenantId);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    return client.ping();
  }

  // ── Draft generation ───────────────────────────────────────────────────

  /**
   * Build a brief, send to Gamma, await completion, return the deck.
   * Throws BadGateway with the Gamma error message if anything blew up
   * upstream — same posture as the LLM provider errors so the UI's
   * "ai_provider_error:" branch handles both.
   */
  async draftFromBrief(
    tenantId: string,
    brief: DraftBrief,
  ): Promise<{ url: string; deckId: string }> {
    const client = await this.clientFor(tenantId);
    const cfg = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantGammaConfig.findUnique({
        where: { tenantId },
        select: { workspaceId: true },
      }),
    );

    // Route to the right Gamma endpoint based on whether the Rhud
    // template carries a Gamma template id. Gamma's public API has two
    // distinct endpoints — /generations (freeform) and
    // /generations/from-template (clone an existing deck) — with
    // different request shapes. See:
    //   https://developers.gamma.app/generations/create-from-template
    // Default the deck to externally-viewable so Rhud's iframe preview
    // works without the rep manually flipping share settings in Gamma.
    // The deck URL is unguessable so this is effectively unchanged
    // privacy-wise, just removes a "click here, fix sharing in Gamma,
    // come back" detour. Consultancies that need stricter defaults can
    // change them in Gamma's workspace settings.
    const sharingOptions = { externalAccess: 'view' as const };
    // PDF export is the attachment shape sales reps need for the
    // Send-to-client modal. Each Gamma generation gets ONE export
    // format (per their docs), so we always request PDF up-front
    // rather than re-generating later — re-export isn't supported.
    const exportAs = 'pdf' as const;
    let deck: GeneratedDeck;
    try {
      if (brief.gammaTemplateId) {
        // No `# {title}` wrapping here — the from-template prompt is a
        // substitution instruction, and the title comes from the source
        // deck. Wrapping caused Gamma to inject a duplicate title card.
        deck = await client.createFromTemplateAndAwait(
          {
            prompt: brief.inputText,
            gammaId: brief.gammaTemplateId,
            sharingOptions,
            exportAs,
          },
          { pollIntervalMs: 5_000, maxWaitMs: 300_000 },
        );
      } else {
        deck = await client.createAndAwait(
          {
            inputText: `# ${brief.title}\n\n${brief.inputText}`,
            ...(cfg?.workspaceId && { workspaceId: cfg.workspaceId }),
            format: 'presentation',
            textMode: 'generate',
            sharingOptions,
            exportAs,
          },
          { pollIntervalMs: 5_000, maxWaitMs: 300_000 },
        );
      }
    } catch (e) {
      throw new BadGatewayException(`gamma_provider_error: ${(e as Error).message}`);
    }
    if (!deck.url) {
      throw new BadGatewayException(`gamma_provider_error: completed but no deck url returned`);
    }
    this.logger.log(`gamma deck generated tenant=${tenantId} id=${deck.generationId}`);
    return { url: deck.url, deckId: deck.generationId };
  }

  /**
   * Async-friendly version: kick off generation and return the
   * generationId immediately. Caller is responsible for polling
   * `pollStatus()` until terminal. Used by the proposal-draft pipeline
   * so the frontend's 5s poll loop drives the wait — instead
   * of blocking the original POST request for 30-90 seconds.
   */
  async startDraftFromBrief(
    tenantId: string,
    brief: { inputText: string; title: string; gammaTemplateId?: string | null },
  ): Promise<{ generationId: string }> {
    const client = await this.clientFor(tenantId);
    const cfg = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantGammaConfig.findUnique({
        where: { tenantId },
        select: { workspaceId: true },
      }),
    );

    // Iframe-preview rationale identical to draftFromBrief above.
    const sharingOptions = { externalAccess: 'view' as const };
    // PDF export rationale identical to draftFromBrief above — request
    // up-front so the export URL is available when the deck completes.
    const exportAs = 'pdf' as const;
    let deck: GeneratedDeck;
    try {
      if (brief.gammaTemplateId) {
        // Same shape rationale as draftFromBrief above — pass the
        // substitution prompt raw, no markdown title wrapping.
        const tplInput: GammaCreateFromTemplateInput = {
          prompt: brief.inputText,
          gammaId: brief.gammaTemplateId,
          sharingOptions,
          exportAs,
        };
        deck = await client.createFromTemplate(tplInput);
      } else {
        const freeInput: GammaCreateInput = {
          inputText: `# ${brief.title}\n\n${brief.inputText}`,
          ...(cfg?.workspaceId && { workspaceId: cfg.workspaceId }),
          format: 'presentation',
          textMode: 'generate',
          sharingOptions,
          exportAs,
        };
        deck = await client.create(freeInput);
      }
    } catch (e) {
      throw new BadGatewayException(`gamma_provider_error: ${(e as Error).message}`);
    }
    return { generationId: deck.generationId };
  }

  /** Hit Gamma's status endpoint for a single generation. Caller
   *  decides what to do with the result (persist URL, surface phase
   *  to UI, retry, etc.). Errors map to BadGateway like the create.
   *
   *  Special-case: a 429 from Gamma is *not* an error from the user's
   *  perspective — it just means "ask again later." Returning a
   *  pending deck keeps the frontend's poll loop alive without
   *  flashing an error banner. The actual cooldown is enforced
   *  client-side: the next interval is the same as before, and the
   *  status report below carries no new info (so the UI keeps showing
   *  the existing drafting state). */
  async pollStatus(tenantId: string, generationId: string): Promise<GeneratedDeck> {
    const client = await this.clientFor(tenantId);
    try {
      const deck = await client.get(generationId);
      if (typeof deck.creditsRemaining === 'number') {
        this.logger.debug(`gamma credits tenant=${tenantId} remaining=${deck.creditsRemaining}`);
      }
      return deck;
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.logger.warn(`gamma rate-limited tenant=${tenantId} retry_after_ms=${e.retryAfterMs}`);
        return { generationId, url: null, status: 'pending' };
      }
      throw new BadGatewayException(`gamma_provider_error: ${(e as Error).message}`);
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async clientFor(tenantId: string): Promise<GammaClient> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantGammaConfig.findUnique({ where: { tenantId } }),
    );
    if (!row) throw new NotFoundException('gamma_config_not_set');
    if (!row.enabled) throw new BadRequestException('gamma_disabled_for_tenant');
    if (!row.apiKeyCiphertext || !row.apiKeyIv || !row.apiKeyDekCiphertext || !row.apiKeyDekIv) {
      throw new BadRequestException('gamma_api_key_missing');
    }

    let apiKey: string;
    try {
      apiKey = decryptApiKey({
        apiKeyCiphertext: row.apiKeyCiphertext,
        apiKeyIv: row.apiKeyIv,
        apiKeyDekCiphertext: row.apiKeyDekCiphertext,
        apiKeyDekIv: row.apiKeyDekIv,
      });
    } catch (e) {
      this.logger.error(`gamma key decryption failed tenant=${tenantId}: ${(e as Error).message}`);
      throw new BadRequestException('gamma_key_decryption_failed_reenter_key');
    }

    return new GammaClient({ apiKey });
  }

  private toPublic(row: {
    workspaceName: string | null;
    workspaceId: string | null;
    apiKeyCiphertext: Buffer | null;
    proposalDriver: string;
    enabled: boolean;
    updatedAt: Date;
  }): PublicGammaConfig {
    return {
      workspaceName: row.workspaceName,
      workspaceId: row.workspaceId,
      apiKeySet: row.apiKeyCiphertext != null,
      proposalDriver: (row.proposalDriver as ProposalDriver) ?? 'llm',
      enabled: row.enabled,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
