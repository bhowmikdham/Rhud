/**
 * Outlook integration service — token storage, refresh, and the
 * per-rep "send proposal email" entrypoint.
 *
 * App credentials live in the DB (tenant_outlook_app), one row per
 * workspace, set up by an admin via the UI. There is no env-var
 * fallback — admins manage everything from /integrations without
 * touching the server.
 *
 * Layering:
 *   - OutlookClient: pure HTTP, no DB.
 *   - This service: per-tenant client resolution, token persistence
 *     (envelope-encrypted), token-refresh on stale, signed-state
 *     for OAuth CSRF.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { TenantDb } from '../../db/with-tenant.js';
import { encryptApiKey, decryptApiKey } from '../../llm/llm.crypto.js';
import { OutlookClient, OutlookOauthError, type OutlookSendArgs } from './outlook.client.js';

export interface OutlookConnectionStatus {
  /** True when the rep's mailbox is authorized. */
  connected: boolean;
  /** Email of the connected mailbox; null when not connected. */
  accountEmail: string | null;
  /** True when an admin has set up the workspace's Microsoft app. */
  available: boolean;
  /** ISO of when the rep's tokens were last refreshed — debug aid. */
  updatedAt: string | null;
}

export interface OutlookAppConfig {
  /** Whether the workspace has any app config at all. */
  isConfigured: boolean;
  /** Public Application (client) ID — safe to display. */
  clientId: string | null;
  /** Server-derived redirect URI the admin must paste into Entra. */
  redirectUri: string;
  /** Last edit time, for "configured X ago" UI. */
  updatedAt: string | null;
}

export interface UpsertAppConfigArgs {
  clientId: string;
  clientSecret: string;
}

@Injectable()
export class OutlookService {
  private readonly logger = new Logger(OutlookService.name);

  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * The redirect URI the admin needs to register in Microsoft Entra.
   * Always the same per Rhud instance — defined by API_PUBLIC_URL +
   * a fixed path. Surfaced in the setup modal so the admin can copy-
   * paste it instead of guessing.
   */
  redirectUri(): string {
    const base = (process.env.API_PUBLIC_URL ?? 'http://localhost:8000').replace(/\/$/, '');
    return `${base}/integrations/outlook/callback`;
  }

  // ── Per-tenant app credentials (admin-managed) ────────────────────

