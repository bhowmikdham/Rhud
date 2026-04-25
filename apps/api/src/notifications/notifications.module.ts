import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import {
  ConsoleEmailTransport,
  EmailTransport,
  PostmarkEmailTransport,
} from './email.transport.js';

/**
 * One transport instance per process, picked at module-init time from
 * env. ConsoleEmailTransport is the default; flipping EMAIL_PROVIDER to
 * postmark switches the binding without any consumer change.
 */
function emailTransportProvider(): {
  provide: typeof EmailTransport;
  useClass: new () => EmailTransport;
} {
  const provider = process.env.EMAIL_PROVIDER ?? 'console';
  const useClass = provider === 'postmark' ? PostmarkEmailTransport : ConsoleEmailTransport;
  return { provide: EmailTransport, useClass };
}

@Global()
@Module({
  providers: [
    NotificationsService,
    ConsoleEmailTransport,
    PostmarkEmailTransport,
    emailTransportProvider(),
  ],
  exports: [NotificationsService, EmailTransport, ConsoleEmailTransport],
})
export class NotificationsModule {}
