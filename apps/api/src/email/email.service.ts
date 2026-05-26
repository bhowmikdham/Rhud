import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

/**
 * Email delivery via Amazon SES.
 *
 * Posture: best-effort. Auth/onboarding flows generate a token first and then
 * ask this service to send the email. If SES isn't configured (dev) or the
 * send fails (sandbox limit hit, throttled), we log and return false — the
 * calling flow decides whether to surface the failure to the user. For magic
 * link in dev specifically, the controller still returns the token in the
 * response when NODE_ENV !== 'production', so devs aren't blocked by missing
 * email infrastructure.
 *
 * Templates live in this file (not in a template engine) because (1) we have
 * a small handful, (2) inline HTML + plaintext fallbacks are easier to keep
 * in sync, (3) no extra dep.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: SESClient | null;
  private readonly from: string | null;

  constructor() {
    const from = process.env.EMAIL_FROM_ADDRESS;
    const region = process.env.SES_REGION ?? process.env.AWS_REGION ?? 'ap-south-1';

    this.from = from ?? null;
    // No EMAIL_FROM_ADDRESS → assume SES isn't configured (typical for local dev).
    // Skip constructing the client so calls become no-op log-and-return-false.
    this.client = from ? new SESClient({ region }) : null;

    if (!this.client) {
      this.logger.log('email service disabled (EMAIL_FROM_ADDRESS not set)');
    } else {
      this.logger.log(`email service ready: from=${from} region=${region}`);
    }
  }

  /**
   * Magic-link sign-in email. Sent in response to POST /auth/magic-link/request.
   * The link points at the web app, which consumes the token via
   * POST /auth/magic-link/consume.
   */
  async sendMagicLink(args: {
    to: string;
    magicUrl: string;
    expiresInMinutes: number;
  }): Promise<boolean> {
    const subject = 'Your sign-in link for Rhud';
    const html = renderMagicLinkHtml(args);
    const text = renderMagicLinkText(args);
    return this.send({ to: args.to, subject, html, text });
  }

  /**
   * Password reset email. Sent in response to POST /auth/password/reset/request.
   */
  async sendPasswordReset(args: {
    to: string;
    resetUrl: string;
    expiresInMinutes: number;
  }): Promise<boolean> {
    const subject = 'Reset your Rhud password';
    const html = renderPasswordResetHtml(args);
    const text = renderPasswordResetText(args);
    return this.send({ to: args.to, subject, html, text });
  }

  /**
   * Team-invite email. Sent when an admin invites someone into their tenant.
   */
  async sendInvite(args: {
    to: string;
    inviteUrl: string;
    inviterName: string;
    tenantName: string;
  }): Promise<boolean> {
    const subject = `${args.inviterName} invited you to ${args.tenantName} on Rhud`;
    const html = renderInviteHtml(args);
    const text = renderInviteText(args);
    return this.send({ to: args.to, subject, html, text });
  }

  // ── internal ───────────────────────────────────────────────────────
  private async send(args: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<boolean> {
    if (!this.client || !this.from) {
      this.logger.debug(`email skipped (not configured): to=${args.to} subject=${args.subject}`);
      return false;
    }

    const cmd = new SendEmailCommand({
      Source: this.from,
      Destination: { ToAddresses: [args.to] },
      Message: {
        Subject: { Charset: 'UTF-8', Data: args.subject },
        Body: {
          Html: { Charset: 'UTF-8', Data: args.html },
          Text: { Charset: 'UTF-8', Data: args.text },
        },
      },
    });

    try {
      const res = await this.client.send(cmd);
      this.logger.log(`sent email to=${args.to} messageId=${res.MessageId}`);
      return true;
    } catch (err) {
      const e = err as Error & { name?: string };
      // MessageRejected typically = SES sandbox + unverified recipient.
      // Surface that case at warn level so it's visible without being alarming.
      const level = e.name === 'MessageRejected' ? 'warn' : 'error';
      this.logger[level](`failed to send email to=${args.to}: ${e.name ?? 'Error'}: ${e.message}`);
      return false;
    }
  }
}

