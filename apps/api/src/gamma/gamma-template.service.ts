/**
 * Gamma proposal-template LIBRARY (multi-template v2) — per-tenant CRUD over
 * reusable Gamma decks. An opportunity selects one of these (see
 * Engagement.selectedGammaTemplateId); the proposal pipeline resolves the
 * chosen entry and clones its Gamma File ID via the from-template endpoint.
 *
 * All access is tenant-scoped through TenantDb (RLS). Connection testing is
 * delegated to GammaService (which owns the encrypted per-tenant API key) —
 * we validate connectivity only, never spend credits on a real generation.
 *
 * See docs/gamma-multi-template-design.md.
 */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  isGammaFieldKey,
  isGammaTemplateFormat,
  isGammaTemplateStatus,
  type CreateGammaTemplate,
  type GammaManifestField,
  type GammaTemplate,
  type GammaTemplateManifest,
  type GammaTemplateTestResult,
  type UpdateGammaTemplate,
} from '@rhud/shared';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { GammaService } from './gamma.service.js';

/** The persisted row shape we map from — declared structurally so this file
 *  never imports @prisma/client (lint boundary). */
interface GammaTemplateRow {
  id: string;
  tenantId: string;
  label: string;
  gammaTemplateId: string;
  format: string;
  serviceLine: string | null;
  isDefault: boolean;
  manifest: unknown;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class GammaTemplateService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly gamma: GammaService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** Active library entries for the settings list + the proposal picker.
   *  Default first, then newest-stable order. */
  async list(tenantId: string): Promise<GammaTemplate[]> {
    const rows = await this.tenantDb.run(tenantId, (db) =>
      db.gammaTemplate.findMany({
        where: { tenantId, status: 'active' },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      }),
    );
    return rows.map((r) => this.toPublic(r));
  }

  /** Any-status lookup, null when missing. The resolver uses this and checks
   *  `status === 'active'` itself so a soft-archived selection falls through
   *  to the default rather than 404-ing. Cross-tenant ids return null (RLS). */
  async findById(tenantId: string, id: string): Promise<GammaTemplate | null> {
    const row = await this.tenantDb.run(tenantId, (db) =>
      db.gammaTemplate.findUnique({ where: { id } }),
    );
    return row ? this.toPublic(row) : null;
  }

