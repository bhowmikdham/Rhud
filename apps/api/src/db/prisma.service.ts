import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Prisma client singleton.
 *
 * IMPORTANT: this service is module-private. Application code MUST access the
 * DB through `withTenant()` in ./with-tenant.ts, never through this client
 * directly. ESLint config enforces that (see apps/api/.eslintrc.cjs).
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
