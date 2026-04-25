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
import { CreateNodeDto, CreateTemplateDto, UpdateNodeDto, UpdateTemplateDto } from './dto.js';

/**
 * All template routes require a valid JWT. Mutations are admin-only — the
 * template library is tenant-wide configuration, not per-user state.
 *
 * Reads are allowed for any authed user in the tenant because sales employees
 * will need to browse templates when issuing gathering links (sprint 3).
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
  @Roles('admin')
  @HttpCode(201)
  create(@Req() req: AuthedRequest, @Body() dto: CreateTemplateDto) {
    return this.svc.create(req.tenantId, dto);
  }

  @Patch(':id')
  @Roles('admin')
  update(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    return this.svc.update(req.tenantId, id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.remove(req.tenantId, id);
  }

  // ── Nodes ─────────────────────────────────────────────────────────────────

  @Post(':id/nodes')
  @Roles('admin')
  @HttpCode(201)
  addNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: CreateNodeDto,
  ) {
    return this.svc.addNode(req.tenantId, id, dto);
  }

  @Patch(':id/nodes/:nodeId')
  @Roles('admin')
  updateNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('nodeId', new ParseUUIDPipe()) nodeId: string,
    @Body() dto: UpdateNodeDto,
  ) {
    return this.svc.updateNode(req.tenantId, id, nodeId, dto);
  }

  @Delete(':id/nodes/:nodeId')
  @Roles('admin')
  @HttpCode(204)
  async removeNode(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('nodeId', new ParseUUIDPipe()) nodeId: string,
  ) {
    await this.svc.removeNode(req.tenantId, id, nodeId);
  }

  // ── Validation ────────────────────────────────────────────────────────────

  @Post(':id/validate')
  @Roles('admin')
  @HttpCode(200)
  async validate(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ issues: Awaited<ReturnType<TemplatesService['validate']>> }> {
    const issues = await this.svc.validate(req.tenantId, id);
    return { issues };
  }
}
