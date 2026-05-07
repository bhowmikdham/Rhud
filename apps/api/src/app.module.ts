import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { TemplatesModule } from './templates/templates.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { ThreadModule } from './thread/thread.module.js';
import { StorageModule } from './storage/storage.module.js';
import { EngagementsModule } from './engagements/engagements.module.js';
import { GatheringModule } from './gathering/gathering.module.js';
import { AuditModule } from './audit/audit.module.js';
import { MlModule } from './ml/ml.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { TeamModule } from './team/team.module.js';
import { LlmModule } from './llm/llm.module.js';
import { GammaModule } from './gamma/gamma.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { ExtractionModule } from './extraction/extraction.module.js';
import { SiteEnumModule } from './site-enum/site-enum.module.js';
import { LeadManagementModule } from './lead-management/lead-management.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // We validate with zod in ./config/env.ts on boot; leave Nest's
      // ConfigModule as a simple env provider.
    }),
    DbModule,
    NotificationsModule,
    ThreadModule,
    StorageModule,
    AuthModule,
    TemplatesModule,
    EngagementsModule,
    GatheringModule,
    AuditModule,
    MlModule,
    PricingModule,
    TeamModule,
    GammaModule,
    LlmModule,
    IntegrationsModule,
    ExtractionModule,
    SiteEnumModule,
    LeadManagementModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
