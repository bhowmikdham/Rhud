import { Global, Module } from '@nestjs/common';
import { AppPrismaService, SystemPrismaService } from './prisma.service.js';
import { TenantDb } from './with-tenant.js';
import { UnscopedDb } from './unscoped-db.js';

/**
 * DB module wires two Prisma clients to two services:
 *   - AppPrismaService (rhud_app, RLS-enforced) → TenantDb
 *   - SystemPrismaService (superuser, BYPASSRLS) → UnscopedDb
 *
 * Both Prisma services are intentionally module-private — only `TenantDb`
 * and `UnscopedDb` are exported. The ESLint `no-restricted-imports` rule
 * bans `@prisma/client` outside this directory, so application code has no
 * syntactic way to reach a bare PrismaClient.
 */
@Global()
@Module({
  providers: [AppPrismaService, SystemPrismaService, TenantDb, UnscopedDb],
  exports: [TenantDb, UnscopedDb],
})
export class DbModule {}
