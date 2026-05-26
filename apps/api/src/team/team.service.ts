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
import { EmailService } from '../email/email.service.js';
import type { JwtPayload } from '../auth/auth.types.js';

// 7 days — long enough that reasonable people get to it, short enough
// that a forgotten invite doesn't hang around forever.
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Human-readable role names shown in the invite email body so the
// recipient knows what they're being granted before they accept. Roles
// not listed fall back to the raw slug — fine for newer/internal roles
// where the slug is already readable enough.
const ROLE_LABEL: Partial<Record<Role, string>> = {
  admin: 'admin',
  sales_manager: 'sales manager',
  sales_employee: 'sales rep',
};

function roleLabelFor(role: Role): string {
  return ROLE_LABEL[role] ?? role;
}

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

/** Public tenant config object returned by GET /tenant/me + PATCH /tenant/me. */
export interface TenantConfigDto {
  id: string;
  name: string;
  plan: string;
  leadSummaryAutoGenerate: boolean;
  /** Phase C — multi-level approval thresholds in cents.
   *  null = that escalation tier disabled. */
  requiresVpApprovalAboveCents: number | null;
  requiresCeoApprovalAboveCents: number | null;
  /** Which industry-template the tenant cloned at signup. Surfaced
   *  to the UI so the setup-panel nudge can detect a tenant that's
   *  still on the default 'cybersecurity' template. */
  industryTemplateSlug: string;
}

@Injectable()
export class TeamService {
  private readonly logger = new Logger(TeamService.name);
  private readonly portalBase = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly unscoped: UnscopedDb,
    private readonly jwt: JwtService,
    private readonly email: EmailService,
  ) {}

  // ── Tenant identity ─────────────────────────────────────────────────────

  async getTenant(tenantId: string): Promise<TenantConfigDto> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true, name: true, plan: true,
          leadSummaryAutoGenerate: true,
          requiresVpApprovalAboveCents: true,
          requiresCeoApprovalAboveCents: true,
          industryTemplateSlug: true,
        },
      });
      if (!row) throw new NotFoundException('tenant_not_found');
      return {
        id: row.id,
        name: row.name,
        plan: row.plan,
        leadSummaryAutoGenerate: row.leadSummaryAutoGenerate,
        requiresVpApprovalAboveCents: row.requiresVpApprovalAboveCents == null
          ? null : Number(row.requiresVpApprovalAboveCents),
        requiresCeoApprovalAboveCents: row.requiresCeoApprovalAboveCents == null
          ? null : Number(row.requiresCeoApprovalAboveCents),
        industryTemplateSlug: row.industryTemplateSlug,
      };
    });
  }

  async updateTenant(
    tenantId: string,
    actor: JwtPayload,
    args: {
      name?: string;
      leadSummaryAutoGenerate?: boolean;
      requiresVpApprovalAboveCents?: number | null;
      requiresCeoApprovalAboveCents?: number | null;
    },
  ): Promise<TenantConfigDto> {
    const data: {
      name?: string;
      leadSummaryAutoGenerate?: boolean;
      requiresVpApprovalAboveCents?: bigint | null;
      requiresCeoApprovalAboveCents?: bigint | null;
    } = {};
    if (args.name !== undefined) {
      const trimmed = args.name.trim();
      if (trimmed.length === 0) throw new BadRequestException('name_required');
      if (trimmed.length > 120) throw new BadRequestException('name_too_long');
      data.name = trimmed;
    }
    if (args.leadSummaryAutoGenerate !== undefined) {
      data.leadSummaryAutoGenerate = !!args.leadSummaryAutoGenerate;
    }
    if (args.requiresVpApprovalAboveCents !== undefined) {
      const v = args.requiresVpApprovalAboveCents;
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        throw new BadRequestException('vp_threshold_invalid');
      }
      data.requiresVpApprovalAboveCents = v == null ? null : BigInt(Math.round(v));
    }
    if (args.requiresCeoApprovalAboveCents !== undefined) {
      const v = args.requiresCeoApprovalAboveCents;
      if (v !== null && (!Number.isFinite(v) || v < 0)) {
        throw new BadRequestException('ceo_threshold_invalid');
      }
      data.requiresCeoApprovalAboveCents = v == null ? null : BigInt(Math.round(v));
    }
    // Sanity: CEO threshold must be >= VP threshold if both are set.
    if (
      data.requiresVpApprovalAboveCents != null
      && data.requiresCeoApprovalAboveCents != null
      && data.requiresCeoApprovalAboveCents < data.requiresVpApprovalAboveCents
    ) {
      throw new BadRequestException('ceo_threshold_must_be_above_vp');
    }
    if (Object.keys(data).length === 0) throw new BadRequestException('no_fields_to_update');

    return this.tenantDb.run(tenantId, async (db) => {
      const updated = await db.tenant.update({
        where: { id: tenantId },
        data,
        select: {
          id: true, name: true, plan: true,
          leadSummaryAutoGenerate: true,
          requiresVpApprovalAboveCents: true,
          requiresCeoApprovalAboveCents: true,
          industryTemplateSlug: true,
        },
      });
      this.logger.log(`tenant ${tenantId} updated by ${actor.sub}`);
      return {
        id: updated.id,
        name: updated.name,
        plan: updated.plan,
        leadSummaryAutoGenerate: updated.leadSummaryAutoGenerate,
        requiresVpApprovalAboveCents: updated.requiresVpApprovalAboveCents == null
          ? null : Number(updated.requiresVpApprovalAboveCents),
        requiresCeoApprovalAboveCents: updated.requiresCeoApprovalAboveCents == null
          ? null : Number(updated.requiresCeoApprovalAboveCents),
        industryTemplateSlug: updated.industryTemplateSlug,
      };
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

    const { created, tenantName } = await this.tenantDb.run(tenantId, async (db) => {
      // Refuse if there's already an open invite for this email in this
      // tenant — the partial unique index enforces it but throw a clean
      // error first.
      const open = await db.invite.findFirst({
        where: { email: args.email, acceptedAt: null, revokedAt: null },
      });
      if (open) throw new ConflictException('invite_already_pending');

      const row = await db.invite.create({
        data: {
          tenantId,
          email: args.email,
          role: args.role,
          tokenHash,
          invitedById: actor.sub,
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
      });
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      return { created: row, tenantName: tenant?.name ?? 'workspace' };
    });

    const acceptUrl = `${this.portalBase.replace(/\/$/, '')}/accept-invite?token=${token}`;
    await this.email.sendInvite({
      to: args.email,
      inviteUrl: acceptUrl,
      inviterName: actor.email,
      tenantName,
      roleLabel: roleLabelFor(args.role),
    });

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

    const { invite, tenantName } = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.invite.findUnique({ where: { id: inviteId } });
      if (!row) throw new NotFoundException('invite_not_found');
      if (row.acceptedAt) throw new BadRequestException('invite_already_accepted');
      if (row.revokedAt) throw new BadRequestException('invite_revoked');

      const updated = await db.invite.update({
        where: { id: inviteId },
        data: { tokenHash, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
      });
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      return { invite: updated, tenantName: tenant?.name ?? 'workspace' };
    });

    const acceptUrl = `${this.portalBase.replace(/\/$/, '')}/accept-invite?token=${token}`;
    await this.email.sendInvite({
      to: invite.email,
      inviteUrl: acceptUrl,
      inviterName: actor.email,
      tenantName,
      ...(isRole(invite.role) ? { roleLabel: roleLabelFor(invite.role) } : {}),
    });

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
