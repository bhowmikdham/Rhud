import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { GammaService } from './gamma.service.js';
import { GammaController } from './gamma.controller.js';

@Module({
  imports: [AuthModule],
  controllers: [GammaController],
  providers: [GammaService],
  exports: [GammaService],
})
export class GammaModule {}
