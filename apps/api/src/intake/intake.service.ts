/**
 * Phase E — shared orchestration for non-UI ingestion paths.
 *
 * Both `EmailIntakeController` (Postmark webhook) and
 * `PartnerIntakeController` (token-authed POST) collapse their channel-
 * specific request handling down to a normalised `InboundIntakePayload`
 * and call `createFromInboundPayload()` here. One pipeline:
 *
 *   1. Issue an engagement at status='issued' via
 *      `EngagementsService.issueForIntake()`. Emits the
 *      `intake_email` / `intake_partner` thread event.
 *   2. Upload each attachment (or the synthetic body file) to S3 via
 *      `S3Service.uploadBytes()` and register an `engagement_files`
 *      row. Emits `file_uploaded`.
 *   3. Fire `ExtractionService.kickoff()` per file — fire-and-forget
 *      (matches the manual-flow gathering pattern).
 *   4. Fire `ClassificationService.classifyOnSubmit()` — fire-and-
 *      forget; silent failure is OK (the manual classify chip can be
 *      used as a fallback).
 *
 * Attachment failures DO NOT roll back the engagement. The engagement
 * row is the canonical record; a failed upload is recoverable via
 * support / re-upload UI. Each attachment runs in its own try/catch.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { InboundIntakePayload, IntakeResult } from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { S3Service } from '../storage/s3.service.js';
import { ExtractionService } from '../extraction/extraction.service.js';
import { ClassificationService } from '../classification/classification.service.js';
import { EngagementsService } from '../engagements/engagements.service.js';

interface CreateArgs {
  tenantId: string;
  /** Resolved fallback chain: dto override → partner-token default →
   *  tenant default. The controller resolves these before calling us. */
  salesEmployeeId: string;
  templateId: string;
  /** Only set when source='partner_api' — wires the engagement.partner_token_id
   *  back-ref so the UI can render "via partner Acme Reseller". */
  partnerTokenId?: string;
  payload: InboundIntakePayload;
}

@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly s3: S3Service,
    private readonly extraction: ExtractionService,
    private readonly classification: ClassificationService,
    private readonly engagements: EngagementsService,
  ) {}

  async createFromInboundPayload(args: CreateArgs): Promise<IntakeResult> {
    const { tenantId, salesEmployeeId, templateId, partnerTokenId, payload } = args;

    // 1. Issue the engagement + emit the intake thread event atomically.
    const intakeEventType: 'intake_email' | 'intake_partner' =
      payload.source === 'inbound_email' ? 'intake_email' : 'intake_partner';
    const intakePayload: Record<string, unknown> = payload.source === 'inbound_email'
      ? {
          fromEmail: payload.clientEmail,
          subject: payload.subject ?? null,
          attachmentCount: payload.attachments.length,
          postmarkMessageId: payload.postmarkMessageId ?? null,
        }
      : {
          partnerTokenId: payload.partnerTokenId ?? null,
          partnerName: payload.partnerName ?? null,
          attachmentCount: payload.attachments.length,
          // Already redacted to /24 by the controller.
          sourceIp: payload.sourceIp ?? null,
        };

    const issueArgs: Parameters<EngagementsService['issueForIntake']>[0] = {
      tenantId,
      salesEmployeeId,
      templateId,
      source: payload.source,
      clientEmail: payload.clientEmail,
      intakeEvent: { eventType: intakeEventType, payload: intakePayload },
      ...(partnerTokenId ? { partnerTokenId } : {}),
      ...(payload.subject ? { name: payload.subject } : {}),
      ...(payload.clientName ? { clientName: payload.clientName } : {}),
      ...(payload.clientAddress ? { clientAddress: payload.clientAddress } : {}),
      ...(payload.contactName ? { contactName: payload.contactName } : {}),
      ...(payload.contactPhone ? { contactPhone: payload.contactPhone } : {}),
    };
    const { engagementId } = await this.engagements.issueForIntake(issueArgs);

    // 2. Upload attachments. If there are none AND we have a body, write
    //    the body as a synthetic file so the extraction pipeline can
    //    pull structured points from it the same way it does for PDFs.
    const filesToProcess: Array<{
      filename: string;
      contentType: string;
      bytes: Buffer;
    }> = payload.attachments.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      bytes: Buffer.from(a.bytes),
    }));
    if (filesToProcess.length === 0 && payload.bodyText?.trim()) {
      const syntheticName = payload.source === 'inbound_email'
        ? 'email-body.txt'
        : 'partner-brief.txt';
      filesToProcess.push({
        filename: syntheticName,
        contentType: 'text/plain; charset=utf-8',
        bytes: Buffer.from(payload.bodyText, 'utf-8'),
      });
    }

    for (const f of filesToProcess) {
      try {
        await this.persistAndExtract({ tenantId, engagementId, file: f });
      } catch (err) {
        // Engagement is canonical; log and move on. Operator can
        // resend / re-upload via the UI if a transient S3 hiccup ate
        // one attachment.
        this.logger.error(
          `intake file upload failed tenant=${tenantId} engagement=${engagementId} file=${f.filename}: ${(err as Error).message}`,
        );
      }
    }

    // 3. Fire-and-forget classification. Same treatment as
    //    GatheringService.submit(): the manual "Classify" chip is the
    //    fallback when this fails or runs against an empty context.
    void this.classification.classifyOnSubmit(tenantId, engagementId).catch((err) => {
      this.logger.warn(
        `classifyOnSubmit failed tenant=${tenantId} engagement=${engagementId}: ${(err as Error).message}`,
      );
    });

    return { engagementId, gatheringLink: null };
  }

  /** Internal — single-file upload + register + extraction kickoff. */
  private async persistAndExtract(args: {
    tenantId: string;
    engagementId: string;
    file: { filename: string; contentType: string; bytes: Buffer };
  }): Promise<void> {
    const { tenantId, engagementId, file } = args;
    const fileId = randomUUID();
    const s3Key = S3Service.keyForEngagementFile({
      tenantId,
      engagementId,
      fileId,
      filename: file.filename,
    });

    // Upload first — if S3 errors we don't want a dangling
    // engagement_files row with no object behind it.
    await this.s3.uploadBytes({
      key: s3Key,
      contentType: file.contentType,
      bytes: file.bytes,
    });

    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagementFile.create({
        data: {
          id: fileId,
          tenantId,
          engagementId,
          nodeId: null,
          // Quick-fill scoping documents — same lane as the manual
          // upload-attachment-then-extract path. The extraction service
          // already special-cases this kind.
          kind: 'scoping_doc',
          s3Key,
          filename: file.filename,
          sizeBytes: BigInt(file.bytes.length),
          contentType: file.contentType,
          extractionStatus: 'pending',
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'file_uploaded',
        actorType: 'integration',
        actorId: 'intake_service',
        payload: {
          fileId,
          filename: file.filename,
          contentType: file.contentType,
          sizeBytes: file.bytes.length,
        },
      });
    });

    // Fire-and-forget extraction — kickoff returns void and uses its
    // own retry queue for transient failures.
    void this.extraction.kickoff(tenantId, fileId).catch((err) => {
      this.logger.warn(
        `extraction.kickoff failed tenant=${tenantId} file=${fileId}: ${(err as Error).message}`,
      );
    });
  }
}
