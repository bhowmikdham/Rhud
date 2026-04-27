import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsArray, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import {
  RateCardLlmParserService,
  type RateCardAiParseResult,
} from './rate-card-parser.service.js';

class ParseWithAiDto {
  @IsArray()
  matrix!: string[][];

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

class ParseManualDto {
  @IsString()
  @MinLength(1)
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

/**
 * AI-assisted rate-card parsing. Sibling of POST /rate-cards/parse
 * (the deterministic structural parser); use this when the source
 * spreadsheet doesn't match the CSaaS layout.
 *
 * Mounted on the rate-cards namespace so the URL reads naturally:
 *   POST /api/v1/rate-cards/parse-with-ai
 *   POST /api/v1/rate-cards/parse-with-ai/manual
 */
@Controller('rate-cards/parse-with-ai')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RateCardLlmParserController {
  constructor(private readonly svc: RateCardLlmParserService) {}

  @Post()
  @Roles('admin')
  @HttpCode(200)
  parse(
    @Req() req: AuthedRequest,
    @Body() dto: ParseWithAiDto,
  ): Promise<RateCardAiParseResult> {
    return this.svc.parse(req.tenantId, { matrix: dto.matrix, name: dto.name });
  }

  @Post('manual')
  @Roles('admin')
  @HttpCode(200)
  parseManual(
    @Req() req: AuthedRequest,
    @Body() dto: ParseManualDto,
  ) {
    return this.svc.parseManualAndSave(req.tenantId, dto.text, { name: dto.name });
  }
}
