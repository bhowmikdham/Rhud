import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EmailModule } from '../email/email.module.js';
import { TeamService } from './team.service.js';
import { TeamController, InvitesPublicController } from './team.controller.js';

@Module({
  imports: [AuthModule, EmailModule],
  controllers: [TeamController, InvitesPublicController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
