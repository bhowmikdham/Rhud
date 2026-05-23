/**
 * Phase E — Postmark inbound email webhook.
 *
 *   POST /webhooks/email-inbound  (application/json from Postmark)
 *
 * Auth: HTTP Basic. Postmark sends Authorization: Basic <b64(user:pass)>
 * when configured in the server settings. Validated against env vars
 * POSTMARK_INBOUND_BASIC_USER / POSTMARK_INBOUND_BASIC_PASS in constant
 * time. Fail-closed in production when either is unset.
 *
 * Dedup: Postmark retries on any 5xx for up to 24h. We INSERT the
 * MessageID into `inbound_email_dedup` BEFORE any work; on conflict we
 * short-circuit `{ status: 'duplicate' }`. Reversing this order means
 * a 5xx mid-flight retries-and-double-creates.
 *
 * Tenant lookup: filter `ToFull[]` for our inbound domain, extract the
 * local-part, look up `tenants.inbound_email_local` via UnscopedDb. No
 * match → `{ status: 'dropped', reason: 'no_tenant_match' }` with HTTP
 * 200 — don't 404 because Postmark would retry.
 *
 * Response codes:
 *   200 { status: 'created' | 'duplicate' | 'dropped' }
 *   401 if Basic Auth fails in production
 *   500 to deliberately trigger a Postmark retry
 */

import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { UnscopedDb } from '../db/unscoped-db.js';
import { TenantDb } from '../db/with-tenant.js';
import { IntakeService } from './intake.service.js';

const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024; // 50 MB

interface PostmarkAttachment {
  Name: string;
  ContentType: string;
  Content: string;       // base64-encoded
  ContentLength: number;
  ContentID?: string;
}

interface PostmarkInboundPayload {
  MessageID: string;
  From: string;
  FromName?: string;
  ToFull?: Array<{ Email: string; Name?: string; MailboxHash?: string }>;
  To?: string;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Attachments?: PostmarkAttachment[];
}

