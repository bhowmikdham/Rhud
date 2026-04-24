import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DbModule } from './db/db.module.js';
import { AuthModule } from './auth/auth.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // We validate with zod in ./config/env.ts on boot; leave Nest's
      // ConfigModule as a simple env provider.
    }),
    DbModule,
    AuthModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
