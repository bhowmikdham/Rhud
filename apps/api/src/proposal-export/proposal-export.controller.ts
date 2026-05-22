/**
 * Phase D — DOCX export endpoint.
 *
 *   GET /opportunities/:id/proposal/docx
 *
 * Streams the generated DOCX as application/vnd.openxmlformats-officedocument.
 * wordprocessingml.document with a Content-Disposition attachment header
 * so the browser triggers a download.
 *
 * No body. Accepts any authenticated tenant member; the engagement is
 * already RLS-scoped to their tenant.
 */

import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { ProposalDocxService } from './proposal-docx.service.js';

@Controller(['opportunities/:id', 'engagements/:id'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProposalExportController {
  constructor(private readonly svc: ProposalDocxService) {}

  @Get('proposal/docx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  async downloadDocx(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { buffer, filename } = await this.svc.render(req.tenantId, id);
    // The Header decorator already set the Content-Type. We still need
    // to set Content-Disposition (filename) at request time because
    // the value depends on the engagement.
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Length', String(buffer.length));
    res.end(buffer);
  }
}
