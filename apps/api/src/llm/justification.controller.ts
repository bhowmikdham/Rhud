import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { JustificationService, type JustificationResult } from './justification.service.js';

class AcceptManualDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

/**
 * Quote justification endpoints. Mounted under both /opportunities/:id and
 * /engagements/:id (legacy alias) so existing clients keep working.
 */
@Controller(['opportunities/:id/justification', 'engagements/:id/justification'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class JustificationController {
  constructor(private readonly svc: JustificationService) {}

  @Post()
  @HttpCode(200)
  generate(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<JustificationResult> {
    return this.svc.generate(req.tenantId, id);
  }

  @Post('manual')
  @HttpCode(200)
  acceptManual(@Body() dto: AcceptManualDto): { text: string } {
    return this.svc.acceptManual(dto.text);
  }
}
