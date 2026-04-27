/**
 * Microsoft Identity Platform + Microsoft Graph HTTP client.
 *
 * Pure functions over `fetch` — no @azure/msal-node dependency. The
 * authcode flow is just two endpoints (authorize + token) and the
 * sendMail call is one Graph API POST, so a thin client is cheaper
 * than an SDK that ships its own ESM/CJS quirks.
 *
 * Multi-tenant in the Microsoft sense: we register against the
 * `common` authority so both work/school accounts AND personal
 * Outlook.com accounts can connect with the same app registration.
 */
/* global URLSearchParams */
import { Logger } from '@nestjs/common';

const AUTHORITY = 'https://login.microsoftonline.com/common';
const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * Scopes we request on every connect. Documented vs runtime-effective:
 *   - openid / profile / email — gives us the user info to fill `accountEmail`.
 *   - Mail.Send — the actual privilege we need.
 *   - offline_access — required to receive a refresh token.
 *
 * Microsoft normalises scope strings on the consent page; we may see
 * shorter forms come back in the token response, that's expected.
 */
export const OUTLOOK_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'Mail.Send',
] as const;

export interface OutlookTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
  scopes: string;
  /** Email of the connected mailbox — used as the From: address. */
  accountEmail: string;
}

export interface OutlookSendArgs {
  accessToken: string;
  to: string;
  subject: string;
  /** Plain-text body. Microsoft Graph accepts both Text and HTML; we
   *  use Text so what the rep typed in our modal arrives verbatim. */
  body: string;
  /** Optional inline attachment as raw bytes. Encoded base64 server-
   *  side. Graph caps inline attachments at ~3 MB; bigger needs the
   *  upload session API which we don't implement yet. */
  attachment?: {
    filename: string;
    contentType: string;
    bytes: Buffer;
  };
}

export class OutlookOauthError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OutlookOauthError';
  }
}

export class OutlookClient {
  private readonly logger = new Logger(OutlookClient.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(opts: { clientId: string; clientSecret: string; redirectUri: string }) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.redirectUri = opts.redirectUri;
  }

  /** Authorize URL the browser is redirected to. `state` is opaque —
   *  caller signs it so we can verify on callback (CSRF protection). */
  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      response_mode: 'query',
      scope: OUTLOOK_SCOPES.join(' '),
      state,
      // Force consent so test runs always exercise the consent screen
      // and the user can re-grant scopes after we add new ones. Comment
      // out for a smoother prod UX once the scope set stabilises.
      prompt: 'select_account',
    });
    return `${AUTHORITY}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  /** Exchange authcode for {access, refresh} tokens. */
  async exchangeCode(code: string): Promise<OutlookTokens> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      scope: OUTLOOK_SCOPES.join(' '),
    });
    const tokens = await this.tokenRequest(body);
    const accountEmail = await this.fetchUserPrincipal(tokens.accessToken);
    return { ...tokens, accountEmail };
  }

  /** Refresh an access token using the long-lived refresh token. */
  async refresh(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    scopes: string;
  }> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: OUTLOOK_SCOPES.join(' '),
    });
    return this.tokenRequest(body);
  }

  /** Send an email via Graph. Returns true on 202 (Graph's success
   *  status for sendMail). Throws OutlookOauthError otherwise. */
  async sendMail(args: OutlookSendArgs): Promise<void> {
    const message: Record<string, unknown> = {
      subject: args.subject,
      body: { contentType: 'Text', content: args.body },
      toRecipients: [{ emailAddress: { address: args.to } }],
    };
    if (args.attachment) {
      message.attachments = [{
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: args.attachment.filename,
        contentType: args.attachment.contentType,
        contentBytes: args.attachment.bytes.toString('base64'),
      }];
    }

    const res = await fetch(`${GRAPH}/me/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: true }),
    });

    if (res.status === 202) return;
    const text = await res.text().catch(() => '');
    // 401 = expired token (caller should refresh). 403 = scope or
    // mailbox-policy denial. 4xx body usually has Graph's structured
    // error JSON; surface the first 300 chars for the UI.
    throw new OutlookOauthError(
      res.status === 401 ? 'token_expired' : `graph_${res.status}`,
      `outlook sendMail ${res.status}: ${text.slice(0, 300)}`,
    );
  }

  // ── Internals ──────────────────────────────────────────────────────

  private async tokenRequest(body: URLSearchParams): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt: Date;
    scopes: string;
  }> {
    const res = await fetch(`${AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) {
      // Microsoft returns JSON with `error` + `error_description`.
      let code = 'token_request_failed';
      let desc = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string; error_description?: string };
        if (j.error) code = j.error;
        if (j.error_description) desc = j.error_description;
      } catch { /* keep raw */ }
      throw new OutlookOauthError(code, `outlook token ${res.status}: ${desc}`);
    }
    const json = JSON.parse(text) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
    const expiresAt = new Date(Date.now() + (json.expires_in - 30) * 1000); // 30s safety margin
    return {
      accessToken: json.access_token,
      ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
      expiresAt,
      scopes: json.scope ?? '',
    };
  }

  private async fetchUserPrincipal(accessToken: string): Promise<string> {
    const res = await fetch(`${GRAPH}/me?$select=mail,userPrincipalName`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.warn(`outlook /me failed ${res.status}: ${text.slice(0, 200)}`);
      // Don't fail the whole connect — return a placeholder; the user
      // can disconnect + reconnect if they want it correct.
      return 'unknown@outlook';
    }
    const json = (await res.json()) as { mail?: string; userPrincipalName?: string };
    // `mail` is the SMTP address; `userPrincipalName` is sometimes the
    // sign-in id (which can be the same, but not always). Prefer mail.
    return json.mail ?? json.userPrincipalName ?? 'unknown@outlook';
  }
}
