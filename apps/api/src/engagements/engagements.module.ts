import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EngagementsController } from './engagements.controller.js';
import { EngagementsService } from './engagements.service.js';

@Module({
  imports: [AuthModule],
  controllers: [EngagementsController],
  providers: [EngagementsService],
  exports: [EngagementsService],
})
export class EngagementsModule {}
