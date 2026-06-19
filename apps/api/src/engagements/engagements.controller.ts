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
import { IsIn, IsInt, IsOptional, IsString, IsUUID, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { EngagementsService } from './engagements.service.js';
import { ExtractionService } from '../extraction/extraction.service.js';
import { QuoteService } from '../pricing/quote.service.js';
import { PredictionService } from '../pricing/prediction.service.js';
import {
  CreateEngagementDto,
  CreateOpportunityFromEmailIngestDto,
  UpdateClientInfoDto,
} from './dto.js';
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

/** POST body for marking a delivered opportunity won or lost (Phase F). */
class MarkOutcomeDto {
  @IsIn(['won', 'lost']) outcome!: 'won' | 'lost';
}

/** PATCH body for attaching a rate card directly to an opportunity
 *  (the template-less pricing path). The card must be published. */
class AttachRateCardDto {
  @IsUUID() rateCardId!: string;
}

/** POST body for attaching a file/image to an existing opportunity — the
 *  reviewer "drop a screenshot for scope" path. Mirrors the direct-ingest
 *  presign DTO. contentType is unconstrained: images, PDFs, and docs all
 *  flow through the same extraction pipeline (images via the vision model). */
class EngagementFilePresignDto {
  @IsString() @MaxLength(255) filename!: string;
  @IsString() @MaxLength(200) contentType!: string;
  @IsInt() @Min(1) sizeBytes!: number;
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
    private readonly extraction: ExtractionService,
    private readonly quotes: QuoteService,
    private readonly predictions: PredictionService,
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
   * Create an opportunity from an inbound email *without* requiring a
   * template (the modern Outlook-add-in default).
   *
   * The email body lands as an `email`-kind IngestionArtifact and is
   * promoted in the same call. Extraction runs over the body so the
   * scope fields populate from whatever the prospect described (or
   * from a tabular RFP questionnaire the rep can see in the add-in
   * preview).
   *
   * If the rep then expands the "Send a link too" disclosure in the
   * add-in and picks a template, the add-in follows up with
   * POST /opportunities/:id/links to attach the template and mint a
   * gathering token — keeping the two concerns decoupled (capture the
   * opportunity from the email; optionally request more structured
   * answers later).
   *
   * Idempotent on (tenantId, messageId) via IngestionService's
   * externalId dedupe — clicking Create twice returns the original
   * engagement instead of duplicating.
   *
   * Roles: same as the other opportunity-create routes.
   */
  @Post('from-email-ingest')
  @Roles('sales_employee', 'sales_manager', 'admin')
  @HttpCode(201)
  async createFromEmailIngest(
    @Req() req: AuthedRequest,
    @Body() dto: CreateOpportunityFromEmailIngestDto,
  ): Promise<{ engagementId: string; artifactIds: string[] }> {
    return this.ingestion.receiveAndPromote({
      tenantId: req.tenantId,
      source: 'email_import',
      content: {
        kind: 'email',
        data: {
          bodyText: dto.bodyText,
          subject: dto.subject,
          from: dto.fromEmail,
        },
      },
      receivedBy: req.user.sub,
      // RFC822 Message-Id flows into externalId so a second submit of
      // the same email returns the existing artifactId rather than
      // creating a duplicate.
      externalId: dto.messageId,
      salesEmployeeId: req.user.sub,
      // Subject as the engagement's human-readable name. Truncated to
      // 200 chars to match the Engagement.name column limit (any longer
      // would error in the underlying Prisma write anyway).
      name: dto.subject.slice(0, 200),
      overrides: {
        // Rep-confirmed clientEmail wins over the artifact's `from`
        // even though they're usually the same — keeps the override
        // path consistent with the paste-text ingest endpoint.
        clientEmail: dto.fromEmail,
        // Display-name preference: explicit override > sender's display
        // name. Both are optional; if neither exists the column stays
        // null and the UI falls back to clientEmail.
        ...(dto.clientNameOverride
          ? { clientName: dto.clientNameOverride }
          : dto.fromName
            ? { clientName: dto.fromName }
            : {}),
        ...(dto.fromName ? { contactName: dto.fromName } : {}),
        // Phone + address come from the LLM extraction surfaced in the
        // add-in's Review step (the rep can edit them before submitting).
        ...(dto.contactPhone ? { contactPhone: dto.contactPhone } : {}),
        ...(dto.clientAddress ? { clientAddress: dto.clientAddress } : {}),
        // Partner / distributor party (external intermediary), when the
        // rep kept or set one in the add-in's Partner section.
        ...(dto.partnerCompany ? { partnerCompany: dto.partnerCompany } : {}),
        ...(dto.partnerContact ? { partnerContact: dto.partnerContact } : {}),
        ...(dto.partnerEmail ? { partnerEmail: dto.partnerEmail } : {}),
        ...(dto.partnerRole ? { partnerRole: dto.partnerRole } : {}),
      },
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

  /**
   * Attach a file or image to an EXISTING opportunity and run extraction
   * over it — the reviewer "drop a screenshot for scope" path. Images are
   * read by the tenant's vision model; PDFs / docs / sheets by the text
   * pipeline. Returns a presigned PUT URL; the client uploads the bytes
   * and the server kicks extraction automatically (see IngestionService).
   */
  @Post(':id/files/presign')
  @Roles('admin', 'sales_manager', 'sales_employee', 'tech_team')
  @HttpCode(201)
  presignEngagementFile(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: EngagementFilePresignDto,
  ) {
    return this.ingestion.presignFileForEngagement({
      tenantId: req.tenantId,
      engagementId: id,
      userId: req.user.sub,
      filename: dto.filename,
      contentType: dto.contentType,
      sizeBytes: dto.sizeBytes,
    });
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

  /** Phase F — mark a delivered opportunity won (→ closed) or lost (→ lost). */
  @Post(':id/outcome')
  @HttpCode(200)
  @Roles('admin', 'sales_manager', 'sales_employee')
  markOutcome(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: MarkOutcomeDto,
  ) {
    return this.svc.markOutcome(req.tenantId, id, req.user.sub, dto.outcome);
  }

  /**
   * Attach a rate card directly to an opportunity, then reprice. For a
   * direct-ingest opportunity (created from an email / paste / voice with
   * no template) this is what unblocks the pipeline: extraction already
   * pulled structured points, but matching / inference / pricing were all
   * gated on a rate card. We bind the card, re-run Layer-3 inference over
   * the already-extracted points, recompute the deterministic quote, then
   * run the prediction. Quote + predict are best-effort so a flaky
   * predict can't hide a successfully computed base.
   */
  @Patch(':id/rate-card')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  async attachRateCard(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AttachRateCardDto,
  ) {
    const attached = await this.svc.attachRateCard(req.tenantId, id, dto.rateCardId);
    const inference = await this.extraction.rerunInferenceForEngagement(req.tenantId, id);
    const quote = await this.quotes
      .computeAndPersistForEngagement(req.tenantId, id)
      .catch(() => null);
    const prediction = await this.predictions
      .predictForEngagement(req.tenantId, id)
      .catch(() => null);
    return { ...attached, inference, quote, prediction };
  }
}
