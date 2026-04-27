import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import {
  GammaService,
  type ProposalDriver,
  type PublicGammaConfig,
} from './gamma.service.js';

const DRIVERS: ProposalDriver[] = ['llm', 'gamma'];

class UpsertGammaConfigDto {
  @IsOptional() @IsString() @MaxLength(120)
  workspaceName?: string | null;

  @IsOptional() @IsString() @MaxLength(120)
  workspaceId?: string | null;

  @IsOptional() @IsString()
  apiKey?: string | null;

  @IsOptional() @IsIn(DRIVERS)
  proposalDriver?: ProposalDriver;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}

@Controller('tenant/gamma-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class GammaController {
  constructor(private readonly svc: GammaService) {}

  @Get()
  @Roles('admin')
  get(@Req() req: AuthedRequest): Promise<PublicGammaConfig | null> {
    return this.svc.getConfig(req.tenantId);
  }

  @Put()
  @Roles('admin')
  upsert(
    @Req() req: AuthedRequest,
    @Body() dto: UpsertGammaConfigDto,
  ): Promise<PublicGammaConfig> {
    return this.svc.upsertConfig(req.tenantId, dto);
  }

  @Delete()
  @Roles('admin')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest): Promise<void> {
    await this.svc.deleteConfig(req.tenantId);
  }

  @Post('test')
  @Roles('admin')
  @HttpCode(200)
  test(@Req() req: AuthedRequest): Promise<{ ok: boolean; error?: string }> {
    return this.svc.testCurrentConfig(req.tenantId);
  }
}
