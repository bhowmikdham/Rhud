import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { TenantDb } from './with-tenant.js';
import { UnscopedDb } from './unscoped-db.js';

/**
 * DB module exposes `TenantDb` (the default) and `UnscopedDb` (narrow
 * whitelist for auth-boundary ops).
 *
 * `PrismaService` is intentionally NOT exported — making tenant-scoped
 * access the path of least resistance and cross-tenant access a conscious
 * decision that requires editing src/db/unscoped-db.ts.
 *
 * The ESLint `no-restricted-imports` rule bans `@prisma/client` outside this
 * directory, so application code has no syntactic way to reach the bare
 * PrismaClient.
 */
@Global()
@Module({
  providers: [PrismaService, TenantDb, UnscopedDb],
  exports: [TenantDb, UnscopedDb],
})
export class DbModule {}
