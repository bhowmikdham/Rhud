/**
 * Phase E — admin CRUD for partner tokens.
 *
 * Mounted under /tenant/partner-tokens (lines up with /tenant/invites,
 * /tenant/users). All routes are admin-only via the existing
 * JwtAuthGuard + RolesGuard composition.
 *
 * The plaintext token is returned ONLY in the response from POST (create)
 * and POST :id/rotate. The list endpoint never returns it.
 */

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
import { PartnerTokensService, type PartnerTokenSummary } from './partner-tokens.service.js';
import { CreatePartnerTokenDto } from './dto.js';

@Controller('tenant/partner-tokens')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PartnerTokensController {
  constructor(private readonly svc: PartnerTokensService) {}

  @Get()
  @Roles('admin')
  list(@Req() req: AuthedRequest): Promise<PartnerTokenSummary[]> {
    return this.svc.list(req.tenantId);
  }

  @Post()
  @Roles('admin')
  @HttpCode(201)
  create(
    @Req() req: AuthedRequest,
    @Body() dto: CreatePartnerTokenDto,
  ): Promise<{ partner: PartnerTokenSummary; token: string }> {
    return this.svc.create(req.tenantId, req.user, {
      name: dto.name,
      ...(dto.expiresInDays !== undefined ? { expiresInDays: dto.expiresInDays } : {}),
      ...(dto.defaultTemplateId !== undefined ? { defaultTemplateId: dto.defaultTemplateId } : {}),
      ...(dto.defaultSalesOwnerId !== undefined ? { defaultSalesOwnerId: dto.defaultSalesOwnerId } : {}),
    });
  }

  @Post(':id/rotate')
  @Roles('admin')
  @HttpCode(200)
  rotate(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ partner: PartnerTokenSummary; token: string }> {
    return this.svc.rotate(req.tenantId, id, req.user);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async revoke(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.revoke(req.tenantId, id);
  }
}