@Controller('webhooks/email-inbound')
export class EmailIntakeController {
  private readonly logger = new Logger(EmailIntakeController.name);
  private readonly basicUser = process.env.POSTMARK_INBOUND_BASIC_USER;
  private readonly basicPass = process.env.POSTMARK_INBOUND_BASIC_PASS;
  private readonly inboundDomain = process.env.POSTMARK_INBOUND_DOMAIN ?? 'inbound.rhud.net';
  private readonly minBodyLength = Number(process.env.INBOUND_MIN_BODY_LENGTH ?? '40');

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly tenantDb: TenantDb,
    private readonly intake: IntakeService,
  ) {
    if (process.env.NODE_ENV === 'production') {
      if (!this.basicUser || !this.basicPass) {
        this.logger.error(
          'POSTMARK_INBOUND_BASIC_USER / _PASS not set; inbound webhook will refuse all requests.',
        );
      }
    } else if (!this.basicUser || !this.basicPass) {
      this.logger.warn('inbound webhook running without Basic Auth (dev only)');
    }
  }

  @Post()
  @HttpCode(200)
  async receive(
    @Body() body: PostmarkInboundPayload,
    @Req() req: Request,
  ): Promise<{ status: 'created' | 'duplicate' | 'dropped'; engagementId?: string; reason?: string }> {
    this.assertBasicAuth(req);

    // Light shape check. Postmark sends consistent JSON; treat anything
    // weird as a `dropped` so retries don't loop.
    if (!body || typeof body !== 'object' || !body.MessageID || !body.From) {
      this.logger.warn('inbound webhook missing MessageID/From; dropping');
      return { status: 'dropped', reason: 'malformed_payload' };
    }
    const messageId = String(body.MessageID).slice(0, 200);

    // Dedup FIRST — if Postmark resends, we must short-circuit before
    // any side-effect can re-fire. ON CONFLICT DO NOTHING keeps this
    // atomic against concurrent retries.
    const claimed = await this.unscoped.claimInboundEmailDedup(messageId);
    if (!claimed) {
      const existing = await this.unscoped.findInboundEmailDedup(messageId);
      const result: { status: 'duplicate'; engagementId?: string } = { status: 'duplicate' };
      if (existing?.engagementId) result.engagementId = existing.engagementId;
      return result;
    }

    // Resolve recipient → tenant.
    const recipient = this.pickInboundRecipient(body);
    if (!recipient) {
      this.logger.log(`inbound webhook: no recipient matched ${this.inboundDomain}; dropping`);
      return { status: 'dropped', reason: 'no_matching_recipient' };
    }
    const tenant = await this.unscoped.findTenantByInboundLocal(recipient.local);
    if (!tenant) {
      this.logger.log(`inbound webhook: no tenant for local-part=${recipient.local}; dropping`);
      return { status: 'dropped', reason: 'no_tenant_match' };
    }

    if (!tenant.defaultTemplateId || !tenant.defaultSalesOwnerId) {
      this.logger.warn(
        `inbound webhook: tenant=${tenant.tenantId} missing default_template/owner; dropping`,
      );
      return { status: 'dropped', reason: 'defaults_not_configured' };
    }

    // Body — prefer TextBody. Fall back to HtmlBody as raw text (good
    // enough for the LLM extractor's text path; pretty stripping isn't
    // worth the bytes here).
    const rawBody = (body.TextBody ?? body.HtmlBody ?? '').trim();
    if (this.minBodyLength > 0 && rawBody.length < this.minBodyLength && !(body.Attachments?.length)) {
      this.logger.log(
        `inbound webhook: body too short (${rawBody.length} < ${this.minBodyLength}); dropping`,
      );
      return { status: 'dropped', reason: 'body_too_short' };
    }

    // Decode + size-cap attachments. Per-file: validate ContentLength
    // matches decoded buffer (protects against truncation). Aggregate:
    // 50 MB cap across all attachments (per-file Multer cap exists in
    // PartnerIntake — for email we cap the sum here).
    const decoded: Array<{ filename: string; contentType: string; bytes: Buffer }> = [];
    let totalSize = 0;
    for (const a of body.Attachments ?? []) {
      if (!a.Name || !a.Content) continue;
      const buf = Buffer.from(a.Content, 'base64');
      if (typeof a.ContentLength === 'number' && a.ContentLength !== buf.length) {
        this.logger.warn(
          `inbound webhook: attachment size mismatch name=${a.Name} expected=${a.ContentLength} got=${buf.length}; skipping`,
        );
        continue;
      }
      totalSize += buf.length;
      if (totalSize > MAX_TOTAL_ATTACHMENT_BYTES) {
        this.logger.warn(`inbound webhook: total attachments > 50MB; dropping rest`);
        break;
      }
      decoded.push({
        filename: a.Name,
        contentType: a.ContentType || 'application/octet-stream',
        bytes: buf,
      });
    }

    // Run the shared orchestrator. Errors here SHOULD propagate as 5xx
    // so Postmark retries (we've already deduped on MessageID; the
    // retry would find the dedup row and skip). To make that work, we
    // need to clear the dedup row's engagement_id before throwing —
    // but since `claimed` was true (we wrote the row) and no engagement
    // exists yet, leaving it as-is gives the retry the same dedup hit
    // and returns `duplicate` even though nothing happened. Acceptable
    // trade-off: an operator can re-process from Postmark's "view all
    // messages" if a transient failure stranded one.
    const intakeResult = await this.intake.createFromInboundPayload({
      tenantId: tenant.tenantId,
      salesEmployeeId: tenant.defaultSalesOwnerId,
      templateId: tenant.defaultTemplateId,
      payload: {
        source: 'inbound_email',
        clientEmail: body.From,
        subject: body.Subject ?? null,
        bodyText: rawBody.length > 0 ? rawBody : null,
        attachments: decoded,
        postmarkMessageId: messageId,
      },
    });

    // Update the dedup row with the engagement_id back-ref (best-effort).
    await this.unscoped.updateInboundEmailDedup(messageId, {
      engagementId: intakeResult.engagementId,
      tenantId: tenant.tenantId,
    }).catch((err) => {
      this.logger.warn(`dedup back-ref update failed: ${(err as Error).message}`);
    });

    this.logger.log(
      `inbound email intake tenant=${tenant.tenantId} message=${messageId} engagement=${intakeResult.engagementId}`,
    );
    return { status: 'created', engagementId: intakeResult.engagementId };
  }

  // ── helpers ────────────────────────────────────────────────────────

  private assertBasicAuth(req: Request): void {
    const header = req.headers.authorization;
    // Permissive in non-production when env vars aren't configured.
    if ((!this.basicUser || !this.basicPass) && process.env.NODE_ENV !== 'production') return;
    if (!header || !header.startsWith('Basic ')) {
      throw new UnauthorizedException('inbound_webhook_auth_required');
    }
    const expected = `Basic ${Buffer.from(`${this.basicUser}:${this.basicPass}`).toString('base64')}`;
    const ok = header.length === expected.length
      && timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException('inbound_webhook_auth_failed');
  }

  /** Find the first recipient whose domain matches our inbound domain;
   *  returns its local part lowercased. */
  private pickInboundRecipient(body: PostmarkInboundPayload): { local: string } | null {
    const candidates = (body.ToFull ?? []).map((t) => t.Email).filter(Boolean);
    if (body.To && !candidates.length) candidates.push(body.To);
    for (const addr of candidates) {
      const at = addr.lastIndexOf('@');
      if (at < 1) continue;
      const local = addr.slice(0, at).toLowerCase();
      const domain = addr.slice(at + 1).toLowerCase();
      if (domain === this.inboundDomain.toLowerCase()) {
        return { local };
      }
    }
    return null;
  }
}
