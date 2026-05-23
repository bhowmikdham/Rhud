/**
 * Phase E — public, token-authed partner intake.
 *
 *   POST /partner-intake/:token  (multipart/form-data)
 *
 * The token is BOTH the auth and the tenant locator. Verify pattern:
 *   1. Scan active partner_tokens via UnscopedDb (RLS bypass).
 *   2. argon2-verify the plaintext against each row's hash.
 *   3. Once matched, update last_used_at inside TenantDb.run().
 *   4. Resolve template + sales-owner fallback chain.
 *   5. Hand off to IntakeService.createFromInboundPayload().
 *
 * Body:
 *   - `clientEmail` (required), `name`, `bodyText` (optional),
 *   - up to 10 files, 50 MB each, in-memory via Multer.
 *
 * 201 response: `{ engagementId, status: 'issued', source: 'partner_api' }`.
 */

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { verifyToken } from '../gathering/token.util.js';
import { ipNetworkPrefix } from '../gathering/token.util.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { TenantDb } from '../db/with-tenant.js';
import { IntakeService } from './intake.service.js';
import { PartnerIntakeDto } from './dto.js';

const MAX_FILES = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB

@Controller('partner-intake')
export class PartnerIntakeController {
  private readonly logger = new Logger(PartnerIntakeController.name);

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly tenantDb: TenantDb,
    private readonly intake: IntakeService,
  ) {}

  @Post(':token')
  @HttpCode(201)
  @UseInterceptors(AnyFilesInterceptor({
    limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
  }))
  async receive(
    @Param('token') token: string,
    @Body() dto: PartnerIntakeDto,
    @UploadedFiles() files: Express.Multer.File[] = [],
    @Req() req: Request,
  ): Promise<{ engagementId: string; status: 'issued'; source: 'partner_api' }> {
    if (!token || token.length < 8) {
      throw new UnauthorizedException('invalid_partner_token');
    }

    // 1. Scan active partner tokens + argon2-verify in linear time.
    //    Mirrors the gathering token verify pattern. Hostile inputs
    //    cost ~5ms each (argon2 verify); 200 candidates is fine.
    const candidates = await this.unscoped.findActivePartnerTokens();
    let matched: typeof candidates[number] | null = null;
    for (const row of candidates) {
      if (await verifyToken(row.tokenHash, token)) {
        matched = row;
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_partner_token');

    // 2. Resolve template + sales owner. Per-token override beats tenant
    //    default; explicit dto override beats both.
    const { tenantId } = matched;
    const tenantDefaults = await this.tenantDb.run(tenantId, async (db) =>
      db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          defaultTemplateId: true,
          defaultSalesOwnerId: true,
          name: true,
        },
      }),
    );
    if (!tenantDefaults) throw new NotFoundException('tenant_not_found');

    const templateId =
      dto.templateId ?? matched.defaultTemplateId ?? tenantDefaults.defaultTemplateId;
    const salesEmployeeId =
      matched.defaultSalesOwnerId ?? tenantDefaults.defaultSalesOwnerId;
    if (!templateId) throw new BadRequestException('template_not_configured');
    if (!salesEmployeeId) throw new BadRequestException('sales_owner_not_configured');

    // 3. Update last_used_at; lookup the partner name for the
    //    intake_partner thread event payload + audit attribution.
    const partner = await this.tenantDb.run(tenantId, async (db) => {
      return db.partnerToken.update({
        where: { id: matched.id },
        data: { lastUsedAt: new Date() },
        select: { id: true, name: true },
      });
    });

    // 4. Hand off to the shared orchestrator. Convert Multer's in-
    //    memory files to the InboundAttachment shape.
    const sourceIp = ipNetworkPrefix(
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim()
      ?? req.socket.remoteAddress
      ?? '0.0.0.0',
    );
    const result = await this.intake.createFromInboundPayload({
      tenantId,
      salesEmployeeId,
      templateId,
      partnerTokenId: partner.id,
      payload: {
        source: 'partner_api',
        clientEmail: dto.clientEmail,
        subject: dto.name ?? null,
        bodyText: dto.bodyText ?? null,
        clientName: dto.clientName ?? null,
        clientAddress: dto.clientAddress ?? null,
        contactName: dto.contactName ?? null,
        contactPhone: dto.contactPhone ?? null,
        attachments: files.map((f) => ({
          filename: f.originalname,
          contentType: f.mimetype || 'application/octet-stream',
          bytes: f.buffer,
        })),
        partnerTokenId: partner.id,
        partnerName: partner.name,
        sourceIp,
      },
    });

    this.logger.log(
      `partner intake tenant=${tenantId} partner=${partner.name} engagement=${result.engagementId}`,
    );
    return { engagementId: result.engagementId, status: 'issued', source: 'partner_api' };
  }
}
