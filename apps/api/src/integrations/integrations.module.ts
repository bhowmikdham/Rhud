import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OutlookService } from './outlook/outlook.service.js';
import { OutlookController } from './outlook/outlook.controller.js';

/**
 * Per-user OAuth integrations for sending proposals from the rep's
 * own mailbox. Outlook today; Gmail planned next as a sibling
 * controller/service pair under this module.
 */
@Module({
  imports: [AuthModule],
  controllers: [OutlookController],
  providers: [OutlookService],
  exports: [OutlookService],
})
export class IntegrationsModule {}