// ── templates ────────────────────────────────────────────────────────
// Plain inline HTML — easier to maintain than fighting a templating lib for
// a handful of small messages. Email clients are picky; keep CSS inline and
// avoid anything fancy.

function shellHtml(title: string, bodyInner: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;color:#111;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f5f5f5;padding:32px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="560" style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 2px rgba(0,0,0,0.04);">
        <tr><td>
          <div style="font-size:18px;font-weight:700;letter-spacing:-0.02em;margin-bottom:24px;">rhud</div>
          ${bodyInner}
          <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;">
          <div style="font-size:12px;color:#666;line-height:1.5;">
            If you didn't request this, you can safely ignore this email.<br>
            Rhud · Sent from rhud.net
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function renderMagicLinkHtml(args: { magicUrl: string; expiresInMinutes: number }): string {
  const body = `
    <div style="font-size:22px;font-weight:600;margin-bottom:8px;">Sign in to Rhud</div>
    <p style="margin:0 0 24px;color:#444;line-height:1.5;">Click the button below to sign in. The link is single-use and expires in ${args.expiresInMinutes} minutes.</p>
    <a href="${escapeAttr(args.magicUrl)}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Sign in</a>
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.5;">Or copy this link into your browser:<br><a href="${escapeAttr(args.magicUrl)}" style="color:#444;word-break:break-all;">${escapeHtml(args.magicUrl)}</a></p>
  `;
  return shellHtml('Sign in to Rhud', body);
}

function renderMagicLinkText(args: { magicUrl: string; expiresInMinutes: number }): string {
  return [
    'Sign in to Rhud',
    '',
    `Click this link to sign in (expires in ${args.expiresInMinutes} minutes):`,
    args.magicUrl,
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

function renderPasswordResetHtml(args: { resetUrl: string; expiresInMinutes: number }): string {
  const body = `
    <div style="font-size:22px;font-weight:600;margin-bottom:8px;">Reset your password</div>
    <p style="margin:0 0 24px;color:#444;line-height:1.5;">Click the button below to choose a new password. The link expires in ${args.expiresInMinutes} minutes.</p>
    <a href="${escapeAttr(args.resetUrl)}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Reset password</a>
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.5;">Or copy this link into your browser:<br><a href="${escapeAttr(args.resetUrl)}" style="color:#444;word-break:break-all;">${escapeHtml(args.resetUrl)}</a></p>
  `;
  return shellHtml('Reset your Rhud password', body);
}

function renderPasswordResetText(args: { resetUrl: string; expiresInMinutes: number }): string {
  return [
    'Reset your Rhud password',
    '',
    `Click this link to choose a new password (expires in ${args.expiresInMinutes} minutes):`,
    args.resetUrl,
    '',
    "If you didn't request this, you can safely ignore this email.",
  ].join('\n');
}

function renderInviteHtml(args: { inviteUrl: string; inviterName: string; tenantName: string }): string {
  const body = `
    <div style="font-size:22px;font-weight:600;margin-bottom:8px;">You've been invited to ${escapeHtml(args.tenantName)}</div>
    <p style="margin:0 0 24px;color:#444;line-height:1.5;"><strong>${escapeHtml(args.inviterName)}</strong> invited you to join their team on Rhud. Click the button below to accept and set your password.</p>
    <a href="${escapeAttr(args.inviteUrl)}" style="display:inline-block;background:#111;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;">Accept invite</a>
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.5;">Or copy this link into your browser:<br><a href="${escapeAttr(args.inviteUrl)}" style="color:#444;word-break:break-all;">${escapeHtml(args.inviteUrl)}</a></p>
  `;
  return shellHtml(`Invite to ${args.tenantName}`, body);
}

function renderInviteText(args: { inviteUrl: string; inviterName: string; tenantName: string }): string {
  return [
    `You've been invited to ${args.tenantName}`,
    '',
    `${args.inviterName} invited you to join their team on Rhud.`,
    'Click this link to accept and set your password:',
    args.inviteUrl,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  // Same escaping is safe for href values, where browsers tolerate &amp; in URLs.
  return escapeHtml(s);
}
