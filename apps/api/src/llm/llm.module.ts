import { Module, forwardRef } from '@nestjs/common';
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
import {
  ProposalDraftController,
  ProposalTemplateController,
} from './proposal-draft.controller.js';

@Module({
  // PricingModule is forwardRef'd because PricingModule itself
  // forwardRef-imports LlmModule (so RateCardFieldMapperService can
  // call the per-tenant LLM). Both ends of the cycle have to use
  // forwardRef or Nest fails to resolve module[1] = undefined at boot.
  imports: [AuthModule, forwardRef(() => PricingModule), GammaModule, IntegrationsModule],
  controllers: [
    LlmController,
    JustificationController,
    TemplateGenController,
    RateCardLlmParserController,
    ProposalDraftController,
    ProposalTemplateController,
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
