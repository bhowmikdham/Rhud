import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { EmailExtractorService } from './email-extractor.service.js';
import { EmailPreviewController } from './email-preview.controller.js';

/**
 * Standalone module for the Outlook add-in's email preview. Imports
 * LlmModule for per-tenant extraction. Deliberately NOT imported by
 * EngagementsModule — that would re-introduce the
 * LlmModule → IntegrationsModule → EngagementsModule cycle. AppModule
 * registers both side by side. TenantDb + UnscopedDb come from the
 * global DbModule.
 */
@Module({
  imports: [AuthModule, LlmModule],
  controllers: [EmailPreviewController],
  providers: [EmailExtractorService],
})
export class EmailExtractorModule {}
