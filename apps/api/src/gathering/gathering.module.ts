import { Module } from '@nestjs/common';
import { GatheringController } from './gathering.controller.js';
import { GatheringService } from './gathering.service.js';

@Module({
  controllers: [GatheringController],
  providers: [GatheringService],
  exports: [GatheringService],
})
export class GatheringModule {}
