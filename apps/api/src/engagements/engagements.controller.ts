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
import { EngagementsService } from './engagements.service.js';
import { CreateEngagementDto } from './dto.js';

@Controller('engagements')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EngagementsController {
  constructor(private readonly svc: EngagementsService) {}

  /**
   * Issue a new engagement and a tokenised gathering link.
   *
   * Returns the plaintext token in the response — this is the ONLY time
   * it's ever exposed. In production the email-out step happens out-of-band
   * (Postmark/SES); for sprint 3 we hand it to the caller for manual delivery.
   */
  @Post()
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateEngagementDto) {
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.issue({
      tenantId: req.tenantId,
      salesEmployeeId: req.user.sub,
      dto,
      publicBaseUrl: baseUrl,
    });
  }

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.svc.list(req.tenantId);
  }

  @Get(':id')
  getById(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.getById(req.tenantId, id);
  }
}
