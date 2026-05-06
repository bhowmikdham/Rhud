import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ThreadModule } from '../thread/thread.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { QuoteService } from './quote.service.js';
import { QuoteController } from './quote.controller.js';
import { PredictionService } from './prediction.service.js';
import { PredictionController } from './prediction.controller.js';
import { TenantPricingConfigService } from './tenant-pricing-config.service.js';
import { TenantPricingConfigController } from './tenant-pricing-config.controller.js';
import { RateCardFieldMapperService } from './rate-card-mapper.service.js';
import { RateCardHintSynthesizerService } from './rate-card-hint-synthesizer.service.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';

@Module({
  // forwardRef: LlmModule transitively imports IntegrationsModule which
  // could cycle back through pricing later. The forward-ref harmlessly
  // breaks that risk now without forcing a module re-org. IntegrationsModule
  // is imported eagerly because PredictionController + QuoteService inject
  // OdooService synchronously.
  imports: [AuthModule, ThreadModule, forwardRef(() => LlmModule), IntegrationsModule],
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
    RateCardFieldMapperService,
    RateCardHintSynthesizerService,
  ],
  exports: [
    PricingService,
    QuoteService,
    PredictionService,
    TenantPricingConfigService,
    RateCardFieldMapperService,
    RateCardHintSynthesizerService,
  ],
})
export class PricingModule {}
