import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { AuditController } from './audit.controller.js';
import { AuditService } from './audit.service.js';
import { AuditSealService } from './audit-seal.service.js';

@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  // AuditSealService carries the @Cron nightly seal. It depends on UnscopedDb,
  // which DbModule exports globally. Registering it here is enough for the
  // global ScheduleModule to discover and schedule its cron handler.
  providers: [AuditService, AuditSealService],
  exports: [AuditService],
})
export class AuditModule {}
