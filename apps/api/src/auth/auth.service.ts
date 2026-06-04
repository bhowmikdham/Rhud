import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Role } from '@rhud/shared';
import { isRole } from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { EmailService } from '../email/email.service.js';
import { S3Service } from '../storage/s3.service.js';
import { isAllowedImageType } from '../storage/media.js';
import { loadEnv } from '../config/env.js';
import type { JwtPayload, MeResponse } from './auth.types.js';

/** Default email-verification window: 24 hours. */
const VERIFY_TTL_HOURS = 24;
/** Default password-reset window: 60 minutes. */
const RESET_TTL_MINUTES = 60;
/** Signed-GET TTL for avatar urls. Long enough to outlive an open tab
 *  between profile re-fetches; re-signed on every GET /auth/me. */
const AVATAR_URL_TTL_SECONDS = 6 * 3600;

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
    private readonly s3: S3Service,
  ) {}

  async loginWithPassword(
    email: string,
    password: string,
  ): Promise<{ token: string; user: JwtPayload }> {
    const user = await this.unscoped.findUserByEmail(email);
    if (!user || !user.passwordHash) throw new UnauthorizedException('invalid_credentials');

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedException('invalid_credentials');

    // Force the email-verification round-trip before granting a session.
    // Seeded users have email_verified=true by default so this doesn't
    // affect them; only self-serve signups (where we set false explicitly)
    // can land here.
    if (!user.emailVerified) {
      throw new UnauthorizedException('email_not_verified');
    }

    return this.issueJwt(user);
  }

  // ── Self-serve signup ──────────────────────────────────────────────

  /**
   * Create a new tenant + admin user atomically and email a verification
   * link. The user can't sign in until they click the link (see
   * loginWithPassword's email_verified check).
   *
   * Returns the plaintext token only when NODE_ENV !== 'production' so
   * dev runs without SES can still complete the round-trip.
   */
  async signup(args: {
    email: string;
    password: string;
    tenantName: string;
    userName?: string;
    /** Industry-template slug to clone the starting taxonomy from. The
     *  UnscopedDb call validates it exists; on miss it throws and the
     *  transaction rolls back so we never half-create a tenant. */
    industryTemplateSlug?: string;
  }): Promise<{ ok: true; devToken?: string }> {
    const existing = await this.unscoped.findUserByEmail(args.email);
    if (existing) throw new ConflictException('email_already_registered');

    const env = loadEnv();
    const passwordHash = await argon2.hash(args.password);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);
    const expiresAt = new Date(Date.now() + VERIFY_TTL_HOURS * 3600_000);

    const created = await this.unscoped.createTenantWithAdmin({
      tenantName: args.tenantName,
      email: args.email,
      ...(args.userName !== undefined ? { userName: args.userName } : {}),
      ...(args.industryTemplateSlug !== undefined
        ? { industryTemplateSlug: args.industryTemplateSlug }
        : {}),
      passwordHash,
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: expiresAt,
    });

    // Best-effort send. If SES is down or the recipient is unverified (sandbox),
    // signup still succeeds — the controller surfaces devToken in dev and an
    // admin can re-trigger from a future "resend verification" endpoint in prod.
    void this.email.sendVerifyEmail({
      to: args.email,
      verifyUrl: `${env.WEB_PUBLIC_URL}/auth/verify-email?token=${encodeURIComponent(token)}`,
      expiresInHours: VERIFY_TTL_HOURS,
      tenantName: args.tenantName,
    });

    this.logger.log(`signup created tenant=${created.tenantId} user=${created.userId} email=${args.email}`);
    return process.env.NODE_ENV !== 'production' ? { ok: true, devToken: token } : { ok: true };
  }

  /**
   * Verify an email-verification token from /auth/verify-email?token=...
   * On success, mark the user verified and issue a JWT so the user lands
   * straight in the dashboard.
   */
  async verifyEmail(token: string): Promise<{ token: string; user: JwtPayload }> {
    const candidates = await this.unscoped.findPendingEmailVerifications();
    let matched: { id: string; tenantId: string; email: string } | null = null;

    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, token)) {
        matched = { id: row.id, tenantId: row.tenantId, email: row.email };
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_token');

    await this.unscoped.markEmailVerified(matched.id);

    // Re-read so the JWT carries the latest role (and confirms the row).
    const fresh = await this.unscoped.findUserByEmail(matched.email);
    if (!fresh) throw new UnauthorizedException('user_not_found');
    return this.issueJwt(fresh);
  }

  // ── Password reset ─────────────────────────────────────────────────

  /**
   * Issue a single-use password-reset token. Always returns null-or-token
   * the same way as magic-link: the controller returns `{ok: true}` for
   * unknown emails too, so an attacker can't enumerate accounts.
   */
  async requestPasswordReset(email: string): Promise<string | null> {
    const user = await this.unscoped.findUserByEmail(email);
    if (!user) {
      this.logger.debug('password reset requested for unknown email (suppressed)');
      return null;
    }

    const env = loadEnv();
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);
    const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000);

    await this.tenantDb.run(user.tenantId, async (db) => {
      await db.passwordReset.create({
        data: { tenantId: user.tenantId, userId: user.id, tokenHash, expiresAt },
      });
    });

    void this.email.sendPasswordReset({
      to: user.email,
      resetUrl: `${env.WEB_PUBLIC_URL}/auth/reset-password?token=${encodeURIComponent(token)}`,
      expiresInMinutes: RESET_TTL_MINUTES,
    });

    return token;
  }

  /**
   * Consume a password-reset token: verify, set new password, invalidate
   * the row, issue a JWT.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ token: string; user: JwtPayload }> {
    if (newPassword.length < 8) throw new BadRequestException('password_too_short');

    const candidates = await this.unscoped.findFreshPasswordResets();
    let matched: { id: string; tenantId: string; userId: string } | null = null;
    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, token)) {
        matched = { id: row.id, tenantId: row.tenantId, userId: row.userId };
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_token');

    const newHash = await argon2.hash(newPassword);
    const user = await this.tenantDb.run(matched.tenantId, async (db) => {
      await db.passwordReset.update({
        where: { id: matched!.id },
        data: { consumedAt: new Date() },
      });
      // Bump tokenVersion so every other outstanding session for this user is
      // invalidated by the reset (the freshly-issued token below carries the
      // new value and stays valid).
      return db.user.update({
        where: { id: matched!.userId },
        // Completing a reset proves email control (the link was emailed there),
        // so treat it as verification too — same rationale as magic-link.
        data: { passwordHash: newHash, tokenVersion: { increment: 1 }, emailVerified: true },
      });
    });

    return this.issueJwt({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
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
      // Consuming a magic link proves control of the email (the token was
      // emailed there), so treat it as verification. Closes the path where an
      // unverified self-serve signup gets a full session without ever proving
      // email ownership, and keeps emailVerified consistent for later logins.
      return db.user.update({
        where: { id: matched!.userId },
        data: { emailVerified: true },
      });
    });

    return this.issueJwt({
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion,
    });
  }

  // ── Profile (self) ────────────────────────────────────────────────

  /** GET /auth/me — enriched view of the signed-in user. Reads the row
   *  from the DB so we can surface `name` + `avatarUrl` (neither is in
   *  the JWT). */
  async getMyProfile(actor: JwtPayload): Promise<MeResponse> {
    const row = await this.tenantDb.run(actor.tid, async (db) =>
      db.user.findUnique({
        where: { id: actor.sub },
        select: { id: true, email: true, name: true, role: true, tenantId: true, avatarKey: true },
      }),
    );
    if (!row) throw new NotFoundException('user_not_found');
    if (!isRole(row.role)) throw new UnauthorizedException('invalid_user_role');
    return {
      sub: row.id,
      tid: row.tenantId,
      email: row.email,
      role: row.role as Role,
      name: row.name,
      avatarUrl: await this.resolveAvatarUrl(row.avatarKey),
    };
  }

  /** PATCH /auth/me — user updates their own profile. Trim + length-cap
   *  matches the dto; empty-after-trim clears the name (falls back to
   *  the email local-part in the UI). `avatarKey` is the S3 key the client
   *  just uploaded to (verified to sit under the caller's own prefix);
   *  null clears the photo. */
  async updateMyProfile(
    actor: JwtPayload,
    patch: { name?: string; avatarKey?: string | null },
  ): Promise<MeResponse> {
    const data: { name?: string | null; avatarKey?: string | null } = {};
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed.length > 120) throw new BadRequestException('name_too_long');
      data.name = trimmed.length === 0 ? null : trimmed;
    }
    if (patch.avatarKey !== undefined) {
      if (patch.avatarKey === null) {
        data.avatarKey = null;
      } else {
        // Security: a client could otherwise PATCH an arbitrary S3 key and
        // obtain a signed-GET url to another tenant's object. Only accept
        // keys under this user's own avatar prefix.
        const prefix = S3Service.avatarPrefixForUser({ tenantId: actor.tid, userId: actor.sub });
        if (!patch.avatarKey.startsWith(prefix)) {
          throw new BadRequestException('avatar_key_invalid');
        }
        data.avatarKey = patch.avatarKey;
      }
    }
    if (Object.keys(data).length === 0) {
      throw new BadRequestException('no_fields_to_update');
    }
    const row = await this.tenantDb.run(actor.tid, async (db) =>
      db.user.update({
        where: { id: actor.sub },
        data,
        select: { id: true, email: true, name: true, role: true, tenantId: true, avatarKey: true },
      }),
    );
    if (!isRole(row.role)) throw new UnauthorizedException('invalid_user_role');
    this.logger.log(`user profile updated tenant=${actor.tid} user=${actor.sub}`);
    return {
      sub: row.id,
      tid: row.tenantId,
      email: row.email,
      role: row.role as Role,
      name: row.name,
      avatarUrl: await this.resolveAvatarUrl(row.avatarKey),
    };
  }

  /** POST /auth/avatar/presign — hand back a signed PUT url for the
   *  caller's new profile photo. The returned `key` is echoed back to
   *  PATCH /auth/me once the client finishes the upload. */
  async presignAvatar(
    actor: JwtPayload,
    args: { contentType: string; filename?: string },
  ): Promise<{ uploadUrl: string; key: string; expiresAt: string }> {
    if (!isAllowedImageType(args.contentType)) {
      throw new BadRequestException('unsupported_image_type');
    }
    const key = S3Service.keyForUserAvatar({
      tenantId: actor.tid,
      userId: actor.sub,
      uploadId: randomUUID(),
      filename: args.filename?.trim() || 'avatar',
    });
    const { url, expiresAt } = await this.s3.presignPut({ key, contentType: args.contentType });
    return { uploadUrl: url, key, expiresAt };
  }

  /** Resolve a stored avatar key to a short-lived signed GET url. */
  private async resolveAvatarUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    try {
      return await this.s3.presignGet({ key, expiresInSeconds: AVATAR_URL_TTL_SECONDS });
    } catch {
      // Never fail the whole profile read because signing hiccuped.
      return null;
    }
  }

  private issueJwt(user: {
    id: string;
    tenantId: string;
    email: string;
    role: string;
    tokenVersion: number;
  }): { token: string; user: JwtPayload } {
    if (!isRole(user.role)) throw new UnauthorizedException('invalid_user_role');
    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      role: user.role as Role,
      email: user.email,
      tv: user.tokenVersion,
    };
    return { token: this.jwt.sign(payload), user: payload };
  }
}
