import {
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
import { QuoteService } from './quote.service.js';

/**
 * Quote endpoints surface the line-item base price for a specific
 * engagement. Reads are open to all authed roles in the tenant;
 * recompute is admin / sales_manager. Final price approval is NOT here —
 * it flows through PredictionController.approve, which enforces the
 * VP/CEO multi-level gating (authz-boundary-2).
 */
@Controller(['opportunities/:id/quote', 'engagements/:id/quote'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class QuoteController {
  constructor(private readonly svc: QuoteService) {}

  @Get()
  get(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.getForEngagement(req.tenantId, engagementId);
  }

  /**
   * Recompute the quote without going through the gathering flow.
   * Useful when a manager wants to refresh a quote after the rate card
   * was edited (cf. PDF §4.3 on rate-card versioning).
   */
  @Post('recompute')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  recompute(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ) {
    return this.svc.computeAndPersistForEngagement(req.tenantId, engagementId);
  }

}
