/**
 * Phase B HTTP routes for classification + routing.
 *
 *   Categories
 *     GET    /opportunity-categories                 list (tree)
 *
 *   Classification (per engagement)
 *     GET    /opportunities/:id/classification
 *     POST   /opportunities/:id/classify             manual: pick category
 *     POST   /opportunities/:id/classify/auto        re-run LLM classify
 *
 *   Reviewer assignment (per engagement)
 *     PATCH  /opportunities/:id/reviewer             manual reassign
 *
 *   Routing rules (admin)
 *     GET    /tenant/routing-rules
 *     PUT    /tenant/routing-rules                   upsert by (category, reviewer)
 *     DELETE /tenant/routing-rules/:id
 */

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
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { CategoriesService } from './categories.service.js';
import { ClassificationService } from './classification.service.js';
import { RoutingService } from './routing.service.js';

class ManualClassifyDto {
  @IsString() @MinLength(1) categorySlug!: string;
  @IsOptional() @IsString() subCategorySlug?: string | null;
}

class ReassignReviewerDto {
  @IsOptional() @IsUUID() reviewerUserId?: string | null;
  @IsOptional() @IsString() @MaxLength(2000) reason?: string;
}

class UpsertRoutingRuleDto {
  @IsString() @MinLength(1) categorySlug!: string;
  @IsUUID() reviewerUserId!: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

// ── Categories (read) ────────────────────────────────────────────────

@Controller('opportunity-categories')
@UseGuards(JwtAuthGuard)
export class CategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Get()
  tree(@Req() req: AuthedRequest) {
    return this.svc.getTree(req.tenantId);
  }
}

// ── Engagement-level classify + reassign ─────────────────────────────

@Controller(['opportunities/:id', 'engagements/:id'])
@UseGuards(JwtAuthGuard, RolesGuard)
export class EngagementClassifyController {
  constructor(
    private readonly classification: ClassificationService,
    private readonly routing: RoutingService,
  ) {}

  @Get('classification')
  getClassification(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.classification.getCurrent(req.tenantId, id);
  }

  @Post('classify')
  @Roles('admin', 'sales_manager', 'tech_team')
  manualClassify(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ManualClassifyDto,
  ) {
    return this.classification.classifyManual(
      req.tenantId,
      id,
      { categorySlug: dto.categorySlug, subCategorySlug: dto.subCategorySlug ?? null },
      req.user.sub,
    );
  }

  @Post('classify/auto')
  @Roles('admin', 'sales_manager', 'tech_team', 'sales_employee')
  autoClassify(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.classification.classifyEngagement(req.tenantId, id, req.user.sub);
  }

  @Patch('reviewer')
  @Roles('admin', 'sales_manager')
  reassignReviewer(
    @Req() req: AuthedRequest,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: ReassignReviewerDto,
  ) {
    return this.routing.reassignReviewer(
      req.tenantId,
      id,
      { reviewerUserId: dto.reviewerUserId ?? null, ...(dto.reason ? { reason: dto.reason } : {}) },
      req.user.sub,
    );
  }
}

// ── Tenant routing rules ────────────────────────────────────────────

@Controller('tenant/routing-rules')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RoutingRulesController {
  constructor(private readonly svc: RoutingService) {}

  @Get()
  @Roles('admin', 'sales_manager')
  list(@Req() req: AuthedRequest) {
    return this.svc.listRules(req.tenantId);
  }

  @Put()
  @Roles('admin')
  upsert(@Req() req: AuthedRequest, @Body() dto: UpsertRoutingRuleDto) {
    return this.svc.upsertRule(req.tenantId, dto);
  }

  @Delete(':id')
  @Roles('admin')
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param('id', new ParseUUIDPipe()) id: string) {
    await this.svc.deleteRule(req.tenantId, id);
  }
}
