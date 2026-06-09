import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  GAMMA_TEMPLATE_FORMATS,
  type CreateGammaTemplate,
  type GammaTemplate,
  type GammaTemplateFormat,
  type GammaTemplateManifest,
  type GammaTemplateTestResult,
  type UpdateGammaTemplate,
} from '@rhud/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { GammaTemplateService } from './gamma-template.service.js';

const FORMATS: GammaTemplateFormat[] = [...GAMMA_TEMPLATE_FORMATS];

class CreateGammaTemplateDto implements CreateGammaTemplate {
  @IsString() @MaxLength(120)
  label!: string;

  @IsString() @MaxLength(200)
  gammaTemplateId!: string;

  @IsOptional() @IsIn(FORMATS)
  format?: GammaTemplateFormat;

  @IsOptional() @IsString() @MaxLength(120)
  serviceLine?: string | null;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  // Shallow check only — GammaTemplateService deep-validates the shape.
  @IsOptional() @IsObject()
  manifest?: GammaTemplateManifest;
}

class UpdateGammaTemplateDto implements UpdateGammaTemplate {
  @IsOptional() @IsString() @MaxLength(120)
  label?: string;

  @IsOptional() @IsString() @MaxLength(200)
  gammaTemplateId?: string;

  @IsOptional() @IsIn(FORMATS)
  format?: GammaTemplateFormat;

  @IsOptional() @IsString() @MaxLength(120)
  serviceLine?: string | null;

  @IsOptional() @IsBoolean()
  isDefault?: boolean;

  @IsOptional() @IsObject()
  manifest?: GammaTemplateManifest;
}

/**
 * Tenant-level Gamma template library. Admins + sales managers curate the
 * decks reps can pick from per proposal. The raw Gamma File ID is pasted in
 * from the Gamma app; `/test` checks the tenant's API key reaches Gamma
 * (connectivity only — it does NOT validate the File ID or spend credits).
 */
@Controller('tenant/gamma-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'sales_manager')
export class GammaTemplateController {
  constructor(private readonly svc: GammaTemplateService) {}

  @Get()
  list(@Req() req: AuthedRequest): Promise<GammaTemplate[]> {
    return this.svc.list(req.tenantId);
  }

  @Post()
  create(@Req() req: AuthedRequest, @Body() dto: CreateGammaTemplateDto): Promise<GammaTemplate> {
    return this.svc.create(req.tenantId, dto);
  }

  @Patch(':id')
  update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateGammaTemplateDto,
  ): Promise<GammaTemplate> {
    return this.svc.update(req.tenantId, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async archive(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.archive(req.tenantId, id);
  }

  @Post(':id/test')
  @HttpCode(200)
  test(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<GammaTemplateTestResult> {
    return this.svc.testConnection(req.tenantId, id);
  }
}
