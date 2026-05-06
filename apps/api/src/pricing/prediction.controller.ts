import {
  BadRequestException,
  Body,
  ConflictException,
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
import { QuoteService } from './quote.service.js';
import { OdooService } from '../integrations/odoo/odoo.service.js';

const APPROVAL_CHOICES = ['base', 'recommended', 'aggressive', 'tech_adjusted', 'custom'] as const;
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

class RejectDto {
  /** The prediction this rejection is being recorded against. Optional —
   *  a manager may reject before any prediction even exists (e.g. scope
   *  is incomplete and they want it sent back to the client). */
  @IsOptional()
  @IsUUID()
  predictionId?: string;

  /** Why — required so the audit log + email body have substance. */
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

/**
 * Tech-team adjustment to the predicted price. The tech_team role is
 * the only one that uses this endpoint; admins can also call it for
 * support cases. The adjustment is bound to the prediction so a
 * subsequent re-predict invalidates it.
 */
class TechAdjustDto {
  @IsUUID() predictionId!: string;

  @IsInt()
  @Min(0)
  adjustedPriceCents!: number;

  /** Optional rationale — surfaced in the manager's approval card. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
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
    private readonly quotes: QuoteService,
    private readonly odoo: OdooService,
  ) {}

  /**
   * Re-predict the price.
   *
   * Re-evaluates the deterministic base FIRST, then runs the ML
   * modifier on top. This matters because: extracted-document points
   * may have been auto-promoted to engagement answers AFTER the
   * original quote was computed (the extraction queue could land
   * answers minutes later). Without re-eval'ing the base, the ML
   * modifier sees a stale zero base and the prediction stays zero.
   *
   * The quote re-compute is best-effort — if it fails (e.g. template
   * has no rate card), we still try ML predict so the user sees
   * something. The error path logs but doesn't surface.
   */
  @Post('predict')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  async predict(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    await this.quotes
      .computeAndPersistForEngagement(req.tenantId, engagementId)
      .catch(() => undefined);
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

  /**
   * Tech-team pre-approval price adjustment. The tech_team role's
   * sole controlled action: edit the predicted price and lodge it for
   * the sales manager to approve. Admins can also call this for
   * support cases. Other roles get 403.
   */
  @Post('tech-adjust')
  @Roles('admin', 'tech_team')
  @HttpCode(200)
  async techAdjust(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: TechAdjustDto,
  ) {
    const prediction = await this.svc.findById(req.tenantId, dto.predictionId);
    if (!prediction || prediction.engagementId !== engagementId) {
      throw new BadRequestException('prediction_not_found_for_engagement');
    }
    const quote = await this.quotes.techAdjust(req.tenantId, engagementId, {
      predictionId: dto.predictionId,
      adjustedPriceCents: dto.adjustedPriceCents,
      note: dto.note?.trim() || null,
      adjustedBy: req.user.sub,
    });
    return {
      engagementId,
      techAdjustedPriceCents: quote.techAdjustedPriceCents,
      techAdjustedAt: quote.techAdjustedAt,
      techAdjustedPredictionId: quote.techAdjustedPredictionId,
    };
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
      case 'tech_adjusted': {
        // Read the tech-team adjustment off the quote row. Must be
        // bound to THIS prediction — a stale adjustment (from before a
        // re-predict) is not approvable.
        const quote = await this.quotes.getForEngagement(req.tenantId, engagementId);
        if (
          !quote
          || quote.techAdjustedPriceCents == null
          || quote.techAdjustedPredictionId !== prediction.id
        ) {
          throw new BadRequestException('tech_adjusted_price_not_available');
        }
        approvedCents = quote.techAdjustedPriceCents;
        break;
      }
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

    // Push the just-approved opportunity to Odoo (no-op when not configured).
    void this.odoo.maybeAutoSync(req.tenantId, engagementId, 'approved');

    return {
      engagementId: updated.id,
      approvedPriceCents: Number(updated.approvedPriceCents ?? 0),
      status: updated.status,
      predictionId: prediction.id,
      choice: dto.choice,
    };
  }

  /**
   * Reject a price/scope. Status flips to 'rejected', the rejection note
   * is captured in the thread, and the relevant parties (sales rep,
   * client per the notification routing) are emailed.
   *
   * Manager+admin only — same as approve. The reverse path (un-reject /
   * reopen) is `revert-approval` since rejecting is final-ish; if you
   * change your mind, the engagement needs to be re-issued or
   * re-submitted by the client.
   */
  @Post('reject')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  async reject(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: RejectDto,
  ) {
    if (!dto.reason.trim()) throw new BadRequestException('reason_required');

    const updated = await this.tenantDb.run(req.tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, status: true },
      });
      if (!eng) throw new BadRequestException('engagement_not_found');
      // Idempotent guard against double-clicks; final states stay final.
      if (['closed', 'rejected', 'sent', 'expired'].includes(eng.status)) {
        throw new ConflictException(`cannot_reject_from_status:${eng.status}`);
      }

      // Optional prediction reference for audit. Skip the lookup if not
      // provided — managers can reject scope before any prediction exists.
      let predictionPayload: Record<string, unknown> = {};
      if (dto.predictionId) {
        const prediction = await this.svc.findById(req.tenantId, dto.predictionId);
        if (!prediction || prediction.engagementId !== engagementId) {
          throw new BadRequestException('prediction_not_found_for_engagement');
        }
        predictionPayload = {
          predictionId: prediction.id,
          basePriceCents: prediction.basePriceCents,
          predictedPriceCents: prediction.predictedPriceCents,
          regime: prediction.regime,
        };
      }

      const next = await db.engagement.update({
        where: { id: engagementId },
        data: { status: 'rejected' },
        select: { id: true, status: true },
      });

      await this.thread.emitWithin(db, req.tenantId, {
        engagementId,
        eventType: 'approval_rejected',
        actorType: 'user',
        actorId: req.user.sub,
        payload: {
          ...predictionPayload,
          comment: dto.reason.trim(),
        },
      });
      return next;
    });

    void this.thread.dispatchAfterCommit(req.tenantId, {
      engagementId,
      eventType: 'approval_rejected',
      actorType: 'user',
      actorId: req.user.sub,
      payload: { comment: dto.reason.trim() },
    });

    // Lost-deal sync — Odoo has a dedicated lost-state action.
    void this.odoo.maybeAutoSync(req.tenantId, engagementId, 'lost');

    return { engagementId: updated.id, status: updated.status };
  }

  /**
   * Reset an approval/rejection — used when a manager clicked the wrong
   * button. Admin-only, deliberately friction-y: clears the approved
   * price and pushes status back to 'pending_approval' if the engagement
   * has a prediction, or 'submitted' otherwise. Drafting work hasn't
   * started yet (status would be 'drafting'/later) so this is safe.
   */
  @Post('revert-approval')
  @Roles('admin')
  @HttpCode(200)
  async revertApproval(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.tenantDb.run(req.tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, status: true },
      });
      if (!eng) throw new BadRequestException('engagement_not_found');
      if (!['approved', 'rejected'].includes(eng.status)) {
        throw new ConflictException(`cannot_revert_from_status:${eng.status}`);
      }

      // Pick the right state to roll back to: if a prediction exists,
      // the natural waiting state is 'pending_approval'; otherwise the
      // engagement is back to scope-collected.
      const latestPrediction = await db.prediction.findFirst({
        where: { engagementId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const targetStatus = latestPrediction ? 'pending_approval' : 'submitted';

      const updated = await db.engagement.update({
        where: { id: engagementId },
        data: { status: targetStatus, approvedPriceCents: null },
        select: { id: true, status: true },
      });
      await db.engagementQuote.updateMany({
        where: { engagementId },
        data: { approvedPriceCents: null, approvedAt: null, approvedBy: null },
      });
      await this.thread.emitWithin(db, req.tenantId, {
        engagementId,
        eventType: 'approval_reverted',
        actorType: 'user',
        actorId: req.user.sub,
        payload: { fromStatus: eng.status, toStatus: targetStatus },
      });
      return { engagementId: updated.id, status: updated.status };
    });
  }
}
