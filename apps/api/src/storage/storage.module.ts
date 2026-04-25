import { Global, Module } from '@nestjs/common';
import { S3Service } from './s3.service.js';

@Global()
@Module({
  providers: [S3Service],
  exports: [S3Service],
})
export class StorageModule {}
