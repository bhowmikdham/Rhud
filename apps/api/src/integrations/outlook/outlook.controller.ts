/**
 * Outlook OAuth + admin-config endpoints.
 *
 *   GET    /integrations/outlook/status     — am I connected? (jwt-guarded)
 *   GET    /integrations/outlook/authorize-url — start OAuth (jwt-guarded)
 *   GET    /integrations/outlook/callback   — exchange code, store tokens, 302 to UI
 *   POST   /integrations/outlook/disconnect — wipe my tokens
 *
 *   GET    /integrations/outlook/app-config — admin: am I set up? (jwt-guarded, admin)
 *   POST   /integrations/outlook/app-config — admin: save Entra creds
 *   DELETE /integrations/outlook/app-config — admin: wipe creds + all reps' tokens
 *
 * The callback intentionally has no JwtAuthGuard — it's hit by the
 * browser after Microsoft redirects, with no Rhud cookie/session in
 * play. We trust the signed `state` parameter to identify the
 * user + tenant.
 */

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../../auth/roles.guard.js';
import type { AuthedRequest } from '../../auth/auth.types.js';
import {
  OutlookService,
  type OutlookAppConfig,
  type OutlookConnectionStatus,
} from './outlook.service.js';

class UpsertAppConfigDto {
  @IsString()
  @MinLength(1)
  clientId!: string;

  @IsString()
  @MinLength(1)
  clientSecret!: string;
}

@Controller('integrations/outlook')
export class OutlookController {
  constructor(private readonly svc: OutlookService) {}

  // ── Per-user (anyone in the tenant) ──────────────────────────────

  @Get('status')
  @UseGuards(JwtAuthGuard)
  status(@Req() req: AuthedRequest): Promise<OutlookConnectionStatus> {
    return this.svc.getStatus(req.tenantId, req.user.sub);
  }

  /**
   * Returns the Microsoft authorize URL the browser should navigate
   * to. We do NOT 302 from here — the SPA's bearer token doesn't
   * survive a browser navigation.
   */
  @Get('authorize-url')
  @UseGuards(JwtAuthGuard)
  async authorizeUrl(@Req() req: AuthedRequest): Promise<{ url: string }> {
    const url = await this.svc.authorizeUrl(req.user.sub, req.tenantId);
    return { url };
  }

  /**
   * Microsoft redirects here with `code` + `state`. We exchange the
   * code, persist tokens, then redirect the browser back to
   * /integrations with a status query param.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Query('error_description') errorDescription: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const webBase = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    const integrationsUrl = (params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      return `${webBase}/integrations?${qs}`;
    };

    if (error) {
      res.redirect(302, integrationsUrl({
        outlook: 'error',
        reason: errorDescription ?? error,
      }));
      return;
    }
    if (!code || !state) {
      res.redirect(302, integrationsUrl({ outlook: 'error', reason: 'missing_code_or_state' }));
      return;
    }

    try {
      const result = await this.svc.completeConnect(code, state);
      res.redirect(302, integrationsUrl({
        outlook: 'connected',
        mailbox: result.accountEmail,
      }));
    } catch (e) {
      res.redirect(302, integrationsUrl({
        outlook: 'error',
        reason: (e as Error).message,
      }));
    }
  }

  @Post('disconnect')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async disconnect(@Req() req: AuthedRequest): Promise<void> {
    await this.svc.disconnect(req.tenantId, req.user.sub);
  }

  // ── Admin-only — Microsoft Entra app credentials ─────────────────

  @Get('app-config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  appConfig(@Req() req: AuthedRequest): Promise<OutlookAppConfig> {
    return this.svc.getAppConfig(req.tenantId);
  }

  @Post('app-config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(200)
  saveAppConfig(
    @Req() req: AuthedRequest,
    @Body() dto: UpsertAppConfigDto,
  ): Promise<OutlookAppConfig> {
    return this.svc.setAppConfig(req.tenantId, {
      clientId: dto.clientId,
      clientSecret: dto.clientSecret,
    });
  }

  @Delete('app-config')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @HttpCode(204)
  async clearAppConfig(@Req() req: AuthedRequest): Promise<void> {
    await this.svc.clearAppConfig(req.tenantId);
  }
}
