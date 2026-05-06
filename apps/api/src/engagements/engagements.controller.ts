import {
  Body,
  Controller,
  Delete,
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

// Mounted at both routes so the rebrand is purely cosmetic for clients:
// new code calls /opportunities, in-flight integrations + older tests still
// work against /engagements. Internal terminology stays "engagement"
// because the DB table + Prisma model are still called that.
@Controller(['opportunities', 'engagements'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class EngagementsController {
  constructor(private readonly svc: EngagementsService) {}

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
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.getById(req.tenantId, id, { publicBaseUrl: baseUrl });
  }

  /**
   * Hard delete an opportunity + everything attached (answers, files,
   * events, quote, predictions, gathering tokens). Manager + admin only
   * — sales reps shouldn't be able to wipe out an opportunity their
   * teammate created.
   */
  @Delete(':id')
  @Roles('admin', 'sales_manager')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.remove(req.tenantId, id);
  }
}
