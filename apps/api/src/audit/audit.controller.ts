import { Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { AuditService } from './audit.service.js';

/**
 * Admin-only audit ops.
 *
 * `build` is normally invoked by the nightly seal cron (AuditSealService).
 * Exposing it as a manual endpoint lets ops re-run it after maintenance,
 * lets the smoke test exercise it deterministically, and gives compliance
 * reviewers a way to compute on demand. Same for `verify`. `status` is the
 * read model behind the admin "audit health" badge.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Post('build')
  @HttpCode(200)
  async build(@Req() req: AuthedRequest) {
    const result = await this.svc.build(req.tenantId);
    return result ?? { skipped: true, reason: 'no_new_events' };
  }

  @Post('verify')
  @HttpCode(200)
  verify(@Req() req: AuthedRequest) {
    return this.svc.verify(req.tenantId);
  }

  /** Chain health for the admin badge: link count, last sealed-at, verify. */
  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.svc.status(req.tenantId);
  }
}
