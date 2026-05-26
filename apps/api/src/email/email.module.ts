import { Module } from '@nestjs/common';
import { EmailService } from './email.service.js';

/**
 * Thin wrapper module so any feature module that needs to send email can
 * just import EmailModule. EmailService is a singleton with no DB or
 * tenant dependencies — pure outbound IO.
 */
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
