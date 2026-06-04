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
import type { AuthedRequest, JwtPayload } from '../auth/auth.types.js';
import { TeamService, type InviteSummary, type UserSummary } from './team.service.js';
import { CreateInviteDto, UpdateUserRoleDto, AcceptInviteDto, UpdateTenantDto, LogoPresignDto } from './dto.js';
import type { Role } from '@rhud/shared';

/**
 * Team management endpoints. All admin-only and tenant-scoped, except the
 * /invites/:token/* paths which are public (token IS the auth) and live
 * under a separate controller below.
 */
@Controller('tenant')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TeamController {
  constructor(private readonly svc: TeamService) {}

  /** Read the current tenant — every authed user can see their own
   *  workspace's name + plan. Used by the shell for branding (sidebar,
   *  topbar) and by the Settings → Workspace tab. */
  @Get('me')
  getTenant(@Req() req: AuthedRequest) {
    return this.svc.getTenant(req.tenantId);
  }

  /** Mutate workspace identity + per-tenant feature toggles + approval
   *  thresholds. Admin-only — non-admins shouldn't be able to rename
   *  the workspace, flip spend-affecting toggles like the AI auto-
   *  summariser, or change the approval thresholds. */
  @Patch('me')
  @Roles('admin')
  updateTenant(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.svc.updateTenant(req.tenantId, req.user, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.leadSummaryAutoGenerate !== undefined ? { leadSummaryAutoGenerate: dto.leadSummaryAutoGenerate } : {}),
      ...(dto.requiresVpApprovalAboveCents !== undefined ? { requiresVpApprovalAboveCents: dto.requiresVpApprovalAboveCents } : {}),
      ...(dto.requiresCeoApprovalAboveCents !== undefined ? { requiresCeoApprovalAboveCents: dto.requiresCeoApprovalAboveCents } : {}),
      ...(dto.notificationConfig !== undefined ? { notificationConfig: dto.notificationConfig } : {}),
      ...(dto.logoKey !== undefined ? { logoKey: dto.logoKey } : {}),
    });
  }

  /** Get a signed PUT url to upload a new workspace logo. Admin-only.
   *  Client PUTs the image to `uploadUrl`, then PATCHes /tenant/me with
   *  the returned `key` (as `logoKey`) to persist it. */
  @Post('logo/presign')
  @Roles('admin')
  @HttpCode(200)
  presignLogo(
    @Req() req: AuthedRequest,
    @Body() dto: LogoPresignDto,
  ): Promise<{ uploadUrl: string; key: string; expiresAt: string }> {
    return this.svc.presignLogo(req.tenantId, {
      contentType: dto.contentType,
      ...(dto.filename !== undefined ? { filename: dto.filename } : {}),
    });
  }

  @Get('users')
  @Roles('admin')
  listUsers(@Req() req: AuthedRequest): Promise<UserSummary[]> {
    return this.svc.listUsers(req.tenantId);
  }

  @Patch('users/:id/role')
  @Roles('admin')
  updateUserRole(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<UserSummary> {
    return this.svc.updateUserRole(req.tenantId, req.user, id, dto.role as Role);
  }

  @Delete('users/:id')
  @Roles('admin')
  @HttpCode(204)
  async removeUser(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.deactivateUser(req.tenantId, req.user, id);
  }

  @Get('invites')
  @Roles('admin')
  listInvites(@Req() req: AuthedRequest): Promise<InviteSummary[]> {
    return this.svc.listInvites(req.tenantId);
  }

  @Post('invites')
  @Roles('admin')
  @HttpCode(201)
  async createInvite(
    @Req() req: AuthedRequest,
    @Body() dto: CreateInviteDto,
  ): Promise<{ invite: InviteSummary; devToken?: string }> {
    return this.svc.createInvite(req.tenantId, req.user, { email: dto.email, role: dto.role as Role });
  }

  @Post('invites/:id/resend')
  @Roles('admin')
  @HttpCode(200)
  resendInvite(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ devToken?: string }> {
    return this.svc.resendInvite(req.tenantId, req.user, id);
  }

  @Delete('invites/:id')
  @Roles('admin')
  @HttpCode(204)
  async revokeInvite(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<void> {
    await this.svc.revokeInvite(req.tenantId, id);
  }
}

/**
 * Public invite endpoints — no JWT required. The invite token IS the auth.
 * Lives under /invites for clean URL semantics ("/invites/:token/preview"
 * reads better than tucking under /tenant which implies auth).
 */
@Controller('invites')
export class InvitesPublicController {
  constructor(private readonly svc: TeamService) {}

  @Get(':token/preview')
  async preview(@Param('token') token: string): Promise<{ email: string; role: Role; tenantName: string } | null> {
    return this.svc.previewInvite(token);
  }

  @Post('accept')
  @HttpCode(200)
  accept(@Body() dto: AcceptInviteDto): Promise<{ token: string; user: JwtPayload }> {
    return this.svc.acceptInvite(dto.token, dto.password);
  }
}
