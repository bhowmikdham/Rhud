import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MlClient } from './ml-client.service.js';
import { MlController } from './ml.controller.js';
import { MlService } from './ml.service.js';

@Global()
@Module({
  imports: [AuthModule],
  controllers: [MlController],
  providers: [MlClient, MlService],
  exports: [MlService],
})
export class MlModule {}
