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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { TemplatesService } from './templates.service.js';
import {
  CreateNodeDto,
  CreateTemplateDto,
  ImportNodesDto,
  UpdateNodeDto,
  UpdateTemplateDto,
} from './dto.js';

/**
 * All template routes require a valid JWT.
 *
 * Mutations: admin + sales_manager. Templates are tenant-wide configuration
 * that managers in practice need to author and tweak; sales_employee stays
 * read-only so engagement issuance still works for them without
 * accidentally letting individual reps fork the template library.
 *
 * Reads: any authed user in the tenant.
 */
@Controller('templates')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.svc.list(req.tenantId);
  }

  @Get(':id')
  getById(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.svc.getById(req.tenantId, id);
  }

  @Post()
  @Roles('admin', 'sales_manager')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateTemplateDto) {
    return this.svc.create(req.tenantId, dto);
  }

  @Patch(':id')
  @Roles('admin', 'sales_manager')
  update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.svc.update(req.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('admin', 'sales_manager')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.remove(req.tenantId, id);
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────

  @Post(':id/nodes')
  @Roles('admin', 'sales_manager')
  @HttpCode(201)
  addNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.svc.addNode(req.tenantId, id, dto);
  }

  @Patch(':id/nodes/:nodeId')
  @Roles('admin', 'sales_manager')
  updateNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('nodeId', new ParseUUIDPipe()) nodeId: string,
    @Body() dto: UpdateNodeDto,
  ) {
    return this.svc.updateNode(req.tenantId, id, nodeId, dto);
  }

  @Delete(':id/nodes/:nodeId')
  @Roles('admin', 'sales_manager')
  @HttpCode(204)
  async removeNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('nodeId', new ParseUUIDPipe()) nodeId: string,
  ) {
    await this.svc.removeNode(req.tenantId, id, nodeId);
  }

  // ── Bulk import ───────────────────────────────────────────────────────────
  // Paste a list of questions (often parsed client-side from CSV / a Numbers
  // export / an existing intake doc) and we'll create them as a linear chain.
  // First node becomes root if the template has none; every node gets an
  // `always → next` rule, last one terminates with END.

  @Post(':id/nodes/import')
  @Roles('admin', 'sales_manager')
  @HttpCode(201)
  async importNodes(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ImportNodesDto,
  ) {
    return this.svc.importNodes(req.tenantId, id, {
      replace: dto.replace ?? false,
      nodes: dto.nodes,
    });
  }

  // ── Validation ────────────────────────────────────────────────────────────

  @Post(':id/validate')
  @Roles('admin', 'sales_manager')
  @HttpCode(200)
  async validate(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ issues: Awaited<ReturnType<TemplatesService['validate']>> }> {
    const issues = await this.svc.validate(req.tenantId, id);
    return { issues };
  }
}
