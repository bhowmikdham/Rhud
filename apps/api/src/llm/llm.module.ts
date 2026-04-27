import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { GammaModule } from '../gamma/gamma.module.js';
import { IntegrationsModule } from '../integrations/integrations.module.js';
import { LlmService } from './llm.service.js';
import { LlmController } from './llm.controller.js';
import { JustificationService } from './justification.service.js';
import { JustificationController } from './justification.controller.js';
import { TemplateGenService } from './template-gen.service.js';
import { TemplateGenController } from './template-gen.controller.js';
import { RateCardLlmParserService } from './rate-card-parser.service.js';
import { RateCardLlmParserController } from './rate-card-parser.controller.js';
import { ProposalDraftService } from './proposal-draft.service.js';
import { ProposalDraftController } from './proposal-draft.controller.js';

@Module({
  imports: [AuthModule, PricingModule, GammaModule, IntegrationsModule],
  controllers: [
    LlmController,
    JustificationController,
    TemplateGenController,
    RateCardLlmParserController,
    ProposalDraftController,
  ],
  providers: [
    LlmService,
    JustificationService,
    TemplateGenService,
    RateCardLlmParserService,
    ProposalDraftService,
  ],
  exports: [LlmService, ProposalDraftService],
})
export class LlmModule {}
