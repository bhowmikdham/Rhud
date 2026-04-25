import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Two Prisma clients, two roles, by design.
 *
 * `AppPrismaService` connects as the runtime `rhud_app` role (NOBYPASSRLS).
 * Every query through it is filtered by RLS policies — meaning every query
 * MUST happen inside a `TenantDb.run()` scope, or it returns zero rows.
 * This is the workhorse client. ~99% of API code paths hit it.
 *
 * `SystemPrismaService` connects as the migration `rhud` superuser
 * (BYPASSRLS). It exists for the narrow set of operations that legitimately
 * cannot know the tenant up front — the auth-boundary whitelist in
 * `UnscopedDb` (find user by email at login, find unconsumed magic links).
 *
 * The two-client split is what makes RLS actually enforce. A single client
 * connecting as the superuser would silently bypass every tenant policy.
 *
 * Both classes are module-private to `src/db/`. The ESLint rule in
 * eslint.config.mjs prevents importing `@prisma/client` outside this folder.
 */

@Injectable()
export class AppPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AppPrismaService.name);

  constructor() {
    // Prefer APP_DATABASE_URL (rhud_app role); fall back to DATABASE_URL so
    // first-time local boots don't fail before the user reads the README.
    // Production must set APP_DATABASE_URL — see env.ts comment.
    const url = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
    super(url ? { datasources: { db: { url } } } : {});
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected (runtime role — RLS enforced)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

@Injectable()
export class SystemPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SystemPrismaService.name);

  constructor() {
    // Always uses DATABASE_URL — the superuser. Used only by UnscopedDb.
    super();
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected (system role — bypasses RLS)');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
