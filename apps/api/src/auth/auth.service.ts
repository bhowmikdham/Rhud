import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import type { Role } from '@rhud/shared';
import { isRole } from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { EmailService } from '../email/email.service.js';
import { loadEnv } from '../config/env.js';
import type { JwtPayload } from './auth.types.js';

/**
 * Auth sits at the boundary where we receive credentials but don't yet know
 * the tenant. Two flows need one unscoped read each, whitelisted in
 * `UnscopedDb`. Once the tenant id is known, we hand off to `TenantDb`.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly tenantDb: TenantDb,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string; user: JwtPayload }> {
    const user = await this.unscoped.findUserByEmail(email);
    if (!user || !user.passwordHash) throw new UnauthorizedException('invalid_credentials');

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('invalid_credentials');

    return this.issueJwt(user);
  }

  /**
   * Issue a single-use magic link. Returns the plaintext token so the caller
   * can email it; only the argon2 hash is persisted. Returns null for unknown
   * emails to prevent user enumeration.
   */
  async requestMagicLink(email: string): Promise<string | null> {
    const user = await this.unscoped.findUserByEmail(email);
    if (!user) {
      this.logger.debug('magic link requested for unknown email (suppressed)');
      return null;
    }

    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);
    const env = loadEnv();
    const expiresAt = new Date(Date.now() + env.MAGIC_LINK_TTL_MINUTES * 60_000);

    await this.tenantDb.run(user.tenantId, async (db) => {
      await db.magicLink.create({
        data: { tenantId: user.tenantId, userId: user.id, tokenHash, expiresAt },
      });
    });

    // Best-effort send. Dev environments (no EMAIL_FROM_ADDRESS) silently
    // skip; the controller still returns the plaintext token when
    // NODE_ENV !== 'production' so dev can keep working without SES.
    void this.email.sendMagicLink({
      to: user.email,
      magicUrl: `${env.WEB_PUBLIC_URL}/auth/magic?token=${encodeURIComponent(token)}`,
      expiresInMinutes: env.MAGIC_LINK_TTL_MINUTES,
    });

    return token;
  }

  async consumeMagicLink(token: string): Promise<{ token: string; user: JwtPayload }> {
    const candidates = await this.unscoped.findFreshMagicLinks();
    let matched: { tenantId: string; userId: string; id: string } | null = null;

    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, token)) {
        matched = { tenantId: row.tenantId, userId: row.userId, id: row.id };
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_token');

    const user = await this.tenantDb.run(matched.tenantId, async (db) => {
      await db.magicLink.update({
        where: { id: matched!.id },
        data: { consumedAt: new Date() },
      });
      return db.user.findUniqueOrThrow({ where: { id: matched!.userId } });
    });

    return this.issueJwt({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
    });
  }

  private issueJwt(user: {
    id: string;
    tenantId: string;
    email: string;
    role: string;
  }): { token: string; user: JwtPayload } {
    if (!isRole(user.role)) throw new UnauthorizedException('invalid_user_role');
    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      role: user.role as Role,
      email: user.email,
    };
    return { token: this.jwt.sign(payload), user: payload };
  }
}
