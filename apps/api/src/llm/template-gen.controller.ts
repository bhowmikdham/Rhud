import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TemplateGenService, type GeneratedNode, type TemplateGenResult } from './template-gen.service.js';

class GenerateDto {
  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  description!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  serviceLine?: string;
}

class ParseManualDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

/**
 * Template generation. Generation itself is admin/manager only — only
 * those roles can author templates per the existing guard pattern.
 */
@Controller('templates/from-description')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TemplateGenController {
  constructor(private readonly svc: TemplateGenService) {}

  @Post()
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  generate(
    @Req() req: AuthedRequest,
    @Body() dto: GenerateDto,
  ): Promise<TemplateGenResult> {
    return this.svc.generate(req.tenantId, {
      description: dto.description,
      serviceLine: dto.serviceLine,
    });
  }

  @Post('parse-manual')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  parseManual(@Body() dto: ParseManualDto): { nodes: GeneratedNode[] } {
    return this.svc.parseManual(dto.text);
  }
}
