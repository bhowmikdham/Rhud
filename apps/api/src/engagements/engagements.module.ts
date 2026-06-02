import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EngagementsController } from './engagements.controller.js';
import { EngagementsService } from './engagements.service.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { PricingModule } from '../pricing/pricing.module.js';

@Module({
  // IngestionModule depends on EngagementsModule (for createFromIngest)
  // and EngagementsController depends on IngestionService (for the
  // /opportunities/from-ingest endpoint) — forwardRef breaks the cycle.
  //
  // ExtractionModule + PricingModule are imported eagerly for the
  // attach-rate-card endpoint (re-run inference → quote → predict).
  // Neither module's subtree imports EngagementsModule, so there's no
  // cycle to break here.
  imports: [AuthModule, forwardRef(() => IngestionModule), ExtractionModule, PricingModule],
  controllers: [EngagementsController],
  providers: [EngagementsService],
  exports: [EngagementsService],
})
export class EngagementsModule {}