  async getAppConfig(tenantId: string): Promise<OutlookAppConfig> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantOutlookApp.findUnique({
        where: { tenantId },
        select: { clientId: true, updatedAt: true },
      }),
    );
    return {
      isConfigured: !!row,
      clientId: row?.clientId ?? null,
      redirectUri: this.redirectUri(),
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async setAppConfig(tenantId: string, args: UpsertAppConfigArgs): Promise<OutlookAppConfig> {
    if (!args.clientId?.trim()) throw new ServiceUnavailableException('client_id_required');
    if (!args.clientSecret?.trim()) throw new ServiceUnavailableException('client_secret_required');
    const enc = encryptApiKey(args.clientSecret.trim());
    await this.tenantDb.run(tenantId, async (db) => {
      await db.tenantOutlookApp.upsert({
        where: { tenantId },
        create: {
          tenantId,
          clientId: args.clientId.trim(),
          clientSecretCiphertext: enc.apiKeyCiphertext,
          clientSecretIv: enc.apiKeyIv,
          clientSecretDekCiphertext: enc.apiKeyDekCiphertext,
          clientSecretDekIv: enc.apiKeyDekIv,
          updatedAt: new Date(),
        },
        update: {
          clientId: args.clientId.trim(),
          clientSecretCiphertext: enc.apiKeyCiphertext,
          clientSecretIv: enc.apiKeyIv,
          clientSecretDekCiphertext: enc.apiKeyDekCiphertext,
          clientSecretDekIv: enc.apiKeyDekIv,
          updatedAt: new Date(),
        },
      });
    });
    this.logger.log(`outlook app configured tenant=${tenantId} client_id=${args.clientId.slice(0, 8)}…`);
    return this.getAppConfig(tenantId);
  }

  /**
   * Wipe app config + cascade-clear all per-user tokens for this
   * tenant — the tokens were issued against the deleted Entra app and
   * would 401 on next refresh anyway.
   */
  async clearAppConfig(tenantId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.userIntegration.deleteMany({
        where: { tenantId, provider: 'outlook' },
      });
      await db.tenantOutlookApp.delete({
        where: { tenantId },
      }).catch(() => undefined);
    });
  }

  // ── Client resolution ─────────────────────────────────────────────

  /**
   * Build an OutlookClient from per-tenant DB config. Throws 503 with
   * `outlook_app_not_configured` when the admin hasn't set it up yet
   * — the UI surfaces that as "ask your admin" copy.
   */
  private async clientFor(tenantId: string): Promise<OutlookClient> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantOutlookApp.findUnique({ where: { tenantId } }),
    );
    if (!row) throw new ServiceUnavailableException('outlook_app_not_configured');
    let clientSecret: string;
    try {
      clientSecret = decryptApiKey({
        apiKeyCiphertext: row.clientSecretCiphertext,
        apiKeyIv: row.clientSecretIv,
        apiKeyDekCiphertext: row.clientSecretDekCiphertext,
        apiKeyDekIv: row.clientSecretDekIv,
      });
    } catch (e) {
      this.logger.error(`outlook secret decryption failed tenant=${tenantId}: ${(e as Error).message}`);
      throw new ServiceUnavailableException('outlook_secret_decryption_failed');
    }
    return new OutlookClient({
      clientId: row.clientId,
      clientSecret,
      redirectUri: this.redirectUri(),
    });
  }

  // ── OAuth state — signed nonce for CSRF + carrying userId/tenantId ──

  /**
   * Build a signed state parameter for the authorize redirect.
   *
   * Encodes {userId, tenantId, nonce, exp} as base64url JSON, then
   * appends an HMAC tag using JWT_SECRET. On callback we re-derive
   * the tag and compare in constant time.
   */
  signState(userId: string, tenantId: string): string {
    const payload = {
      uid: userId,
      tid: tenantId,
      n: randomBytes(8).toString('hex'),
      exp: Date.now() + 10 * 60 * 1000, // 10 minutes
    };
    const body = base64url(JSON.stringify(payload));
    const sig = base64url(this.hmac(body));
    return `${body}.${sig}`;
  }

  verifyState(state: string): { userId: string; tenantId: string } {
    const parts = state.split('.');
    if (parts.length !== 2) throw new UnauthorizedException('bad_state');
    const [body, sig] = parts;
    if (!body || !sig) throw new UnauthorizedException('bad_state');
    const expectedSig = base64url(this.hmac(body));
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('bad_state_sig');
    }
    let parsed: { uid?: string; tid?: string; exp?: number };
    try {
      parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new UnauthorizedException('bad_state_payload');
    }
    if (!parsed.uid || !parsed.tid || !parsed.exp) {
      throw new UnauthorizedException('bad_state_payload');
    }
    if (parsed.exp < Date.now()) {
      throw new UnauthorizedException('state_expired');
    }
    return { userId: parsed.uid, tenantId: parsed.tid };
  }

  private hmac(input: string): Buffer {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET unset — cannot sign OAuth state');
    return createHmac('sha256', secret).update(input).digest();
  }

  // ── User-facing reads ─────────────────────────────────────────────

  async getStatus(tenantId: string, userId: string): Promise<OutlookConnectionStatus> {
    const app = await this.tenantDb.run(tenantId, async (db) =>
      db.tenantOutlookApp.findUnique({ where: { tenantId }, select: { tenantId: true } }),
    );
    if (!app) {
      return { connected: false, accountEmail: null, available: false, updatedAt: null };
    }
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.userIntegration.findUnique({
        where: { userId_provider: { userId, provider: 'outlook' } },
        select: { accountEmail: true, updatedAt: true },
      }),
    );
    return {
      connected: !!row,
      accountEmail: row?.accountEmail ?? null,
      available: true,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
    };
  }

  async authorizeUrl(userId: string, tenantId: string): Promise<string> {
    const client = await this.clientFor(tenantId);
    return client.authorizeUrl(this.signState(userId, tenantId));
  }

  // ── OAuth callback ────────────────────────────────────────────────

  async completeConnect(code: string, state: string): Promise<{ userId: string; tenantId: string; accountEmail: string }> {
    const { userId, tenantId } = this.verifyState(state);
    const client = await this.clientFor(tenantId);
    const tokens = await client.exchangeCode(code);

    const access = encryptApiKey(tokens.accessToken);
    const refresh = tokens.refreshToken ? encryptApiKey(tokens.refreshToken) : null;

    await this.tenantDb.run(tenantId, async (db) => {
      await db.userIntegration.upsert({
        where: { userId_provider: { userId, provider: 'outlook' } },
        create: {
          userId,
          tenantId,
          provider: 'outlook',
          accountEmail: tokens.accountEmail,
          accessTokenCiphertext: access.apiKeyCiphertext,
          accessTokenIv: access.apiKeyIv,
          accessTokenDekCiphertext: access.apiKeyDekCiphertext,
          accessTokenDekIv: access.apiKeyDekIv,
          accessTokenExpiresAt: tokens.expiresAt,
          refreshTokenCiphertext: refresh?.apiKeyCiphertext ?? null,
          refreshTokenIv: refresh?.apiKeyIv ?? null,
          refreshTokenDekCiphertext: refresh?.apiKeyDekCiphertext ?? null,
          refreshTokenDekIv: refresh?.apiKeyDekIv ?? null,
          scopes: tokens.scopes,
          updatedAt: new Date(),
        },
        update: {
          accountEmail: tokens.accountEmail,
          accessTokenCiphertext: access.apiKeyCiphertext,
          accessTokenIv: access.apiKeyIv,
          accessTokenDekCiphertext: access.apiKeyDekCiphertext,
          accessTokenDekIv: access.apiKeyDekIv,
          accessTokenExpiresAt: tokens.expiresAt,
          refreshTokenCiphertext: refresh?.apiKeyCiphertext ?? null,
          refreshTokenIv: refresh?.apiKeyIv ?? null,
          refreshTokenDekCiphertext: refresh?.apiKeyDekCiphertext ?? null,
          refreshTokenDekIv: refresh?.apiKeyDekIv ?? null,
          scopes: tokens.scopes,
          updatedAt: new Date(),
        },
      });
    });

    this.logger.log(`outlook connected user=${userId} mailbox=${tokens.accountEmail}`);
    return { userId, tenantId, accountEmail: tokens.accountEmail };
  }

  async disconnect(tenantId: string, userId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.userIntegration.delete({
        where: { userId_provider: { userId, provider: 'outlook' } },
      }).catch(() => undefined);
    });
  }

  // ── Send a proposal email ─────────────────────────────────────────

  /**
   * Send the email from the connected mailbox. Refreshes the access
   * token on the fly when within 60s of expiry. Throws UnauthorizedException
   * with `outlook_reconnect_required` if the refresh fails.
   */
  async sendMail(
    tenantId: string,
    userId: string,
    args: Omit<OutlookSendArgs, 'accessToken'>,
  ): Promise<{ accountEmail: string }> {
    const client = await this.clientFor(tenantId);
    const accessToken = await this.getFreshAccessToken(tenantId, userId, client);
    const accountEmail = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.userIntegration.findUnique({
        where: { userId_provider: { userId, provider: 'outlook' } },
        select: { accountEmail: true },
      });
      return row?.accountEmail ?? '';
    });

    try {
      await client.sendMail({ ...args, accessToken });
    } catch (e) {
      if (e instanceof OutlookOauthError && e.code === 'token_expired') {
        // Race: token expired between our refresh check and the call.
        // One retry with a fresh token.
        const retry = await this.getFreshAccessToken(tenantId, userId, client, { force: true });
        await client.sendMail({ ...args, accessToken: retry });
      } else {
        throw e;
      }
    }
    return { accountEmail };
  }

  /**
   * Returns a non-expired access token, refreshing if needed. When
   * `force` is true, always refresh even if the cached token still
   * looks fresh — used as the second-attempt path on a 401.
   */
  private async getFreshAccessToken(
    tenantId: string,
    userId: string,
    client: OutlookClient,
    opts: { force?: boolean } = {},
  ): Promise<string> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.userIntegration.findUnique({
        where: { userId_provider: { userId, provider: 'outlook' } },
      }),
    );
    if (!row) throw new NotFoundException('outlook_not_connected');

    const stale = opts.force || row.accessTokenExpiresAt.getTime() - 60_000 < Date.now();
    if (!stale) {
      return decryptApiKey({
        apiKeyCiphertext: row.accessTokenCiphertext,
        apiKeyIv: row.accessTokenIv,
        apiKeyDekCiphertext: row.accessTokenDekCiphertext,
        apiKeyDekIv: row.accessTokenDekIv,
      });
    }

    if (
      !row.refreshTokenCiphertext ||
      !row.refreshTokenIv ||
      !row.refreshTokenDekCiphertext ||
      !row.refreshTokenDekIv
    ) {
      throw new UnauthorizedException('outlook_reconnect_required');
    }

    const refreshToken = decryptApiKey({
      apiKeyCiphertext: row.refreshTokenCiphertext,
      apiKeyIv: row.refreshTokenIv,
      apiKeyDekCiphertext: row.refreshTokenDekCiphertext,
      apiKeyDekIv: row.refreshTokenDekIv,
    });

    let refreshed;
    try {
      refreshed = await client.refresh(refreshToken);
    } catch (e) {
      this.logger.warn(`outlook refresh failed user=${userId}: ${(e as Error).message}`);
      throw new UnauthorizedException('outlook_reconnect_required');
    }

    const accessEnc = encryptApiKey(refreshed.accessToken);
    const refreshEnc = refreshed.refreshToken ? encryptApiKey(refreshed.refreshToken) : null;

    await this.tenantDb.run(tenantId, async (db) => {
      await db.userIntegration.update({
        where: { userId_provider: { userId, provider: 'outlook' } },
        data: {
          accessTokenCiphertext: accessEnc.apiKeyCiphertext,
          accessTokenIv: accessEnc.apiKeyIv,
          accessTokenDekCiphertext: accessEnc.apiKeyDekCiphertext,
          accessTokenDekIv: accessEnc.apiKeyDekIv,
          accessTokenExpiresAt: refreshed.expiresAt,
          ...(refreshEnc && {
            refreshTokenCiphertext: refreshEnc.apiKeyCiphertext,
            refreshTokenIv: refreshEnc.apiKeyIv,
            refreshTokenDekCiphertext: refreshEnc.apiKeyDekCiphertext,
            refreshTokenDekIv: refreshEnc.apiKeyDekIv,
          }),
          updatedAt: new Date(),
        },
      });
    });

    return refreshed.accessToken;
  }
}

function base64url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
