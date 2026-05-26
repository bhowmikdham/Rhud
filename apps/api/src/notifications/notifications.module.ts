import { Global, Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module.js';
import { NotificationsService } from './notifications.service.js';

/**
 * NotificationsService is global because both ThreadModule and (transitively)
 * the engagement flow rely on it. The actual outbound IO is delegated to
 * EmailService (SES) — see ../email/email.service.ts.
 */
@Global()
@Module({
  imports: [EmailModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
