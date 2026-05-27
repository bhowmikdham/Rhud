import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EngagementsModule } from '../engagements/engagements.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { IngestionService } from './ingestion.service.js';
import { IngestionController } from './ingestion.controller.js';

/**
 * Direct-ingest pipeline — see docs/direct-ingest.md.
 *
 * The IngestionService stitches together channel adapters (paste-text,
 * file-drop, future webhooks) with the existing ExtractionService and
 * EngagementsService. It does NOT own a database table directly; it
 * writes via TenantDb to ingestion_artifacts + engagement_files.
 *
 * Why all these imports: receive() needs S3Service for inline bytes
 * + ThreadService for the requirements_ingested event; promote()
 * needs EngagementsService to mint the bare engagement +
 * ExtractionService to kick off file processing post-commit.
 */
@Module({
  imports: [
    AuthModule,
    StorageModule,
    forwardRef(() => EngagementsModule),
    ExtractionModule,
    // ThreadModule is @Global — no explicit import needed.
  ],
  controllers: [IngestionController],
  providers: [IngestionService],
  exports: [IngestionService],
})
export class IngestionModule {}
