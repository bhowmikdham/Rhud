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
import type { ScopedEntity } from '@rhud/shared';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { PricingService, type CreateRateCardInput } from './pricing.service.js';
import { CreateRateCardDto, QuoteDto } from './dto.js';

/**
 * Rate card endpoints. Authoring (create / publish / archive / seed) is
 * admin-only — the rate card is the company's published price book and
 * editing it has direct revenue implications. Reads + quoting are open
 * to all authed roles within the tenant; sales reps need to be able to
 * preview a quote against the active card before issuing an engagement.
 */
@Controller('rate-cards')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PricingController {
  constructor(private readonly svc: PricingService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.svc.list(req.tenantId);
  }

  @Get(':id')
  getById(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.getById(req.tenantId, id);
  }

  @Post()
  @Roles('admin')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateRateCardDto) {
    // class-validator's transform leaves optional fields as `undefined`;
    // strict-optional types in the service require them to be present
    // (with `null` for "no upper bound"). Cast across the boundary —
    // the DTO already validated everything we care about.
    return this.svc.create(req.tenantId, dto as unknown as CreateRateCardInput);
  }

  @Patch(':id/publish')
  @Roles('admin')
  publish(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.publish(req.tenantId, id);
  }

  @Patch(':id/archive')
  @Roles('admin')
  archive(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.archive(req.tenantId, id);
  }

  /** Pre-delete probe: how many templates would be unbound if we
   *  hard-deleted this card. Surfaces in the delete-confirm modal. */
  @Get(':id/usage')
  @Roles('admin')
  async usage(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return { templateBindings: await this.svc.countTemplateBindings(req.tenantId, id) };
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.remove(req.tenantId, id);
  }

  @Post(':id/quote')
  @HttpCode(200)
  quote(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: QuoteDto,
  ) {
    return this.svc.quote(req.tenantId, id, dto.scope as ScopedEntity[]);
  }

  @Post('seed/csaas-sample')
  @Roles('admin')
  @HttpCode(201)
  seed(@Req() req: AuthedRequest) {
    return this.svc.seedCsaasSample(req.tenantId);
  }

  @Post('seed/prophaze-sample')
  @Roles('admin')
  @HttpCode(201)
  seedProphaze(@Req() req: AuthedRequest) {
    return this.svc.seedProphazeSample(req.tenantId);
  }

  /**
   * Phase 2 ingestion entrypoint — caller posts the parsed sheet matrix
   * (string[][]) plus an optional name. Web side runs SheetJS in the
   * browser and uploads only the matrix; saves a round trip uploading
   * binary + having the API parse, and reuses the same matrix shape the
   * sheet-import modal already produces.
   */
  @Post('parse')
  @Roles('admin')
  @HttpCode(201)
  parse(
    @Req() req: AuthedRequest,
    @Body() body: { matrix: string[][]; name?: string },
  ) {
    return this.svc.parseAndSave(req.tenantId, body.matrix, body.name ? { name: body.name } : {});
  }

  /**
   * Backfill / regenerate the LLM-authored inference ontology for an
   * existing rate card. Useful when:
   *   - The card was created before hint-synthesis shipped (legacy data).
   *   - The card was created while the LLM provider was unavailable.
   *   - The admin wants fresher hints after editing slugs.
   *
   * Returns 200 with `{ regenerated: true }` on success, or
   * `{ regenerated: false }` when the LLM is unavailable / parse failed.
   * In the failure case the existing hints are unchanged.
   */
  @Post(':id/regenerate-hints')
  @Roles('admin')
  @HttpCode(200)
  async regenerateHints(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    const ok = await this.svc.regenerateHints(req.tenantId, id);
    return { regenerated: ok };
  }
}
