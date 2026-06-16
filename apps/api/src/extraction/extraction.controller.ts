/**
 * Document extraction endpoints.
 *
 *   GET  /opportunities/:id/extraction       — list files + statuses + points
 *   POST /opportunities/:id/files/:fileId/extract — re-run extraction on one file
 *
 * Both alias under /engagements for legacy. Anyone in the tenant can
 * read; managers + admins + reps can re-run (it's a self-service action).
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsIn, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import {
  ExtractionService,
  type FileExtractionRow,
} from './extraction.service.js';

class OverrideInferredEntityDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  scopeValue?: number;

  /** Pass null to clear methodology (wildcard match). */
  @IsOptional()
  methodology?: string | null;

  @IsOptional()
  @IsIn(['internal', 'external'])
  customerType?: 'internal' | 'external';
}

class ServiceLineSlugParam {
  @IsString()
  slug!: string;
}
void ServiceLineSlugParam; // reserved for future @Param dto-validation

@Controller([
  'opportunities/:id',
  'engagements/:id',
])
@UseGuards(JwtAuthGuard, RolesGuard)
export class ExtractionController {
  constructor(private readonly svc: ExtractionService) {}

  @Get('extraction')
  list(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) engagementId: string,
  ): Promise<FileExtractionRow[]> {
    return this.svc.listForEngagement(req.tenantId, engagementId);
  }

  @Post('files/:fileId/extract')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(202)
  async extract(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) _engagementId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ): Promise<{ status: 'kicked_off' }> {
    void _engagementId; // route param kept for URL clarity / RLS scoping
    await this.svc.forceExtract(req.tenantId, fileId);
    return { status: 'kicked_off' };
  }

  /** Re-run only the Layer-3 mapper using the file's cached extracted
   *  points. Use after a 429 / mapper failure — much faster than a full
   *  re-extract because the S3 fetch + text extraction are skipped. */
  @Post('files/:fileId/rerun-inference')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  async rerunInference(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) _engagementId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Query('force') force?: string,
  ): Promise<{ rerun: 'mapper_only' | 'full_extract' }> {
    void _engagementId;
    // `?force=true` bypasses the content-addressed inference cache for a fresh
    // LLM pass; default is cache-aware so an unchanged doc re-prices identically.
    return this.svc.rerunInference(req.tenantId, fileId, force === 'true' || force === '1');
  }

  /**
   * Read the canonical RhudDocument the parser captured for a file.
   * Powers the admin-review "Parsed structure" panel — shows exactly
   * what was lifted out of the bytes before any LLM step ran. Useful
   * when extraction quality is in question and we need to know whether
   * the parser, the LLM, or the rate-card hints are at fault.
   */
  @Get('files/:fileId/parsed-document')
  async parsedDocument(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) _engagementId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
  ): Promise<{ filename: string; document: object | null }> {
    void _engagementId;
    const result = await this.svc.getParsedDocument(req.tenantId, fileId);
    return {
      filename: result.filename,
      document: result.document as unknown as object | null,
    };
  }

  /**
   * Manual override of an inferred entity's pricing inputs. Used when
   * the LLM was conservative (e.g. picked scope=1 for "API: Yes" when
   * the doc actually has 23 endpoints) and the rep wants to correct it
   * without forcing a re-extraction.
   *
   * Slug isn't UUID-validated because rate-card service line slugs are
   * snake_case strings, not UUIDs.
   */
  @Patch('files/:fileId/inferred-entities/:slug')
  @Roles('admin', 'sales_manager', 'sales_employee')
  @HttpCode(200)
  async overrideEntity(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) _engagementId: string,
    @Param('fileId', new ParseUUIDPipe()) fileId: string,
    @Param('slug') slug: string,
    @Body() dto: OverrideInferredEntityDto,
  ): Promise<{ status: 'updated' }> {
    void _engagementId;
    await this.svc.overrideInferredEntity(req.tenantId, fileId, slug, {
      ...(dto.scopeValue != null && { scopeValue: dto.scopeValue }),
      ...(dto.methodology !== undefined && { methodology: dto.methodology }),
      ...(dto.customerType !== undefined && { customerType: dto.customerType }),
    });
    return { status: 'updated' };
  }
}
