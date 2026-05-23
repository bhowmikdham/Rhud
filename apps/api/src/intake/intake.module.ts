/**
 * Phase E — inbound ingestion module.
 *
 * Two public controllers (no JwtAuthGuard):
 *   - PartnerIntakeController: token-authed partner POST
 *   - EmailIntakeController:    Postmark inbound webhook
 *
 * One admin controller:
 *   - PartnerTokensController: admin CRUD under /tenant/partner-tokens
 *
 * Reuses upstream services rather than duplicating logic:
 *   - EngagementsService.issueForIntake (engagements module)
 *   - ExtractionService.kickoff         (extraction module)
 *   - ClassificationService.classifyOnSubmit (classification module)
 *   - S3Service.uploadBytes             (storage module)
 *   - ThreadService.emit*               (thread module)
 *
 * AuthModule is imported so JwtAuthGuard + RolesGuard work on the admin
 * partner-tokens controller. The two public controllers don't apply
 * those guards.
 */

import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { EngagementsModule } from '../engagements/engagements.module.js';
import { ExtractionModule } from '../extraction/extraction.module.js';
import { ClassificationModule } from '../classification/classification.module.js';
import { IntakeService } from './intake.service.js';
import { PartnerTokensService } from './partner-tokens.service.js';
import { PartnerTokensController } from './partner-tokens.controller.js';
import { PartnerIntakeController } from './partner-intake.controller.js';
import { EmailIntakeController } from './email-intake.controller.js';

@Module({
  imports: [
    AuthModule,
    ThreadModule,
    StorageModule,
    EngagementsModule,
    // forwardRef because both directions of the dep graph could
    // theoretically extend back into IntakeModule (e.g. classification
    // emitting an event that triggers re-classification later).
    forwardRef(() => ExtractionModule),
    forwardRef(() => ClassificationModule),
  ],
  controllers: [
    PartnerTokensController,
    PartnerIntakeController,
    EmailIntakeController,
  ],
  providers: [IntakeService, PartnerTokensService],
  exports: [IntakeService, PartnerTokensService],
})
export class IntakeModule {}
