import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { PredictionService } from './prediction.service.js';

const APPROVAL_CHOICES = ['base', 'recommended', 'aggressive', 'custom'] as const;
type ApprovalChoice = (typeof APPROVAL_CHOICES)[number];

class ApproveDto {
  @IsUUID() predictionId!: string;

  @IsIn(APPROVAL_CHOICES as unknown as string[])
  choice!: ApprovalChoice;

  /** Required when choice === 'custom'. Cents. */
  @ValidateIf((o: ApproveDto) => o.choice === 'custom')
  @IsInt()
  @Min(0)
  customPriceCents?: number;

  /** Required when choice === 'custom' (audit trail for the override). */
  @ValidateIf((o: ApproveDto) => o.choice === 'custom')
  @IsString()
  @MaxLength(2000)
  comment?: string;

  /** Optional otherwise — the manager can leave a note on any approval. */
  @ValidateIf((o: ApproveDto) => o.choice !== 'custom')
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  optionalComment?: string;
}

/**
 * Adaptive-pricing predict + opportunity-level approve.
 *
 * Mounted at both /opportunities/:id/... and /engagements/:id/... so the
 * UI can use either name (the rename last sprint kept the engagements
 * route as a back-compat alias).
 */
@Controller([
  'opportunities/:id',
  'engagements/:id',
])
@UseGuards(JwtAuthGuard, RolesGuard)
export class PredictionController {
  constructor(
    private readonly svc: PredictionService,
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  @Post('predict')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  predict(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.predictForEngagement(req.tenantId, engagementId);
  }

  @Get('predictions')
  list(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.listForEngagement(req.tenantId, engagementId);
  }

  @Get('predictions/latest')
  latest(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.latestForEngagement(req.tenantId, engagementId);
  }

  @Post('approve')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  async approve(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: ApproveDto,
  ) {
    const prediction = await this.svc.findById(req.tenantId, dto.predictionId);
    if (!prediction || prediction.engagementId !== engagementId) {
      throw new BadRequestException('prediction_not_found_for_engagement');
    }

    let approvedCents: number;
    switch (dto.choice) {
      case 'base':         approvedCents = prediction.basePriceCents; break;
      case 'recommended':  approvedCents = prediction.predictedPriceCents; break;
      case 'aggressive':   approvedCents = prediction.bandLowCents; break;
      case 'custom':
        if (dto.customPriceCents == null) throw new BadRequestException('custom_price_required');
        approvedCents = dto.customPriceCents;
        break;
    }

    const eventType =
      dto.choice === 'custom' ? 'approval_adjusted' : 'approval_granted';

    const comment =
      dto.choice === 'custom' ? dto.comment : dto.optionalComment;

    const updated = await this.tenantDb.run(req.tenantId, async (db) => {
      const eng = await db.engagement.update({
        where: { id: engagementId },
        data: {
          approvedPriceCents: BigInt(approvedCents),
          status: 'approved',
        },
        select: { id: true, approvedPriceCents: true, status: true },
      });
      // Mirror onto engagement_quotes too — that's what the legacy quote
      // approval card reads from. Both rows agree post-approval.
      await db.engagementQuote.updateMany({
        where: { engagementId },
        data: {
          approvedPriceCents: BigInt(approvedCents),
          approvedAt: new Date(),
          approvedBy: req.user.sub,
        },
      });
      await this.thread.emitWithin(db, req.tenantId, {
        engagementId,
        eventType,
        actorType: 'user',
        actorId: req.user.sub,
        payload: {
          predictionId: prediction.id,
          choice: dto.choice,
          approvedPriceCents: approvedCents,
          basePriceCents: prediction.basePriceCents,
          predictedPriceCents: prediction.predictedPriceCents,
          regime: prediction.regime,
          ...(comment ? { comment } : {}),
        },
      });
      return eng;
    });

    void this.thread.dispatchAfterCommit(req.tenantId, {
      engagementId,
      eventType,
      actorType: 'user',
      actorId: req.user.sub,
      payload: { approvedPriceCents: approvedCents, choice: dto.choice },
    });

    return {
      engagementId: updated.id,
      approvedPriceCents: Number(updated.approvedPriceCents ?? 0),
      status: updated.status,
      predictionId: prediction.id,
      choice: dto.choice,
    };
  }
}
