/**
 * Team management — list/role-update/deactivate users + invite lifecycle.
 *
 * All admin endpoints route through here. Tenant isolation comes for free
 * via TenantDb; the only unscoped path is `acceptInvite`, which receives
 * a raw token before we know the tenant — same pattern as magic-link
 * consumption. That path is whitelisted in UnscopedDb.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { ROLES, isRole, type Role } from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { EmailTransport } from '../notifications/email.transport.js';
import { renderInviteEmail } from '../notifications/email.templates.js';
import type { JwtPayload } from '../auth/auth.types.js';

// 7 days — long enough that reasonable people get to it, short enough
// that a forgotten invite doesn't hang around forever.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface InviteRow {
  id: string;
  email: string;
  role: string;
  invitedById: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);
  private readonly portalBase = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly unscoped: UnscopedDb,
    private readonly jwt: JwtService,
    private readonly transport: EmailTransport,
  ) {}

  // ── Tenant identity ─────────────────────────────────────────────────────

  async getTenant(tenantId: string): Promise<{ id: string; name: string; plan: string; leadSummaryAutoGenerate: boolean }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, name: true, plan: true, leadSummaryAutoGenerate: true },
      });
      if (!row) throw new NotFoundException('tenant_not_found');
      return row;
    });
  }

  async updateTenant(
    tenantId: string,
    actor: JwtPayload,
    args: { name?: string; leadSummaryAutoGenerate?: boolean },
  ): Promise<{ id: string; name: string; plan: string; leadSummaryAutoGenerate: boolean }> {
    const data: { name?: string; leadSummaryAutoGenerate?: boolean } = {};
    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed.length === 0) throw new BadRequestException('name_required');
      if (trimmed.length > 120) throw new BadRequestException('name_too_long');
      data.name = trimmed;
    }
    if (args.leadSummaryAutoGenerate !== undefined) {
      data.leadSummaryAutoGenerate = !!args.leadSummaryAutoGenerate;
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('no_fields_to_update');

    return this.tenantDb.run(tenantId, async (db) => {
      const updated = await db.tenant.update({
        where: { id: tenantId },
        data,
        select: { id: true, name: true, plan: true, leadSummaryAutoGenerate: true },
      });
      this.logger.log(`tenant ${tenantId} updated by ${actor.sub}: ${JSON.stringify(data)}`);
      return updated;
    });
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async listUsers(tenantId: string): Promise<UserSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.user.findMany({
        orderBy: [{ createdAt: 'asc' }],
        select: { id: true, email: true, role: true, createdAt: true },
      });
      return rows.map((u) => ({
        id: u.id,
        email: u.email,
        role: u.role as Role,
        createdAt: u.createdAt.toISOString(),
      }));
    });
  }

  async updateUserRole(
    tenantId: string,
    actor: JwtPayload,
    userId: string,
    role: Role,
  ): Promise<UserSummary> {
    if (!isRole(role)) throw new BadRequestException('invalid_role');

    return this.tenantDb.run(tenantId, async (db) => {
      const target = await db.user.findUnique({ where: { id: userId } });
      if (!target) throw new NotFoundException('user_not_found');
      if (target.role === 'admin' && role !== 'admin') {
        // Don't let the last admin demote themselves and lock the tenant.
        const adminCount = await db.user.count({ where: { role: 'admin' } });
        if (adminCount <= 1) throw new ForbiddenException('cannot_demote_last_admin');
      }
      const updated = await db.user.update({ where: { id: userId }, data: { role } });
      this.logger.log(`role change tenant=${tenantId} actor=${actor.sub} target=${userId} -> ${role}`);
      return {
        id: updated.id,
        email: updated.email,
        role: updated.role as Role,
        createdAt: updated.createdAt.toISOString(),
      };
    });
  }

  async deactivateUser(tenantId: string, actor: JwtPayload, userId: string): Promise<void> {
    if (actor.sub === userId) throw new ForbiddenException('cannot_remove_self');
    await this.tenantDb.run(tenantId, async (db) => {
      const target = await db.user.findUnique({ where: { id: userId } });
      if (!target) throw new NotFoundException('user_not_found');
      if (target.role === 'admin') {
        const adminCount = await db.user.count({ where: { role: 'admin' } });
        if (adminCount <= 1) throw new ForbiddenException('cannot_remove_last_admin');
      }
      // Hard delete: cascading FKs (engagements.sales_employee_id) would fail
      // for active users, so this surfaces as a 500 / FK error today. A future
      // soft-delete (active boolean) is the cleaner fix; for the MVP we'll
      // surface the FK error explicitly so the operator knows the user has
      // open work that needs reassignment first.
      await db.user.delete({ where: { id: userId } });
      this.logger.log(`user deleted tenant=${tenantId} actor=${actor.sub} target=${userId}`);
    });
  }

  // ── Invites ─────────────────────────────────────────────────────────────

  async listInvites(tenantId: string): Promise<InviteSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.invite.findMany({
        orderBy: [{ createdAt: 'desc' }],
      });
      const inviterIds = Array.from(new Set(rows.map((r) => r.invitedById)));
      const inviters = inviterIds.length
        ? await db.user.findMany({
            where: { id: { in: inviterIds } },
            select: { id: true, email: true },
          })
        : [];
      const byId = new Map(inviters.map((u) => [u.id, u.email]));
      return rows.map((r) => this.toSummary(r, byId.get(r.invitedById) ?? null));
    });
  }

  /**
   * Create a new invite + send the email. Returns the summary; the
   * plaintext token is only ever in the email body (and, in dev, returned
   * via the controller for testing — same pattern as magic links).
   */
  async createInvite(
    tenantId: string,
    actor: JwtPayload,
    args: { email: string; role: Role },
  ): Promise<{ invite: InviteSummary; devToken?: string }> {
    if (!isRole(args.role)) throw new BadRequestException('invalid_role');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);

    // Email uniqueness is GLOBAL (not per-tenant) at the schema level.
    // A within-tenant findUnique is RLS-scoped and would miss users in
    // other tenants — accepting the invite later would then explode with
    // a P2002 unique constraint error. Check unscoped first.
    const globallyExisting = await this.unscoped.findUserByEmail(args.email);
    if (globallyExisting) throw new ConflictException('user_already_exists');

    const created = await this.tenantDb.run(tenantId, async (db) => {
      // Refuse if there's already an open invite for this email in this
      // tenant — the partial unique index enforces it but throw a clean
      // error first.
      const open = await db.invite.findFirst({
        where: { email: args.email, acceptedAt: null, revokedAt: null },
      });
      if (open) throw new ConflictException('invite_already_pending');

      return db.invite.create({
        data: {
          tenantId,
          email: args.email,
          role: args.role,
          tokenHash,
          invitedById: actor.sub,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
    });

    const acceptUrl = `${this.portalBase.replace(/\/$/, '')}/accept-invite?token=${token}`;
    const rendered = renderInviteEmail({
      to: args.email,
      role: args.role,
      inviterEmail: actor.email,
      acceptUrl,
    });

    try {
      await this.transport.send({
        to: args.email,
        subject: rendered.subject,
        textBody: rendered.textBody,
        notificationId: created.id,
      });
    } catch (err) {
      // Don't fail the create if mail blew up — admin can always resend.
      this.logger.error(
        `invite email send failed tenant=${tenantId} invite=${created.id}: ${(err as Error).message}`,
      );
    }

    const summary = this.toSummary(created, actor.email);
    if (process.env.NODE_ENV !== 'production') {
      return { invite: summary, devToken: token };
    }
    return { invite: summary };
  }

  /**
   * Re-send (or rotate) the invite email. Mints a fresh token + extends
   * expiry. The old token stops working. Useful when a user lost the link
   * or it expired.
   */
  async resendInvite(
    tenantId: string,
    actor: JwtPayload,
    inviteId: string,
  ): Promise<{ devToken?: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token);

    const invite = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.invite.findUnique({ where: { id: inviteId } });
      if (!row) throw new NotFoundException('invite_not_found');
      if (row.acceptedAt) throw new BadRequestException('invite_already_accepted');
      if (row.revokedAt) throw new BadRequestException('invite_revoked');

      return db.invite.update({
        where: { id: inviteId },
        data: { tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      });
    });

    const acceptUrl = `${this.portalBase.replace(/\/$/, '')}/accept-invite?token=${token}`;
    const rendered = renderInviteEmail({
      to: invite.email,
      role: invite.role as Role,
      inviterEmail: actor.email,
      acceptUrl,
    });

    try {
      await this.transport.send({
        to: invite.email,
        subject: rendered.subject,
        textBody: rendered.textBody,
        notificationId: invite.id,
      });
    } catch (err) {
      this.logger.error(`invite resend failed: ${(err as Error).message}`);
    }

    if (process.env.NODE_ENV !== 'production') return { devToken: token };
    return {};
  }

  async revokeInvite(tenantId: string, inviteId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.invite.findUnique({ where: { id: inviteId } });
      if (!row) throw new NotFoundException('invite_not_found');
      if (row.acceptedAt) throw new BadRequestException('invite_already_accepted');
      if (row.revokedAt) return; // idempotent
      await db.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } });
    });
  }

  /**
   * Public endpoint — receives the raw token and a chosen password. We
   * scan open invites unscoped (same shape as magic-link consumption),
   * argon2-verify, then create the user inside the matched tenant.
   */
  async acceptInvite(
    token: string,
    password: string,
  ): Promise<{ token: string; user: JwtPayload }> {
    const candidates = await this.unscoped.findOpenInvites();
    let matched: { id: string; tenantId: string; email: string; role: string } | null = null;

    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, token)) {
        matched = { id: row.id, tenantId: row.tenantId, email: row.email, role: row.role };
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_invite');
    if (!isRole(matched.role)) throw new UnauthorizedException('invalid_invite_role');

    const passwordHash = await argon2.hash(password);

    // Global email check — same reason as in createInvite. A cross-tenant
    // user could have been created between invite issuance and acceptance.
    const collision = await this.unscoped.findUserByEmail(matched.email);
    if (collision) throw new ConflictException('user_already_exists');

    const user = await this.tenantDb.run(matched.tenantId, async (db) => {
      // Race-safety: if someone else accepted in the meantime, we'd hit a
      // duplicate-email error on user.create. Re-check the invite first.
      const fresh = await db.invite.findUnique({ where: { id: matched!.id } });
      if (!fresh || fresh.acceptedAt || fresh.revokedAt || fresh.expiresAt < new Date()) {
        throw new UnauthorizedException('invalid_or_expired_invite');
      }

      const created = await db.user.create({
        data: {
          tenantId: matched!.tenantId,
          email: matched!.email,
          passwordHash,
          role: matched!.role,
        },
      });
      await db.invite.update({
        where: { id: matched!.id },
        data: { acceptedAt: new Date() },
      });
      return created;
    });

    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenantId,
      role: user.role as Role,
      email: user.email,
    };
    return { token: this.jwt.sign(payload), user: payload };
  }

  /** For the unauth'd accept page to preview who they are (email + role). */
  async previewInvite(token: string): Promise<{ email: string; role: Role; tenantName: string } | null> {
    const candidates = await this.unscoped.findOpenInvites();
    for (const row of candidates) {
      if (await argon2.verify(row.tokenHash, token)) {
        const tenantName = await this.unscoped.findTenantName(row.tenantId);
        return {
          email: row.email,
          role: row.role as Role,
          tenantName: tenantName ?? 'workspace',
        };
      }
    }
    return null;
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private toSummary(row: InviteRow, inviterEmail: string | null): InviteSummary {
    return {
      id: row.id,
      email: row.email,
      role: row.role as Role,
      status: this.deriveStatus(row),
      invitedByEmail: inviterEmail,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    };
  }

  private deriveStatus(row: InviteRow): InviteSummary['status'] {
    if (row.acceptedAt) return 'accepted';
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt < new Date()) return 'expired';
    return 'pending';
  }
}

// re-export for the controller's role validation typing
export const VALID_ROLES = ROLES;
