import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProposalDocxService } from './proposal-docx.service.js';
import { ProposalExportController } from './proposal-export.controller.js';

/**
 * Phase D — DOCX proposal export. Pure server-side render: no LLM
 * calls at render time. Reads engagement + quote + line items +
 * tenant proposal_defaults and builds a Word document via docx-js.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProposalExportController],
  providers: [ProposalDocxService],
  exports: [ProposalDocxService],
})
export class ProposalExportModule {}
