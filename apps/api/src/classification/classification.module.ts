import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { CategoriesService } from './categories.service.js';
import { ClassificationService } from './classification.service.js';
import { RoutingService } from './routing.service.js';
import { TemplatesService } from './templates.service.js';
import {
  CategoriesController,
  EngagementClassifyController,
  IndustryTemplatesController,
  RoutingRulesController,
  TenantCategoriesController,
  TenantIndustryController,
} from './classification.controller.js';

/**
 * Phase B — opportunity classification + reviewer routing.
 *
 *   - CategoriesService: read + per-tenant CRUD on the taxonomy
 *   - ClassificationService: LLM-driven + manual classify
 *   - RoutingService: apply tenant rules → assign reviewer
 *   - TemplatesService: list / look up industry templates the tenant
 *       can clone via "Reset taxonomy"
 *
 * GatheringService calls ClassificationService.classifyOnSubmit at the
 * end of submit, fire-and-forget. Auth + thread + LLM modules are
 * imported eagerly; LlmModule via forwardRef to mirror the pattern in
 * the lead-management module (avoids a cycle through IntegrationsModule).
 */
@Module({
  imports: [AuthModule, ThreadModule, forwardRef(() => LlmModule)],
  controllers: [
    CategoriesController,
    EngagementClassifyController,
    IndustryTemplatesController,
    RoutingRulesController,
    TenantCategoriesController,
    TenantIndustryController,
  ],
  providers: [CategoriesService, ClassificationService, RoutingService, TemplatesService],
  exports: [CategoriesService, ClassificationService, RoutingService, TemplatesService],
})
export class ClassificationModule {}
