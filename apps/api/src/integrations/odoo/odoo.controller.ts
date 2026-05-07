/**
 * Odoo integration HTTP routes.
 *
 *   ── Connection management (admin) ─────────────────────────────────
 *   GET    /integrations/odoo/status                  any role
 *   PUT    /integrations/odoo/connection              admin
 *   DELETE /integrations/odoo/connection              admin
 *   POST   /integrations/odoo/test                    admin
 *
 *   ── Field mappings (admin) ────────────────────────────────────────
 *   GET    /integrations/odoo/mappings
 *   POST   /integrations/odoo/mappings
 *   PATCH  /integrations/odoo/mappings/:id
 *   DELETE /integrations/odoo/mappings/:id
 *
 *   ── Generic Odoo passthrough (admin) ──────────────────────────────
 *   POST   /integrations/odoo/records/:model/search
 *   GET    /integrations/odoo/records/:model/fields
 *   POST   /integrations/odoo/records/:model
 *   PATCH  /integrations/odoo/records/:model/:id
 *   DELETE /integrations/odoo/records/:model/:id
 *
 *   ── CRM helpers (any role; depend on connection) ──────────────────
 *   GET    /integrations/odoo/stages
 *   GET    /integrations/odoo/teams
 *   GET    /integrations/odoo/users
 *   GET    /integrations/odoo/tags
 *
 *   ── Engagement / opportunity sync (any role) ──────────────────────
 *   POST   /integrations/odoo/engagements/:id/push
 *   POST   /integrations/odoo/engagements/:id/pull
 *   POST   /integrations/odoo/engagements/:id/outcome
 *   DELETE /integrations/odoo/engagements/:id/link
 *
 *   ── Activity feeds ────────────────────────────────────────────────
 *   GET    /integrations/odoo/sync-logs
 *   GET    /integrations/odoo/entity-links
 *   GET    /integrations/odoo/webhooks
 *   POST   /integrations/odoo/webhooks/process       admin
 *
 *   ── Inbound webhook (no JWT — secret is in URL) ────────────────────
 *   POST   /integrations/odoo/webhooks/:tenantId/:secret
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../../auth/roles.guard.js';
import type { AuthedRequest } from '../../auth/auth.types.js';
import { TenantDb } from '../../db/with-tenant.js';
import { OdooService } from './odoo.service.js';

class UpsertConnectionDto {
  @IsString() @MinLength(1) url!: string;
  @IsString() @MinLength(1) database!: string;
  @IsString() @MinLength(1) login!: string;
  @IsOptional() @IsString() apiKey?: string;
  @IsOptional() @IsBoolean() autoSyncEnabled?: boolean;
  @IsOptional() @IsInt() defaultTeamId?: number | null;
  @IsOptional() @IsInt() defaultUserId?: number | null;
}

class CreateMappingDto {
  @IsString() rhudEntity!: string;
  @IsString() rhudField!: string;
  @IsString() odooModel!: string;
  @IsString() odooField!: string;
  @IsOptional() @IsString() transform?: string | null;
  @IsOptional() @IsBoolean() required?: boolean;
  @IsOptional() @IsIn(['push', 'pull', 'both']) direction?: 'push' | 'pull' | 'both';
}

class SearchRecordsDto {
  @IsOptional() @IsArray() domain?: unknown[];
  @IsOptional() @IsArray() fields?: string[];
  @IsOptional() @IsInt() @Min(1) limit?: number;
  @IsOptional() @IsInt() @Min(0) offset?: number;
  @IsOptional() @IsString() order?: string;
}

class CreateRecordDto {
  @IsObject() values!: Record<string, unknown>;
}

class UpdateRecordDto {
  @IsObject() values!: Record<string, unknown>;
}

class PushEngagementDto {
  @IsOptional() @IsBoolean() force?: boolean;
  @IsOptional() @IsString() asModel?: string;
  @IsOptional() @IsObject() overrides?: Record<string, unknown>;
}

class OutcomeDto {
  @IsIn(['won', 'lost']) outcome!: 'won' | 'lost';
}

class PromoteImportedDto {
  @IsString() templateId!: string;
  @IsOptional() @IsString() salesEmployeeId?: string;
  @IsOptional() @IsString() name?: string;
}

class BackfillDto {
  @IsOptional() @IsInt() pageSize?: number;
  @IsOptional() @IsInt() maxPages?: number;
  @IsOptional() @IsBoolean() activeOnly?: boolean;
}

@Controller('integrations/odoo')
export class OdooController {
  constructor(
    private readonly svc: OdooService,
    private readonly tenantDb: TenantDb,
  ) {}

  // ── Connection ───────────────────────────────────────────────────

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Req() req: AuthedRequest) {
    return this.svc.getStatus(req.tenantId);
  }

  @Put('connection')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  upsert(@Req() req: AuthedRequest, @Body() dto: UpsertConnectionDto) {
    return this.svc.upsert(req.tenantId, dto);
  }

  @Delete('connection')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(204)
  async disconnect(@Req() req: AuthedRequest) {
    await this.svc.disconnect(req.tenantId);
  }

  @Post('test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  test(@Req() req: AuthedRequest) {
    return this.svc.testConnection(req.tenantId);
  }

  // ── Field mappings ───────────────────────────────────────────────

  @Get('mappings')
  @UseGuards(JwtAuthGuard)
  listMappings(@Req() req: AuthedRequest) {
    return this.svc.listMappings(req.tenantId);
  }

  @Post('mappings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  createMapping(@Req() req: AuthedRequest, @Body() dto: CreateMappingDto) {
    return this.svc.createMapping(req.tenantId, dto);
  }

  @Patch('mappings/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  updateMapping(@Req() req: AuthedRequest, @Param('id') id: string, @Body() dto: CreateMappingDto) {
    return this.svc.updateMapping(req.tenantId, id, dto);
  }

  @Delete('mappings/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(204)
  async deleteMapping(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.svc.deleteMapping(req.tenantId, id);
  }

  // ── Generic record passthrough ───────────────────────────────────

  @Post('records/:model/search')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  search(
    @Req() req: AuthedRequest,
    @Param('model') model: string,
    @Body() dto: SearchRecordsDto,
  ) {
    return this.svc.searchRecords(req.tenantId, model, {
      domain: dto.domain ?? [],
      ...(dto.fields ? { fields: dto.fields } : {}),
      ...(dto.limit != null ? { limit: dto.limit } : {}),
      ...(dto.offset != null ? { offset: dto.offset } : {}),
      ...(dto.order ? { order: dto.order } : {}),
    });
  }

  @Get('records/:model/fields')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  fields(@Req() req: AuthedRequest, @Param('model') model: string) {
    return this.svc.fieldsGet(req.tenantId, model);
  }

  @Post('records/:model')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  createRecord(
    @Req() req: AuthedRequest,
    @Param('model') model: string,
    @Body() dto: CreateRecordDto,
  ) {
    return this.svc.createRecord(req.tenantId, model, dto.values, req.user.sub);
  }

  @Patch('records/:model/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  updateRecord(
    @Req() req: AuthedRequest,
    @Param('model') model: string,
    @Param('id') id: string,
    @Body() dto: UpdateRecordDto,
  ) {
    return this.svc.updateRecord(req.tenantId, model, Number(id), dto.values, req.user.sub);
  }

  @Delete('records/:model/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  deleteRecord(
    @Req() req: AuthedRequest,
    @Param('model') model: string,
    @Param('id') id: string,
  ) {
    return this.svc.deleteRecord(req.tenantId, model, Number(id), req.user.sub);
  }

  // ── CRM helpers ──────────────────────────────────────────────────

  @Get('stages')
  @UseGuards(JwtAuthGuard)
  stages(@Req() req: AuthedRequest) { return this.svc.listStages(req.tenantId); }

  @Get('teams')
  @UseGuards(JwtAuthGuard)
  teams(@Req() req: AuthedRequest) { return this.svc.listTeams(req.tenantId); }

  @Get('users')
  @UseGuards(JwtAuthGuard)
  users(@Req() req: AuthedRequest) { return this.svc.listUsers(req.tenantId); }

  @Get('tags')
  @UseGuards(JwtAuthGuard)
  tags(@Req() req: AuthedRequest) { return this.svc.listTags(req.tenantId); }

  // ── Engagement-level sync ────────────────────────────────────────

  @Post('engagements/:id/push')
  @UseGuards(JwtAuthGuard)
  pushEngagement(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: PushEngagementDto,
  ) {
    return this.svc.pushEngagement(req.tenantId, id, dto, 'manual', req.user.sub);
  }

  @Post('engagements/:id/pull')
  @UseGuards(JwtAuthGuard)
  pullEngagement(@Req() req: AuthedRequest, @Param('id') id: string) {
    return this.svc.pullEngagement(req.tenantId, id);
  }

  @Post('engagements/:id/outcome')
  @UseGuards(JwtAuthGuard)
  outcome(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
    @Body() dto: OutcomeDto,
  ) {
    return this.svc.setOutcome(req.tenantId, id, dto.outcome, req.user.sub);
  }

  @Delete('engagements/:id/link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async unlinkEngagement(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.svc.unlinkEngagement(req.tenantId, id);
  }

  // ── Activity feeds ───────────────────────────────────────────────

  @Get('sync-logs')
  @UseGuards(JwtAuthGuard)
  syncLogs(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.svc.listSyncLogs(req.tenantId, limit ? Number(limit) : undefined);
  }

  @Get('entity-links')
  @UseGuards(JwtAuthGuard)
  entityLinks(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.svc.listEntityLinks(req.tenantId, limit ? Number(limit) : undefined);
  }

  @Get('webhooks')
  @UseGuards(JwtAuthGuard)
  webhooks(@Req() req: AuthedRequest, @Query('limit') limit?: string) {
    return this.svc.listWebhookEvents(req.tenantId, limit ? Number(limit) : undefined);
  }

  @Post('webhooks/process')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  processWebhooks(@Req() req: AuthedRequest) {
    return this.svc.processPendingWebhooks(req.tenantId);
  }

  // ── Inbound (Odoo → Rhud) sync ────────────────────────────────────

  /** Manual poll trigger — admin "Refresh from Odoo" button. */
  @Post('poll')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  poll(@Req() req: AuthedRequest) {
    return this.svc.pollOdooChanges(req.tenantId);
  }

  /** One-time backfill of all crm.lead records into the imported list.
   *  Bounded; admins can re-run it if an import gets interrupted. */
  @Post('backfill')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  backfill(@Req() req: AuthedRequest, @Body() dto: BackfillDto) {
    return this.svc.backfillImportedOpportunities(req.tenantId, dto);
  }

  /** List opportunities Rhud has snapshotted from Odoo. By default
   *  hides ones already promoted to a Rhud Engagement. */
  @Get('imported')
  @UseGuards(JwtAuthGuard)
  listImported(
    @Req() req: AuthedRequest,
    @Query('includePromoted') includePromoted?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.listImportedOpportunities(req.tenantId, {
      includePromoted: includePromoted === 'true' || includePromoted === '1',
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }

  /** Re-fetch the canonical Odoo record + refresh the snapshot. */
  @Post('imported/:odooId/refresh')
  @UseGuards(JwtAuthGuard)
  refreshImported(@Req() req: AuthedRequest, @Param('odooId') odooId: string) {
    return this.svc.refreshImportedOpportunity(req.tenantId, Number(odooId));
  }

  /** Promote a snapshot to a real Rhud Engagement. */
  @Post('imported/:odooId/promote')
  @UseGuards(JwtAuthGuard)
  promoteImported(
    @Req() req: AuthedRequest,
    @Param('odooId') odooId: string,
    @Body() dto: PromoteImportedDto,
  ) {
    return this.svc.promoteImportedOpportunity(
      req.tenantId,
      Number(odooId),
      dto,
      req.user.sub,
    );
  }

  // ── Inbound webhook (no JWT — secret is in URL) ────────────────────

  @Post('webhooks/:tenantId/:secret')
  @HttpCode(202)
  async ingestWebhook(
    @Param('tenantId') tenantId: string,
    @Param('secret') secret: string,
    @Body() body: unknown,
  ) {
    // We don't have a JWT here, so we can't go through TenantDb.run with
    // a known tenant context. Open a transaction with the tenant id from
    // the path, but verify the secret first against the row inside that
    // transaction — RLS will reject if the path id is wrong.
    const ok = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.odooConnection.findUnique({
        where: { tenantId },
        select: { webhookSecret: true },
      });
      if (!row) return false;
      // Constant-time compare.
      return safeEqual(row.webhookSecret, secret);
    }).catch(() => false);
    if (!ok) throw new UnauthorizedException('odoo_webhook_unauthorized');

    return this.svc.ingestWebhook(tenantId, body);
  }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
