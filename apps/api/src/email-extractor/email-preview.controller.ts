import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { EmailExtractorService } from './email-extractor.service.js';
import { PreviewFromEmailDto } from './dto.js';

/**
 * Stateless preview for the Outlook add-in. Mounted under `opportunities`
 * (same prefix as EngagementsController) but lives in its own module so it
 * can depend on LlmModule without dragging the LlmModule → IntegrationsModule
 * → EngagementsModule cycle into EngagementsModule.
 */
@Controller('opportunities')
@UseGuards(JwtAuthGuard, RolesGuard)
export class EmailPreviewController {
  constructor(private readonly extractor: EmailExtractorService) {}

  @Post('preview-from-email')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(200)
  preview(@Req() req: AuthedRequest, @Body() dto: PreviewFromEmailDto) {
    // req.user.email is the signed-in (internal) user — the extractor uses
    // it to decide who counts as "internal" when disambiguating forwards.
    return this.extractor.preview(req.tenantId, req.user.email, dto);
  }
}
