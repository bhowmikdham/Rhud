import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsString, MinLength, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import {
  ProposalDraftService,
  type CurrentDraft,
  type ProposalDraftResult,
} from './proposal-draft.service.js';

class AcceptManualDraftDto {
  @IsString()
  @MinLength(1)
  text!: string;
}

class SendViaOutlookDto {
  @IsString()
  @MinLength(1)
  @MaxLength(998) // RFC 5322 subject-line length cap
  subject!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64_000) // generous; the body will hit much smaller limits in practice
  body!: string;
}

/**
 * Proposal draft endpoints. Mounted under both /opportunities and the
 * legacy /engagements alias, same as the other opportunity-scoped LLM
 * features.
 */
@Controller(['opportunities/:id/draft', 'engagements/:id/draft'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProposalDraftController {
  constructor(private readonly svc: ProposalDraftService) {}

  /** Read the persisted draft (if any). Visible to anyone in the tenant. */
  @Get()
  async getCurrent(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<CurrentDraft> {
    return this.svc.getCurrent(req.tenantId, id);
  }

  /**
   * Generate (or re-generate) a draft. For manual provider returns the
   * prompt; for auto providers the draft is persisted + status flipped
   * before this endpoint returns.
   *
   * Allowed for the same roles that can approve — the rep doesn't need
   * a manager's permission to *re-draft* an already-approved proposal.
   */
  @Post()
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  generate(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<ProposalDraftResult> {
    return this.svc.generate(req.tenantId, id, req.user.sub);
  }

  /** Manual-mode follow-up: paste the AI's reply, persist it, flip status. */
  @Post('manual')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  acceptManual(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AcceptManualDraftDto,
  ) {
    return this.svc.acceptManual(req.tenantId, id, req.user.sub, dto.text);
  }

  /** Wipe the current draft so a re-generate goes through the happy path. */
  @Delete()
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(204)
  async clear(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.clear(req.tenantId, id, req.user.sub);
  }

  /**
   * Confirm the proposal was sent. In the bridge flow this fires after
   * the rep emails the client themselves (Open in mail app + attach
   * the downloaded PDF). When Outlook OAuth ships, a sibling endpoint
   * will send-and-flip atomically; this stays as the manual fallback.
   *
   * Open to sales reps too — they're the human-in-the-loop here, the
   * ones actually doing the sending.
   */
  @Post('mark-sent')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  markSent(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.svc.markSent(req.tenantId, id, req.user.sub);
  }

  /**
   * One-click send via the rep's connected Outlook mailbox. Composes
   * the email server-side, attaches the PDF (re-fetched from Gamma's
   * cached export URL), calls Microsoft Graph sendMail, flips status,
   * fires the team-side notification.
   */
  @Post('send-via-outlook')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  sendViaOutlook(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SendViaOutlookDto,
  ) {
    return this.svc.sendViaOutlook(req.tenantId, id, req.user.sub, {
      subject: dto.subject,
      body: dto.body,
    });
  }

  /**
   * Stream the proposal PDF.
   *
   * We proxy the bytes server-side instead of 302-redirecting to
   * Gamma's pre-signed URL because:
   *   - 302s drop our JWT auth (bearer header doesn't survive a
   *     redirect across origins), forcing the client into a brittle
   *     fetch+blob dance just to add the header.
   *   - Streaming via our origin means the SendModal's auth'd fetch
   *     gets a single clean response with proper Content-Disposition,
   *     and the same endpoint will work transparently when phase 2
   *     swaps Gamma URLs for server-cached bytes.
   *
   * 404s when no PDF is available (text drafts in phase 1, or expired
   * Gamma URL) so the UI can prompt the rep to regenerate.
   */
  @Get('pdf')
  @Roles('admin', 'sales_manager', 'sales_employee')
  async pdf(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const found = await this.svc.getPdfUrl(req.tenantId, id);
    if (!found) throw new NotFoundException('proposal_pdf_unavailable');

    const upstream = await fetch(found.url);
    if (!upstream.ok) {
      // Treat upstream non-200 as "PDF unavailable" rather than a
      // 502 — the most common cause is the URL expired between when
      // we cached it and now, which the rep can fix by regenerating.
      throw new NotFoundException('proposal_pdf_unavailable');
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="Proposal.pdf"');
    res.setHeader('Content-Length', String(buf.length));
    res.send(buf);
  }
}
