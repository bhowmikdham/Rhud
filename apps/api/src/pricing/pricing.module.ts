import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { QuoteService } from './quote.service.js';
import { QuoteController } from './quote.controller.js';
import { PredictionService } from './prediction.service.js';
import { PredictionController } from './prediction.controller.js';
import { TenantPricingConfigService } from './tenant-pricing-config.service.js';
import { TenantPricingConfigController } from './tenant-pricing-config.controller.js';

@Module({
  imports: [AuthModule, ThreadModule],
  controllers: [
    PricingController,
    QuoteController,
    PredictionController,
    TenantPricingConfigController,
  ],
  providers: [
    PricingService,
    QuoteService,
    PredictionService,
    TenantPricingConfigService,
  ],
  exports: [
    PricingService,
    QuoteService,
    PredictionService,
    TenantPricingConfigService,
  ],
})
export class PricingModule {}
