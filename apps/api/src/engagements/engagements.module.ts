import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EngagementsController } from './engagements.controller.js';
import { EngagementsService } from './engagements.service.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';

@Module({
  // IngestionModule depends on EngagementsModule (for createFromIngest)
  // and EngagementsController depends on IngestionService (for the
  // /opportunities/from-ingest endpoint) — forwardRef breaks the cycle.
  imports: [AuthModule, forwardRef(() => IngestionModule)],
  controllers: [EngagementsController],
  providers: [EngagementsService],
  exports: [EngagementsService],
})
export class EngagementsModule {}