  /** The tenant's active default entry, or null. Ordered for determinism even
   *  under a transient double-default. */
  async getDefault(tenantId: string): Promise<GammaTemplate | null> {
    const row = await this.tenantDb.run(tenantId, (db) =>
      db.gammaTemplate.findFirst({
        where: { tenantId, status: 'active', isDefault: true },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return row ? this.toPublic(row) : null;
  }

  /** Any-status fetch that throws NotFound — for the controller's edit/test
   *  paths where the caller named a specific entry. */
  async get(tenantId: string, id: string): Promise<GammaTemplate> {
    const found = await this.findById(tenantId, id);
    if (!found) throw new NotFoundException('gamma_template_not_found');
    return found;
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  async create(tenantId: string, dto: CreateGammaTemplate): Promise<GammaTemplate> {
    const label = requireNonEmpty(dto.label, 'label');
    const gammaTemplateId = requireNonEmpty(dto.gammaTemplateId, 'gammaTemplateId');
    if (dto.format !== undefined && !isGammaTemplateFormat(dto.format)) {
      throw new BadRequestException('invalid_format');
    }
    const manifest = this.parseManifest(dto.manifest, true);
    const serviceLine = normalizeServiceLine(dto.serviceLine);
    const isDefault = dto.isDefault ?? false;

    const row = await this.tenantDb.run(tenantId, async (db) => {
      if (isDefault) await this.clearDefaults(db, tenantId);
      return db.gammaTemplate.create({
        data: {
          tenantId,
          label,
          gammaTemplateId,
          format: dto.format ?? 'presentation',
          serviceLine,
          isDefault,
          manifest: manifest as object,
        },
      });
    });
    return this.toPublic(row);
  }

  async update(tenantId: string, id: string, dto: UpdateGammaTemplate): Promise<GammaTemplate> {
    if (dto.format !== undefined && !isGammaTemplateFormat(dto.format)) {
      throw new BadRequestException('invalid_format');
    }
    // Validate manifest up-front (outside the tx) so a bad body fails fast.
    const manifest = dto.manifest !== undefined ? this.parseManifest(dto.manifest, true) : undefined;

    const data: {
      label?: string;
      gammaTemplateId?: string;
      format?: string;
      serviceLine?: string | null;
      isDefault?: boolean;
      manifest?: object;
    } = {
      ...(dto.label !== undefined && { label: requireNonEmpty(dto.label, 'label') }),
      ...(dto.gammaTemplateId !== undefined && {
        gammaTemplateId: requireNonEmpty(dto.gammaTemplateId, 'gammaTemplateId'),
      }),
      ...(dto.format !== undefined && { format: dto.format }),
      ...(dto.serviceLine !== undefined && { serviceLine: normalizeServiceLine(dto.serviceLine) }),
      ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
      ...(manifest !== undefined && { manifest: manifest as object }),
    };

    const row = await this.tenantDb.run(tenantId, async (db) => {
      await assertExists(db, tenantId, id);
      if (dto.isDefault === true) await this.clearDefaults(db, tenantId, id);
      return db.gammaTemplate.update({ where: { id }, data });
    });
    return this.toPublic(row);
  }

  /** Soft archive — drops out of the active list + picker, clears default. */
  async archive(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await assertExists(db, tenantId, id);
      await db.gammaTemplate.update({
        where: { id },
        data: { status: 'archived', isDefault: false },
      });
    });
  }

  /** Connectivity check for the configured Gamma API key. Validates the entry
   *  exists, then pings Gamma — never spends credits, never throws. */
  async testConnection(tenantId: string, id: string): Promise<GammaTemplateTestResult> {
    await this.get(tenantId, id);
    return this.gamma.testCurrentConfig(tenantId);
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Clear the tenant's existing default(s) in-transaction before electing a
   *  new one — the partial unique index allows only one is_default per tenant. */
  private async clearDefaults(db: PrismaTx, tenantId: string, exceptId?: string): Promise<void> {
    await db.gammaTemplate.updateMany({
      where: { tenantId, isDefault: true, ...(exceptId && { id: { not: exceptId } }) },
      data: { isDefault: false },
    });
  }

  private toPublic(row: GammaTemplateRow): GammaTemplate {
    return {
      id: row.id,
      tenantId: row.tenantId,
      label: row.label,
      gammaTemplateId: row.gammaTemplateId,
      format: isGammaTemplateFormat(row.format) ? row.format : 'presentation',
      serviceLine: row.serviceLine ?? null,
      isDefault: row.isDefault,
      manifest: this.parseManifest(row.manifest, false),
      status: isGammaTemplateStatus(row.status) ? row.status : 'active',
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Validate/normalize a manifest. `strict` (writes) throws on malformed input;
   * loose (reads) coerces and drops anything invalid so a bad stored row can't
   * break a list. Either way the result always has both arrays.
   */
  private parseManifest(raw: unknown, strict: boolean): GammaTemplateManifest {
    // Bounds so a manifest can't grow the JSONB column unboundedly. Strict
    // (writes) rejects over-limit input; loose (reads) truncates defensively.
    const MAX_ENTRIES = 64;
    const MAX_STR = 200;
    if (raw == null) return { fields: [], lockedSections: [] };
    if (typeof raw !== 'object') {
      if (strict) throw new BadRequestException('invalid_manifest');
      return { fields: [], lockedSections: [] };
    }
    const obj = raw as Record<string, unknown>;

    const fields: GammaManifestField[] = [];
    if (obj.fields !== undefined) {
      if (!Array.isArray(obj.fields)) {
        if (strict) throw new BadRequestException('invalid_manifest_fields');
      } else {
        if (strict && obj.fields.length > MAX_ENTRIES) {
          throw new BadRequestException('manifest_too_large');
        }
        for (const f of obj.fields.slice(0, MAX_ENTRIES)) {
          const fo = (f ?? {}) as Record<string, unknown>;
          if (typeof fo.token !== 'string' || !isGammaFieldKey(fo.fieldKey) || typeof fo.label !== 'string') {
            if (strict) throw new BadRequestException('invalid_manifest_field');
            continue;
          }
          if (strict && (fo.token.length > MAX_STR || fo.label.length > MAX_STR)) {
            throw new BadRequestException('manifest_field_too_long');
          }
          fields.push({
            token: fo.token.slice(0, MAX_STR),
            fieldKey: fo.fieldKey,
            label: fo.label.slice(0, MAX_STR),
            defaultInclude: fo.defaultInclude !== false,
          });
        }
      }
    }

    let lockedSections: string[] = [];
    if (obj.lockedSections !== undefined) {
      if (!Array.isArray(obj.lockedSections) || obj.lockedSections.some((s) => typeof s !== 'string')) {
        if (strict) throw new BadRequestException('invalid_manifest_locked_sections');
      } else {
        const arr = obj.lockedSections as string[];
        if (strict && arr.length > MAX_ENTRIES) {
          throw new BadRequestException('manifest_too_large');
        }
        if (strict && arr.some((s) => s.length > MAX_STR)) {
          throw new BadRequestException('manifest_section_too_long');
        }
        lockedSections = arr.slice(0, MAX_ENTRIES).map((s) => s.slice(0, MAX_STR));
      }
    }

    return { fields, lockedSections };
  }
}

// ── module-free helpers ────────────────────────────────────────────────────

function requireNonEmpty(value: string, field: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) throw new BadRequestException(`${field}_required`);
  return trimmed;
}

function normalizeServiceLine(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

async function assertExists(db: PrismaTx, tenantId: string, id: string): Promise<void> {
  const row = await db.gammaTemplate.findFirst({ where: { id, tenantId }, select: { id: true } });
  if (!row) throw new NotFoundException('gamma_template_not_found');
}
