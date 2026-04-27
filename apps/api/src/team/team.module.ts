import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TeamService } from './team.service.js';
import { TeamController, InvitesPublicController } from './team.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [TeamController, InvitesPublicController],
  providers: [TeamService],
  exports: [TeamService],
})
export class TeamModule {}
