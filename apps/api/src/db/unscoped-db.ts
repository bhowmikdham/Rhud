import { Injectable } from '@nestjs/common';
import { SystemPrismaService } from './prisma.service.js';

/**
 * Whitelist of DB operations that genuinely cannot be tenant-scoped.
 *
 * There are only two such operations in the MVP, both at the auth boundary:
 *
 *   1. `findUserByEmail` — at login, we don't know the tenant yet.
 *   2. `findFreshMagicLinks` — we receive a raw token and must find the row
 *       before we know the tenant.
 *
 * Anything else MUST go through `TenantDb` (see ./with-tenant.ts).
 *
 * These queries run as the migration role (superuser) because `rhud_app` is
 * NOBYPASSRLS and can't read these tables without an app.tenant_id set. That
 * asymmetry is deliberate: unscoped access requires an explicit addition to
 * this file, visible in code review.
 */
@Injectable()
export class UnscopedDb {
  constructor(private readonly prisma: SystemPrismaService) {}

  async findUserByEmail(email: string): Promise<{
    id: string;
    tenantId: string;
    email: string;
    role: string;
    passwordHash: string | null;
  } | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; tenant_id: string; email: string; role: string; password_hash: string | null }>
    >`SELECT id, tenant_id, email, role, password_hash
        FROM users
       WHERE email = ${email}::citext
       LIMIT 1`;
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id,
      tenantId: r.tenant_id,
      email: r.email,
      role: r.role,
      passwordHash: r.password_hash,
    };
  }

  /**
   * Returns the N most recent unexpired, unconsumed magic links, so the caller
   * can argon2-verify the provided token against each candidate.
   *
   * Why N=50: magic-link windows are short (default 15 min) and the table is
   * indexed on (expires_at, consumed_at); in practice only a handful of rows
   * match at any moment. This bound stops pathological cases.
   */
  async findFreshMagicLinks(limit = 50): Promise<
    Array<{ id: string; tenantId: string; userId: string; tokenHash: string }>
  > {
    type Row = { id: string; tenant_id: string; user_id: string; token_hash: string };
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT id, tenant_id, user_id, token_hash
        FROM magic_links
       WHERE expires_at > now() AND consumed_at IS NULL
       ORDER BY created_at DESC
       LIMIT ${limit}`;
    return rows.map((r: Row) => ({
      id: r.id,
      tenantId: r.tenant_id,
      userId: r.user_id,
      tokenHash: r.token_hash,
    }));
  }

  /**
   * Returns active (unexpired, unrevoked) gathering tokens. The plaintext
   * token coming in over `/g/:token` doesn't reveal a tenant, so token
   * resolution scans candidates and verifies each via argon2.
   *
   * `LIMIT 200` is comfortably above any realistic in-flight count for a
   * tenant; a higher value here mostly trades RAM for fewer pages.
   */
  async findActiveGatheringTokens(limit = 200): Promise<
    Array<{
      id: string;
      tenantId: string;
      engagementId: string;
      tokenHash: string;
      boundFingerprintHash: string | null;
      accessCount: number;
    }>
  > {
    type Row = {
      id: string;
      tenant_id: string;
      engagement_id: string;
      token_hash: string;
      bound_fingerprint_hash: string | null;
      access_count: number;
    };
    const rows = await this.prisma.$queryRaw<Row[]>`SELECT id, tenant_id, engagement_id, token_hash,
                                                            bound_fingerprint_hash, access_count
        FROM gathering_tokens
       WHERE expires_at > now() AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT ${limit}`;
    return rows.map((r: Row) => ({
      id: r.id,
      tenantId: r.tenant_id,
      engagementId: r.engagement_id,
      tokenHash: r.token_hash,
      boundFingerprintHash: r.bound_fingerprint_hash,
      accessCount: r.access_count,
    }));
  }
}
