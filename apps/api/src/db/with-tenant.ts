import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppPrismaService } from './prisma.service.js';

/**
 * The transactional client shape passed to a withTenant callback. We narrow
 * the full PrismaClient by removing methods that don't make sense (or are
 * outright forbidden) inside an already-open transaction.
 *
 * Note: Prisma's own `Prisma.TransactionClient` is typed as `any` in 5.x, so
 * we can't lean on it for real typing — hence this explicit Omit.
 */
export type PrismaTx = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

/**
 * The one and only way app code is allowed to touch the database.
 *
 * Opens a transaction, sets `app.tenant_id` as a transaction-local Postgres
 * setting (third arg `true` = LOCAL), and invokes `fn` with the transactional
 * client. RLS policies on every tenant-scoped table filter rows by
 * current_setting('app.tenant_id')::uuid, so any query issued inside `fn` is
 * automatically tenant-scoped — even raw SQL.
 *
 * Two safety properties:
 *   1. Transaction-local => auto-cleared at COMMIT/ROLLBACK. A pool handoff
 *      to the next request can never inherit a stale tenant id.
 *   2. The runtime DB role is NOBYPASSRLS (see infra/postgres/init/), so even
 *      a bug that forgets to set app.tenant_id returns zero rows rather than
 *      leaking across tenants.
 *
 * Forbidden: touching `prisma` directly from a handler or service. The lint
 * rule in .eslintrc.cjs enforces this. Integration tests assert cross-tenant
 * reads are empty.
 */
@Injectable()
export class TenantDb {
  constructor(private readonly prisma: AppPrismaService) {}

  async run<T>(tenantId: string, fn: (tx: PrismaTx) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx: PrismaTx) => {
      // set_config(name, value, is_local=true) — scoped to this tx only.
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
      return fn(tx);
    });
  }
}
