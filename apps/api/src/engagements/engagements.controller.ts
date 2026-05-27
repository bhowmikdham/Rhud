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
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { EngagementsService } from './engagements.service.js';
import { CreateEngagementDto, CreateOpportunityFromEmailDto, UpdateClientInfoDto } from './dto.js';
import { IngestionService } from '../ingestion/ingestion.service.js';
import { IssueLinkForExistingDto, PromoteIngestDto } from '../ingestion/dto.js';

/** PATCH body for the reviewer-fillable scope fields (assumptions,
 *  exclusions, delivery timeline override). Phase A. All optional —
 *  send only the keys the reviewer changed; null/empty clears the
 *  stored value. */
class UpdateScopeDto {
  @IsOptional() @IsString() @MaxLength(8000) assumptions?: string | null;
  @IsOptional() @IsString() @MaxLength(8000) exclusions?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) deliveryTimelineOverride?: string | null;
}

// Mounted at both routes so the rebrand is purely cosmetic for clients:
// new code calls /opportunities, in-flight integrations + older tests still
// work against /engagements. Internal terminology stays "engagement"
// because the DB table + Prisma model are still called that.
@Controller(['opportunities', 'engagements'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class EngagementsController {
  constructor(
    private readonly svc: EngagementsService,
    private readonly ingestion: IngestionService,
  ) {}

  @Post()
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateEngagementDto) {
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.issue({
      tenantId: req.tenantId,
      salesEmployeeId: req.user.sub,
      dto,
      publicBaseUrl: baseUrl,
    });
  }

  /**
   * Create an opportunity from an inbound email. Used by the Outlook
   * add-in (apps/outlook-addin) — the task pane reads the open message
   * via Office.js, lets the rep pick a template, and POSTs the structured
   * payload here.
   *
   * Same auth + roles as the regular create route. Idempotent on
   * (tenantId, messageId) — clicking the add-in's button twice for the
   * same email returns the original engagement instead of duplicating.
   *
   * Note: this is the Outlook-add-in path, deliberately separate from
   * /opportunities/from-ingest. The add-in pre-fills the link-share
   * wizard from an email; from-ingest takes pre-uploaded artifacts.
   * Both write into the same Engagement table — `source` distinguishes.
   * See docs/direct-ingest.md §6.
   */
  @Post('from-email')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  createFromEmail(@Req() req: AuthedRequest, @Body() dto: CreateOpportunityFromEmailDto) {
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.issueFromEmail({
      tenantId: req.tenantId,
      salesEmployeeId: req.user.sub,
      dto,
      publicBaseUrl: baseUrl,
    });
  }

  /**
   * Direct-ingest: promote one or more pre-existing IngestionArtifact
   * rows into a fresh opportunity. The "I have it" UI mode hits this
   * after the rep has uploaded files (via /ingest/file/presign) and
   * confirmed client metadata. See docs/direct-ingest.md §5.1.
   */
  @Post('from-ingest')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  createFromIngest(
    @Req() req: AuthedRequest,
    @Body() dto: PromoteIngestDto,
  ): Promise<{ engagementId: string; artifactIds: string[] }> {
    return this.ingestion.promote({
      tenantId: req.tenantId,
      artifactIds: dto.artifactIds,
      salesEmployeeId: req.user.sub,
      ...(dto.name ? { name: dto.name } : {}),
      overrides: {
        clientEmail: dto.clientEmail,
        ...(dto.clientName !== undefined    ? { clientName:    dto.clientName }    : {}),
        ...(dto.clientAddress !== undefined ? { clientAddress: dto.clientAddress } : {}),
        ...(dto.contactName !== undefined   ? { contactName:   dto.contactName }   : {}),
        ...(dto.contactPhone !== undefined  ? { contactPhone:  dto.contactPhone }  : {}),
      },
    });
  }

  /**
   * Mint a gathering link against an existing opportunity. Two use
   * cases:
   *   - Direct-ingest opportunity needs follow-up scoping: rep picks
   *     a template, this endpoint attaches it + issues the first
   *     link (emits link_issued).
   *   - Link-share opportunity needs re-scoping: rep picks a template
   *     (must match the existing one), this endpoint mints a fresh
   *     token (emits link_reissued).
   *
   * See docs/direct-ingest.md §4.2 + §7.2.
   */
  @Post(':id/links')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  issueLink(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: IssueLinkForExistingDto,
  ) {
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.issueLinkForExisting({
      tenantId: req.tenantId,
      engagementId: id,
      salesEmployeeId: req.user.sub,
      templateId: dto.templateId,
      publicBaseUrl: baseUrl,
      ...(dto.expiresInDays !== undefined ? { expiresInDays: dto.expiresInDays } : {}),
      ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
    });
  }

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.svc.list(req.tenantId);
  }

  @Get(':id')
  getById(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    const baseUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';
    return this.svc.getById(req.tenantId, id, { publicBaseUrl: baseUrl });
  }

  /**
   * Hard delete an opportunity + everything attached (answers, files,
   * events, quote, predictions, gathering tokens). Manager + admin only
   * — sales reps shouldn't be able to wipe out an opportunity their
   * teammate created.
   */
  @Delete(':id')
  @Roles('admin', 'sales_manager')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.remove(req.tenantId, id);
  }

  /**
   * Phase A — update the reviewer-fillable scope fields. Manager, admin,
   * and tech_team can edit; sales reps read-only on these (they're
   * meant to be the reviewer's voice on the proposal).
   */
  @Patch(':id/scope')
  @Roles('admin', 'sales_manager', 'tech_team')
  updateScope(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateScopeDto,
  ) {
    return this.svc.updateScope(req.tenantId, id, req.user.sub, dto);
  }

  /** Phase C — update the client metadata (name / address / contact). */
  @Patch(':id/client')
  @Roles('admin', 'sales_manager', 'sales_employee', 'tech_team')
  updateClient(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateClientInfoDto,
  ) {
    return this.svc.updateClient(req.tenantId, id, dto);
  }
}
