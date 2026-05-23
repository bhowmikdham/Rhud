/**
 * Phase E — admin CRUD for partner tokens.
 *
 * Mirrors `TeamService` invite handling 1:1: 256-bit base64url plaintext,
 * argon2id hash stored. The plaintext is returned to the caller exactly
 * once (the response from `create()` / `rotate()`); thereafter the row
 * shows only the metadata.
 *
 * Tenant isolation: every method runs inside `TenantDb.run()`, so RLS
 * stops a tenant from seeing or mutating another tenant's tokens even
 * if a controller is misconfigured.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { TenantDb } from '../db/with-tenant.js';
import type { JwtPayload } from '../auth/auth.types.js';

/** Public view of a partner token row — never includes the hash. */
export interface PartnerTokenSummary {
  id: string;
  name: string;
  status: 'active' | 'revoked' | 'expired';
  defaultTemplateId: string | null;
  defaultSalesOwnerId: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

interface PartnerTokenRow {
  id: string;
  name: string;
  defaultTemplateId: string | null;
  defaultSalesOwnerId: string | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class PartnerTokensService {
  private readonly logger = new Logger(PartnerTokensService.name);

  constructor(private readonly tenantDb: TenantDb) {}

  async list(tenantId: string): Promise<PartnerTokenSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.partnerToken.findMany({
        orderBy: [{ createdAt: 'desc' }],
        select: {
          id: true, name: true,
          defaultTemplateId: true, defaultSalesOwnerId: true,
          expiresAt: true, revokedAt: true,
          lastUsedAt: true, createdAt: true,
        },
      });
      return rows.map((r) => this.toSummary(r));
    });
  }

  /** Mint a new partner token. Returns plaintext once. */
  async create(
    tenantId: string,
    actor: JwtPayload,
    args: {
      name: string;
      expiresInDays?: number | null;
      defaultTemplateId?: string | null;
      defaultSalesOwnerId?: string | null;
    },
  ): Promise<{ partner: PartnerTokenSummary; token: string }> {
    const name = args.name.trim();
    if (name.length === 0) throw new BadRequestException('name_required');
    if (name.length > 120) throw new BadRequestException('name_too_long');

    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });

    const expiresAt = args.expiresInDays && args.expiresInDays > 0
      ? new Date(Date.now() + args.expiresInDays * 86_400_000)
      : null;

    const created = await this.tenantDb.run(tenantId, async (db) => {
      // Partial unique index allows revoked-then-re-issued; explicit
      // check throws a clean 409 instead of a Prisma error.
      const open = await db.partnerToken.findFirst({
        where: { name, revokedAt: null },
      });
      if (open) throw new ConflictException('partner_token_name_taken');

      return db.partnerToken.create({
        data: {
          tenantId,
          name,
          tokenHash,
          createdByUserId: actor.sub,
          ...(args.defaultTemplateId    ? { defaultTemplateId:    args.defaultTemplateId }    : {}),
          ...(args.defaultSalesOwnerId  ? { defaultSalesOwnerId:  args.defaultSalesOwnerId }  : {}),
          ...(expiresAt ? { expiresAt } : {}),
        },
      });
    });

    this.logger.log(`partner_token created tenant=${tenantId} id=${created.id} actor=${actor.sub}`);
    return { partner: this.toSummary(created), token };
  }

  /** Rotate the plaintext — keeps the row id but mints a new token. */
  async rotate(
    tenantId: string,
    id: string,
    actor: JwtPayload,
  ): Promise<{ partner: PartnerTokenSummary; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const tokenHash = await argon2.hash(token, { type: argon2.argon2id });

    const updated = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.partnerToken.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('partner_token_not_found');
      if (row.revokedAt) throw new BadRequestException('partner_token_revoked');
      return db.partnerToken.update({
        where: { id },
        data: { tokenHash, updatedAt: new Date() },
      });
    });

    this.logger.log(`partner_token rotated tenant=${tenantId} id=${id} actor=${actor.sub}`);
    return { partner: this.toSummary(updated), token };
  }

  /** Soft-revoke: sets revoked_at. Idempotent. */
  async revoke(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.partnerToken.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('partner_token_not_found');
      if (row.revokedAt) return; // idempotent
      await db.partnerToken.update({
        where: { id },
        data: { revokedAt: new Date(), updatedAt: new Date() },
      });
    });
  }

  // ── helpers ────────────────────────────────────────────────────────

  private toSummary(row: PartnerTokenRow): PartnerTokenSummary {
    return {
      id: row.id,
      name: row.name,
      status: this.deriveStatus(row),
      defaultTemplateId: row.defaultTemplateId,
      defaultSalesOwnerId: row.defaultSalesOwnerId,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private deriveStatus(row: PartnerTokenRow): PartnerTokenSummary['status'] {
    if (row.revokedAt) return 'revoked';
    if (row.expiresAt && row.expiresAt < new Date()) return 'expired';
    return 'active';
  }
}
