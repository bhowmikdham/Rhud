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
import { IsInt, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { QuoteService } from './quote.service.js';

class ApproveQuoteDto {
  @IsInt()
  @Min(0)
  approvedPriceCents!: number;
}

/**
 * Quote endpoints surface the line-item base price + manager approval
 * for a specific engagement. Reads are open to all authed roles in
 * the tenant; approval is admin / sales_manager.
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

  @Post('approve')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  approve(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: ApproveQuoteDto,
  ) {
    return this.svc.approve(req.tenantId, engagementId, {
      approvedPriceCents: dto.approvedPriceCents,
      approvedBy: req.user.sub,
    });
  }
}
