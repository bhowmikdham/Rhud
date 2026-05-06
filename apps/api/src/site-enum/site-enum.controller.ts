/**
 * Site enumeration endpoints — internal (rep-facing) only.
 *
 *   POST /opportunities/:id/site-enumeration         — kick off / re-kick a crawl
 *   GET  /opportunities/:id/site-enumeration         — current state + categorised scope
 *   POST /opportunities/:id/site-enumeration/map     — map to a specific rate card → ScopedEntity[]
 *   POST /opportunities/:id/site-enumeration/quote   — convenience: map to default rate card → BasePriceResult
 *   POST /site-enumerations/:id/retry                — manual retry (after a failed run)
 *
 * All routes are JWT-guarded; mutating routes require admin/manager/rep.
 */

import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import {
  SiteEnumService,
  type KickoffResult,
  type DiscoveredPageRow,
} from './site-enum.service.js';
import {
  KickoffSiteEnumerationDto,
  MapToRateCardDto,
} from './dto.js';
import type { SiteEnumerationStateView, ScopedEntity } from '@rhud/shared';

@Controller('opportunities/:id/site-enumeration')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SiteEnumController {
  constructor(private readonly svc: SiteEnumService) {}

  @Post()
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(202)
  kickoff(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: KickoffSiteEnumerationDto,
  ): Promise<KickoffResult> {
    return this.svc.kickoff(req.tenantId, engagementId, dto.siteUrl, dto.options ?? {});
  }

  @Get()
  get(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ): Promise<SiteEnumerationStateView | null> {
    return this.svc.getState(req.tenantId, engagementId);
  }

  @Post('map')
  @Roles('admin', 'sales_manager', 'sales_employee')
  map(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Body() dto: MapToRateCardDto,
  ): Promise<{ entities: ScopedEntity[] }> {
    return this.svc
      .mapToRateCard(req.tenantId, engagementId, dto.rateCardId)
      .then((entities) => ({ entities }));
  }

  @Post('quote')
  @Roles('admin', 'sales_manager', 'sales_employee')
  quote(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ): Promise<{
    rateCardId: string;
    entities: ScopedEntity[];
    quote: Awaited<ReturnType<SiteEnumService['quoteAgainstDefaultRateCard']>>['quote'];
  }> {
    return this.svc.quoteAgainstDefaultRateCard(req.tenantId, engagementId);
  }

  /** Full list of every discovered page — URL, category, classifier
   *  confidence, etc. Backs the "view all" detail panel + CSV export. */
  @Get('pages')
  pages(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ): Promise<DiscoveredPageRow[]> {
    return this.svc.listPages(req.tenantId, engagementId);
  }

  /** Same data as /pages but rendered as CSV for download. The
   *  Content-Disposition header makes the browser save it instead of
   *  rendering inline. */
  @Get('pages.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async pagesCsv(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="site-scope-${engagementId.slice(0, 8)}.csv"`,
    );
    return this.svc.exportPagesCsv(req.tenantId, engagementId);
  }
}

/** Separate controller for the retry endpoint so the route shape
 *  reads naturally: /site-enumerations/:id/retry instead of
 *  nesting under /opportunities/:engagementId/. */
@Controller('site-enumerations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SiteEnumRetryController {
  constructor(private readonly svc: SiteEnumService) {}

  @Post(':id/retry')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(202)
  retry(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) enumerationId: string,
  ): Promise<KickoffResult> {
    return this.svc.retry(req.tenantId, enumerationId);
  }
}
