import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { TicketsService } from './tickets.service.js';
import { FollowUpsService } from './follow-ups.service.js';
import { SummaryService } from './summary.service.js';
import {
  LeadManagementController,
  LeadManagementDashboardController,
} from './lead-management.controller.js';

/**
 * Lead-management features that surface on every opportunity:
 *   - Tickets (complaints, change requests, internal check-ins)
 *   - Scheduled follow-ups
 *   - AI-generated lead summary (uses the configured LLM provider)
 *
 * forwardRef on LlmModule because it transitively depends on
 * IntegrationsModule, and we want to avoid hard cycles if any of
 * those modules later import this one.
 */
@Module({
  imports: [AuthModule, ThreadModule, forwardRef(() => LlmModule)],
  controllers: [LeadManagementController, LeadManagementDashboardController],
  providers: [TicketsService, FollowUpsService, SummaryService],
  exports: [TicketsService, FollowUpsService, SummaryService],
})
export class LeadManagementModule {}
