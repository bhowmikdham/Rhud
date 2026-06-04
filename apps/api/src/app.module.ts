import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ThreadModule } from './thread/thread.module.js';
import { StorageModule } from './storage/storage.module.js';
import { EngagementsModule } from './engagements/engagements.module.js';
import { EmailExtractorModule } from './email-extractor/email-extractor.module.js';
import { GatheringModule } from './gathering/gathering.module.js';
import { AuditModule } from './audit/audit.module.js';
import { MlModule } from './ml/ml.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { TeamModule } from './team/team.module.js';
import { LlmModule } from './llm/llm.module.js';
import { GammaModule } from './gamma/gamma.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { ExtractionModule } from './extraction/extraction.module.js';
import { IngestionModule } from './ingestion/ingestion.module.js';
import { SiteEnumModule } from './site-enum/site-enum.module.js';
import { LeadManagementModule } from './lead-management/lead-management.module.js';
import { ClassificationModule } from './classification/classification.module.js';
import { EmailModule } from './email/email.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // We validate with zod in ./config/env.ts on boot; leave Nest's
      // ConfigModule as a simple env provider.
    }),
    // Per-IP rate limiting. Global module → ThrottlerGuard is usable on any
    // controller. Baseline 60 req/min; the auth + gathering controllers apply
    // tighter per-route limits. Behind a proxy this keys on req.ip, which is
    // correct only with `trust proxy` set (see main.ts).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    // App-wide scheduler foundation. Registering forRoot() once here turns on
    // @Cron/@Interval discovery for every feature module. First consumer: the
    // nightly audit-chain seal (AuditModule → AuditSealService). The existing
    // cross-tenant retry sweepers in UnscopedDb (extraction/site-enum retries,
    // email-cache purge) are written but currently unfired — they hang off this
    // same foundation next. Idempotency/retry via a real queue (BullMQ/Redis)
    // is the deferred hardening step; v1 relies on single-node serialization.
    ScheduleModule.forRoot(),
    DbModule,
    NotificationsModule,
    ThreadModule,
    StorageModule,
    AuthModule,
    TemplatesModule,
    EngagementsModule,
    EmailExtractorModule,
    GatheringModule,
    AuditModule,
    MlModule,
    PricingModule,
    TeamModule,
    GammaModule,
    LlmModule,
    IntegrationsModule,
    ExtractionModule,
    IngestionModule,
    SiteEnumModule,
    LeadManagementModule,
    ClassificationModule,
    EmailModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
