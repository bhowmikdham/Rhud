/**
 * Direct-ingest entry points — see docs/direct-ingest.md §5.
 *
 *   POST /ingest/text          — paste-text → opportunity (one-shot)
 *   POST /ingest/file/presign  — file upload step 1: get presigned URL
 *
 * The "promote artifact(s) → opportunity" endpoint lives at
 * POST /opportunities/from-ingest on the EngagementsController, since
 * the resource produced is an engagement and we want it under the
 * /opportunities namespace.
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TenantDb } from '../db/with-tenant.js';
import { S3Service } from '../storage/s3.service.js';
import { IngestionService } from './ingestion.service.js';
import { IngestFilePresignDto, IngestTextDto } from './dto.js';

@Controller('ingest')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IngestionController {
  constructor(
    private readonly svc: IngestionService,
    private readonly tenantDb: TenantDb,
    private readonly s3: S3Service,
  ) {}

  /**
   * Paste-text direct-ingest. Inline JSON body — the rep already
   * holds the text in memory, no presign dance needed. One call:
   * receive + promote + extraction kickoff.
   */
  @Post('text')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  async text(
    @Req() req: AuthedRequest,
    @Body() dto: IngestTextDto,
  ): Promise<{ engagementId: string; artifactIds: string[] }> {
    if (!dto.rawText.trim()) throw new BadRequestException('raw_text_empty');
    return this.svc.receiveAndPromote({
      tenantId: req.tenantId,
      source: 'paste_text',
      content: { kind: 'text', data: { rawText: dto.rawText } },
      receivedBy: req.user.sub,
      salesEmployeeId: req.user.sub,
      overrides: {
        clientEmail: dto.clientEmail,
        ...(dto.clientName !== undefined    ? { clientName:    dto.clientName }    : {}),
        ...(dto.clientAddress !== undefined ? { clientAddress: dto.clientAddress } : {}),
        ...(dto.contactName !== undefined   ? { contactName:   dto.contactName }   : {}),
        ...(dto.contactPhone !== undefined  ? { contactPhone:  dto.contactPhone }  : {}),
      },
      ...(dto.name ? { name: dto.name } : {}),
    });
  }

  /**
   * Step 1 of two-step file ingestion. Creates the IngestionArtifact
   * row (status='received', s3Key pre-set) and returns a presigned
   * PUT URL the client uploads to. Mirrors the existing gathering
   * flow (see apps/api/src/gathering/gathering.service.ts:809).
   *
   * After the upload, the client calls POST /opportunities/from-ingest
   * with the returned `artifactId` to promote the artifact into an
   * engagement. We deliberately keep these two steps separate so the
   * rep can drop multiple files, see each extraction status pill, and
   * only confirm "Create opportunity" once they've reviewed.
   */
  @Post('file/presign')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  async filePresign(
    @Req() req: AuthedRequest,
    @Body() dto: IngestFilePresignDto,
  ): Promise<{
    artifactId: string;
    uploadUrl: string;
    s3Key: string;
    expiresAt: string;
  }> {
    if (dto.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException('file_too_large');
    }
    // Document-type sniff: RFP/SOW files would ideally be tagged at
    // upload time so the source chip reads correctly without waiting
    // for extraction. Sprint 1 defers that classifier — see
    // docs/direct-ingest.md §9 Sprint 2. For now everything lands as
    // `direct_upload` and the chip says "Upload".
    const source = 'direct_upload';

    const artifactId = randomUUID();
    const key = S3Service.keyForIngestionArtifact({
      tenantId: req.tenantId,
      artifactId,
      filename: dto.filename,
    });
    const { url, expiresAt } = await this.s3.presignPut({
      key,
      contentType: dto.contentType,
    });

    // Pre-create the artifact row so the post-upload promote() call
    // finds a target. status='received' is correct even though the
    // bytes aren't in S3 yet — extraction handles NoSuchKey via its
    // retry queue (apps/api/src/storage/s3.service.ts:82).
    await this.tenantDb.run(req.tenantId, async (db) => {
      await db.ingestionArtifact.create({
        data: {
          id: artifactId,
          tenantId: req.tenantId,
          source,
          kind: 'file',
          status: 'received',
          s3Key: key,
          contentType: dto.contentType,
          sizeBytes: dto.sizeBytes,
          originalName: dto.filename,
          receivedBy: req.user.sub,
        },
      });
    });

    return { artifactId, uploadUrl: url, s3Key: key, expiresAt };
  }
}
