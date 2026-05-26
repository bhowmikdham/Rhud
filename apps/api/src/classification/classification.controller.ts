/**
 * Phase B HTTP routes for classification + routing.
 *
 *   Categories
 *     GET    /opportunity-categories                 list (tree)
 *     POST   /tenant/categories                      admin: create category
 *     PATCH  /tenant/categories/:slug                admin: rename/reorder/re-parent
 *     DELETE /tenant/categories/:slug                admin: soft-archive
 *     POST   /tenant/categories/bulk-reorder         admin: drag-to-save
 *
 *   Industry templates
 *     GET    /industry-templates                     authed: list verticals
 *     POST   /tenant/industry/reset                  admin: re-clone taxonomy
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
  BadRequestException,
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
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles, RolesGuard } from '../auth/roles.guard.js';
import type { AuthedRequest } from '../auth/auth.types.js';
import { CategoriesService } from './categories.service.js';
import { ClassificationService } from './classification.service.js';
import { RoutingService } from './routing.service.js';
import { TemplatesService } from './templates.service.js';

/** Confirmation phrase the user must type to trigger a taxonomy reset. */
const RESET_CONFIRM_PHRASE = 'RESET TAXONOMY';

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

class CreateCategoryDto {
  @IsString() @Matches(/^[a-z][a-z0-9_]*$/, { message: 'slug must be lowercase alphanumeric + underscore, starting with a letter' })
  @MaxLength(64)
  slug!: string;

  @IsString() @MinLength(1) @MaxLength(120) name!: string;

  @IsOptional() @IsString() parentSlug?: string | null;

  @IsOptional() @IsInt() @Min(0) position?: number;
}

class UpdateCategoryDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  /** Pass explicit null to promote a child to top-level; string to
   *  re-parent; omit to leave unchanged. class-validator's IsOptional
   *  accepts undefined OR null. */
  @IsOptional() @IsString() parentSlug?: string | null;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

class BulkReorderItemDto {
  @IsString() slug!: string;
  @IsInt() @Min(0) position!: number;
  @IsOptional() @IsString() parentSlug?: string | null;
}

class BulkReorderDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => BulkReorderItemDto)
  items!: BulkReorderItemDto[];
}

class ResetTaxonomyDto {
  @IsString() @MinLength(1) templateSlug!: string;
  @IsString() confirmText!: string;
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

// ── Tenant category CRUD (admin) ─────────────────────────────────────

@Controller('tenant/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantCategoriesController {
  constructor(private readonly svc: CategoriesService) {}

  @Post()
  @Roles('admin')
  create(@Req() req: AuthedRequest, @Body() dto: CreateCategoryDto) {
    return this.svc.create(req.tenantId, dto);
  }

  @Patch(':slug')
  @Roles('admin')
  update(
    @Req() req: AuthedRequest,
    @Param('slug') slug: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.svc.update(req.tenantId, slug, dto);
  }

  @Delete(':slug')
  @Roles('admin')
  @HttpCode(204)
  async archive(@Req() req: AuthedRequest, @Param('slug') slug: string) {
    await this.svc.archive(req.tenantId, slug);
  }

  @Post('bulk-reorder')
  @Roles('admin')
  @HttpCode(204)
  async bulkReorder(@Req() req: AuthedRequest, @Body() dto: BulkReorderDto) {
    await this.svc.bulkReorder(req.tenantId, dto);
  }
}

// ── Industry templates ───────────────────────────────────────────────

@Controller('industry-templates')
@UseGuards(JwtAuthGuard)
export class IndustryTemplatesController {
  constructor(private readonly svc: TemplatesService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    return this.svc.list(req.tenantId);
  }
}

@Controller('tenant/industry')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantIndustryController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly templates: TemplatesService,
  ) {}

  @Post('reset')
  @Roles('admin')
  @HttpCode(204)
  async reset(@Req() req: AuthedRequest, @Body() dto: ResetTaxonomyDto) {
    if (dto.confirmText !== RESET_CONFIRM_PHRASE) {
      // Generic message — the UI shows the expected phrase next to the
      // input, so the admin already knows what to type.
      throw new BadRequestException('confirmation_required');
    }
    // 404s with `unknown_industry_template` if the slug is invalid;
    // surfaces as a 404 rather than 400 to match other not-found paths.
    await this.templates.getBySlug(req.tenantId, dto.templateSlug);
    await this.categories.resetFromTemplate(req.tenantId, dto.templateSlug);
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
