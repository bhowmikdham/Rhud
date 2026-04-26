import {
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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { MlService } from './ml.service.js';
import { TrainDto } from './dto.js';

/**
 * Admin-only ML controls.
 *
 * - GET  /ml/status        — read current active model + train history
 * - POST /ml/train         — push historical quotes, retrain the tenant model
 * - POST /ml/predict/:id   — manually re-trigger prediction for an engagement
 *                            (normally fires automatically on scope_submitted,
 *                            but this lets ops re-run after retraining).
 */
@Controller('ml')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class MlController {
  constructor(private readonly svc: MlService) {}

  @Get('status')
  async status(@Req() req: AuthedRequest) {
    const result = await this.svc.status(req.tenantId);
    if (!result) {
      return { ok: false as const, reason: 'ml_service_unavailable' };
    }
    return { ok: true as const, ...result };
  }

  @Post('train')
  @HttpCode(200)
  async train(@Req() req: AuthedRequest, @Body() dto: TrainDto) {
    const result = await this.svc.train(req.tenantId, dto.records);
    if (!result) {
      return { ok: false, reason: 'ml_service_unavailable' };
    }
    return { ok: true, ...result };
  }

  @Post('predict/:engagementId')
  @HttpCode(202)
  async predict(
    @Req() req: AuthedRequest,
    @Param('engagementId', new ParseUUIDPipe()) engagementId: string,
  ) {
    // Fire-and-forget — caller gets 202 and the prediction event lands in
    // the thread when /predict returns. UI subscribes to the thread refresh.
    void this.svc.predictForEngagement(req.tenantId, engagementId);
    return { accepted: true };
  }
}
