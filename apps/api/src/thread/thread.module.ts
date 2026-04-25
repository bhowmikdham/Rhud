import { Global, Module } from '@nestjs/common';
import { ThreadService } from './thread.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [ThreadService],
  exports: [ThreadService],
})
export class ThreadModule {}
