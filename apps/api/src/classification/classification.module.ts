import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { CategoriesService } from './categories.service.js';
import { ClassificationService } from './classification.service.js';
import { RoutingService } from './routing.service.js';
import {
  CategoriesController,
  EngagementClassifyController,
  RoutingRulesController,
} from './classification.controller.js';

/**
 * Phase B — opportunity classification + reviewer routing.
 *
 *   - CategoriesService: read the taxonomy (system + tenant rows)
 *   - ClassificationService: LLM-driven + manual classify
 *   - RoutingService: apply tenant rules → assign reviewer
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
    RoutingRulesController,
  ],
  providers: [CategoriesService, ClassificationService, RoutingService],
  exports: [CategoriesService, ClassificationService, RoutingService],
})
export class ClassificationModule {}
