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
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { LlmService, type PublicConfig } from './llm.service.js';
import type { LlmProviderName } from './llm.types.js';

const PROVIDERS: LlmProviderName[] = [
  'anthropic',
  'openai',
  'gemini',
  'ollama',
  'openai_compat',
  'manual',
];

class UpsertLlmConfigDto {
  @IsIn(PROVIDERS)
  provider!: LlmProviderName;

  @IsString()
  model!: string;

  @IsOptional()
  @IsString()
  baseUrl?: string | null;

  /** undefined leaves the existing key in place; '' clears it. */
  @IsOptional()
  @IsString()
  apiKey?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyTokenBudget?: number;
}

@Controller('tenant/llm-config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LlmController {
  constructor(private readonly svc: LlmService) {}

  @Get()
  @Roles('admin')
  async get(@Req() req: AuthedRequest): Promise<PublicConfig | null> {
    return this.svc.getConfig(req.tenantId);
  }

  @Put()
  @Roles('admin')
  async upsert(
    @Req() req: AuthedRequest,
    @Body() dto: UpsertLlmConfigDto,
  ): Promise<PublicConfig> {
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
  async test(
    @Req() req: AuthedRequest,
  ): Promise<{ ok: boolean; error?: string; sample?: string }> {
    return this.svc.testCurrentConfig(req.tenantId);
  }
}
