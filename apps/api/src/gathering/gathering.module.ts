import { Module } from '@nestjs/common';
import { GatheringController } from './gathering.controller.js';
import { GatheringService } from './gathering.service.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';

@Module({
  imports: [PricingModule, IntegrationsModule],
  controllers: [GatheringController],
  providers: [GatheringService],
  exports: [GatheringService],
})
export class GatheringModule {}
