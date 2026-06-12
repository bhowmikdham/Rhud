import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GammaService } from './gamma.service.js';
import { GammaController } from './gamma.controller.js';
import { GammaTemplateService } from './gamma-template.service.js';
import { GammaTemplateController } from './gamma-template.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [GammaController, GammaTemplateController],
  providers: [GammaService, GammaTemplateService],
  // GammaTemplateService is exported so LlmModule's ProposalDraftService can
  // inject it for per-opportunity template resolution.
  exports: [GammaService, GammaTemplateService],
})
export class GammaModule {}
