import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ExtractionService } from './extraction.service.js';
import { ExtractionController } from './extraction.controller.js';

/**
 * Document extraction — text + LLM-structured points pulled out of
 * client-uploaded files. Consumed by:
 *   - GatheringService (triggers extraction on file upload + on submit)
 *   - PredictionController (gates auto-prediction on extraction)
 *   - ProposalDraftService (could consume points; currently doesn't)
 *
 * Pulls PricingModule so it can re-compute the deterministic quote
 * after auto-promoting extracted points to engagement answers.
 */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    PricingModule,
    // Forward-ref because LlmModule imports IntegrationsModule which
    // pulls in storage etc. Direct import works in current graph but
    // forwardRef hardens against future cycles cheaply.
    forwardRef(() => LlmModule),
  ],
  controllers: [ExtractionController],
  providers: [ExtractionService],
  exports: [ExtractionService],
})
export class ExtractionModule {}
