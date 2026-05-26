/**
 * Categories taxonomy — read + tenant-side mutation.
 *
 * Today every tenant owns its own taxonomy as `tenant_id = self` rows in
 * `opportunity_categories`. (Legacy `tenant_id IS NULL` system rows
 * still exist in the table for one release; the read filter excludes
 * them so they're invisible. Phase 4 drops them entirely.)
 *
 * Admin-only mutations:
 *   - create / update / archive / bulkReorder — direct CRUD on the
 *     tenant's taxonomy.
 *   - resetFromTemplate — wipe and re-clone from a different
 *     industry template (also updates `tenants.industry_template_slug`).
 *
 * On archive we hard-delete matching routing rules in the same
 * transaction (decision 1 of the locked plan — rules are config, not
 * records). Archived categories stay readable so historical
 * `engagement.category_slug` strings still render their display name.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import type {
  BulkReorderInput,
  CategoryTree,
  CreateCategoryInput,
  OpportunityCategoryRow,
  UpdateCategoryInput,
} from '@rhud/shared';

const SLUG_RE = /^[a-z][a-z0-9_]*$/;
const MAX_NAME_LEN = 120;

@Injectable()
export class CategoriesService {
  constructor(private readonly tenantDb: TenantDb) {}

  // ── Reads ─────────────────────────────────────────────────────────

  /** Return the tenant's active (non-archived) taxonomy as a tree. */
  async getTree(tenantId: string): Promise<CategoryTree> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.opportunityCategory.findMany({
        where: { tenantId, archivedAt: null },
        orderBy: [{ parentSlug: 'asc' }, { position: 'asc' }],
      });
      const all: OpportunityCategoryRow[] = rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        slug: r.slug,
        name: r.name,
        parentSlug: r.parentSlug,
        position: r.position,
      }));
      const topLevel = all
        .filter((c) => c.parentSlug == null)
        .sort((a, b) => a.position - b.position);
      const childrenByParent: Record<string, OpportunityCategoryRow[]> = {};
      for (const c of all) {
        if (!c.parentSlug) continue;
        const arr = childrenByParent[c.parentSlug] ?? (childrenByParent[c.parentSlug] = []);
        arr.push(c);
      }
      for (const k of Object.keys(childrenByParent)) {
        childrenByParent[k]!.sort((a, b) => a.position - b.position);
      }
      return { topLevel, childrenByParent };
    });
  }

  /** Flat active list — used by the LLM classifier prompt builder. */
  async list(tenantId: string): Promise<OpportunityCategoryRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.opportunityCategory.findMany({
        where: { tenantId, archivedAt: null },
        orderBy: [{ parentSlug: 'asc' }, { position: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        tenantId: r.tenantId,
        slug: r.slug,
        name: r.name,
        parentSlug: r.parentSlug,
        position: r.position,
      }));
    });
  }

  /** True when `slug` is an active category in the tenant's taxonomy. */
  async exists(tenantId: string, slug: string): Promise<boolean> {
    return this.tenantDb.run(tenantId, async (db) => {
      const count = await db.opportunityCategory.count({
        where: { tenantId, slug, archivedAt: null },
      });
      return count > 0;
    });
  }

  // ── Mutations ─────────────────────────────────────────────────────

  async create(tenantId: string, input: CreateCategoryInput): Promise<OpportunityCategoryRow> {
    if (!SLUG_RE.test(input.slug)) throw new BadRequestException('invalid_slug_format');
    const name = (input.name ?? '').trim();
    if (name.length === 0 || name.length > MAX_NAME_LEN) {
      throw new BadRequestException('invalid_name');
    }
    if (input.parentSlug && input.parentSlug === input.slug) {
      throw new BadRequestException('cannot_parent_to_self');
    }

    return this.tenantDb.run(tenantId, async (db) => {
      // Parent (when given) must exist and itself be top-level — the
      // taxonomy is two-level by design.
      if (input.parentSlug) {
        const parent = await db.opportunityCategory.findFirst({
          where: {
            tenantId,
            slug: input.parentSlug,
            archivedAt: null,
            parentSlug: null,
          },
        });
        if (!parent) throw new BadRequestException('parent_not_found_or_not_top_level');
      }

      // Slug conflict with an active row in this tenant.
      const conflict = await db.opportunityCategory.findFirst({
        where: { tenantId, slug: input.slug, archivedAt: null },
      });
      if (conflict) throw new ConflictException('slug_already_exists');

      const row = await db.opportunityCategory.create({
        data: {
          tenantId,
          slug: input.slug,
          name,
          parentSlug: input.parentSlug ?? null,
          position: input.position ?? 0,
        },
      });
      return {
        id: row.id,
        tenantId: row.tenantId,
        slug: row.slug,
        name: row.name,
        parentSlug: row.parentSlug,
        position: row.position,
      };
    });
  }

  async update(
    tenantId: string,
    slug: string,
    input: UpdateCategoryInput,
  ): Promise<OpportunityCategoryRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.opportunityCategory.findFirst({
        where: { tenantId, slug, archivedAt: null },
      });
      if (!existing) throw new NotFoundException('category_not_found');

      const data: {
        name?: string;
        parentSlug?: string | null;
        position?: number;
      } = {};

      if (input.name !== undefined) {
        const trimmed = input.name.trim();
        if (trimmed.length === 0 || trimmed.length > MAX_NAME_LEN) {
          throw new BadRequestException('invalid_name');
        }
        data.name = trimmed;
      }

      if (input.parentSlug !== undefined) {
        if (input.parentSlug !== null) {
          if (input.parentSlug === slug) {
            throw new BadRequestException('cannot_parent_to_self');
          }
          const parent = await db.opportunityCategory.findFirst({
            where: {
              tenantId,
              slug: input.parentSlug,
              archivedAt: null,
              parentSlug: null,
            },
          });
          if (!parent) throw new BadRequestException('parent_not_found_or_not_top_level');
        }
        // Don't allow re-parenting a row that has children itself —
        // would create a 3-level tree we don't support.
        const childCount = await db.opportunityCategory.count({
          where: { tenantId, parentSlug: slug, archivedAt: null },
        });
        if (childCount > 0 && input.parentSlug !== null) {
          throw new BadRequestException('cannot_demote_category_with_children');
        }
        data.parentSlug = input.parentSlug;
      }

      if (input.position !== undefined) {
        data.position = input.position;
      }

      if (Object.keys(data).length === 0) {
        throw new BadRequestException('no_fields_to_update');
      }

      const updated = await db.opportunityCategory.update({
        where: { id: existing.id },
        data,
      });
      return {
        id: updated.id,
        tenantId: updated.tenantId,
        slug: updated.slug,
        name: updated.name,
        parentSlug: updated.parentSlug,
        position: updated.position,
      };
    });
  }

  /**
   * Soft-archive a category. If it's a top-level row, cascade-archive
   * all its (active) children too. Hard-delete every routing rule that
   * pointed at any of the archived slugs (decision 1 of the locked
   * plan — rules are config, not audit records).
   */
  async archive(tenantId: string, slug: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.opportunityCategory.findFirst({
        where: { tenantId, slug, archivedAt: null },
      });
      if (!existing) throw new NotFoundException('category_not_found');

      const childSlugs = existing.parentSlug === null
        ? (await db.opportunityCategory.findMany({
            where: { tenantId, parentSlug: slug, archivedAt: null },
            select: { slug: true },
          })).map((c) => c.slug)
        : [];

      const now = new Date();
      await db.opportunityCategory.updateMany({
        where: { tenantId, slug, archivedAt: null },
        data: { archivedAt: now },
      });
      if (childSlugs.length > 0) {
        await db.opportunityCategory.updateMany({
          where: { tenantId, slug: { in: childSlugs }, archivedAt: null },
          data: { archivedAt: now },
        });
      }

      await db.opportunityRoutingRule.deleteMany({
        where: { tenantId, categorySlug: { in: [slug, ...childSlugs] } },
      });
    });
  }

  /**
   * Apply a batch of (slug, position, parentSlug?) changes — for the
   * drag-to-reorder UX. Each item updates one row; we don't validate
   * cross-item consistency (the UI is the source of truth on order).
   */
  async bulkReorder(tenantId: string, input: BulkReorderInput): Promise<void> {
    if (input.items.length === 0) return;
    await this.tenantDb.run(tenantId, async (db) => {
      for (const item of input.items) {
        const data: { position: number; parentSlug?: string | null } = {
          position: item.position,
        };
        if (item.parentSlug !== undefined) {
          data.parentSlug = item.parentSlug;
        }
        await db.opportunityCategory.updateMany({
          where: { tenantId, slug: item.slug, archivedAt: null },
          data,
        });
      }
    });
  }

  /**
   * Wipe-and-clone: soft-archive all current categories, hard-delete
   * all routing rules, point the tenant at `templateSlug`, and clone
   * the new template's categories. Wrapped in a single transaction so
   * a mid-flight failure leaves the taxonomy untouched.
   *
   * Pre-condition: `templateSlug` must exist in `industry_templates`
   * (the controller validates via TemplatesService before calling).
   */
  async resetFromTemplate(tenantId: string, templateSlug: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      // Defensive verify template exists (also runs inside the tx).
      const tpl = await db.industryTemplate.findUnique({ where: { slug: templateSlug } });
      if (!tpl) throw new NotFoundException('unknown_industry_template');

      const now = new Date();
      await db.opportunityCategory.updateMany({
        where: { tenantId, archivedAt: null },
        data: { archivedAt: now },
      });
      await db.opportunityRoutingRule.deleteMany({ where: { tenantId } });

      await db.tenant.update({
        where: { id: tenantId },
        data: { industryTemplateSlug: templateSlug },
      });

      // Clone via raw SQL — Prisma doesn't natively express INSERT
      // ... SELECT from one model into another. The partial unique
      // index `opportunity_categories_tenant_slug_uniq` is now
      // archived_at-aware, so re-introducing a slug we just archived
      // doesn't violate uniqueness.
      await db.$executeRaw`
        INSERT INTO opportunity_categories (tenant_id, slug, name, parent_slug, position)
        SELECT ${tenantId}::uuid, c.slug, c.name, c.parent_slug, c.position
          FROM industry_template_categories c
         WHERE c.template_slug = ${templateSlug}
      `;
    });
  }
}
