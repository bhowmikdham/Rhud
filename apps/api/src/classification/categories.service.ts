/**
 * Categories taxonomy reader.
 *
 * The PM-defined taxonomy lives as system rows (`tenant_id IS NULL`)
 * seeded by the migration. Tenants can add their own custom rows.
 * RLS lets every tenant read system rows; only the tenant can write
 * its own rows.
 *
 * This service is a thin read-only wrapper. We return the merged
 * (system + tenant) list as a CategoryTree so the UI doesn't have to
 * group children under parents.
 */

import { Injectable } from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import type { CategoryTree, OpportunityCategoryRow } from '@rhud/shared';

@Injectable()
export class CategoriesService {
  constructor(private readonly tenantDb: TenantDb) {}

  /** Return everything the tenant can see (system + tenant rows),
   *  grouped into top-level + children-by-parent. */
  async getTree(tenantId: string): Promise<CategoryTree> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.opportunityCategory.findMany({
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

  /** Flat list — used by the LLM classifier prompt builder so it can
   *  enumerate valid slugs without doing the grouping itself. */
  async list(tenantId: string): Promise<OpportunityCategoryRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.opportunityCategory.findMany({
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

  /** True when `slug` exists in the tenant's visible taxonomy. */
  async exists(tenantId: string, slug: string): Promise<boolean> {
    return this.tenantDb.run(tenantId, async (db) => {
      const count = await db.opportunityCategory.count({ where: { slug } });
      return count > 0;
    });
  }
}
