/**
 * Industry-template reader.
 *
 * Templates are global config rows in `industry_templates` (no RLS,
 * GRANT SELECT to the app role). Tenants pick one at signup or via
 * "Reset taxonomy" in settings; we clone the template's categories
 * into the tenant's own `opportunity_categories` rows.
 *
 * This service reads through `TenantDb` for consistency with every
 * other tenant-facing read — the table has no RLS so the tenant
 * context isn't required, but channelling through TenantDb keeps the
 * "no bare prisma" lint contract intact.
 *
 * The clone-on-signup path lives in `UnscopedDb.createTenantWithAdmin`
 * — it runs as the migration superuser before any tenant exists.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import type { IndustryTemplateRow } from '@rhud/shared';

@Injectable()
export class TemplatesService {
  constructor(private readonly tenantDb: TenantDb) {}

  /** All available industry templates, ordered for the picker UI. */
  async list(tenantId: string): Promise<IndustryTemplateRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.industryTemplate.findMany({
        orderBy: { slug: 'asc' },
      });
      return rows.map((r) => ({
        slug: r.slug,
        name: r.name,
        classifierPreamble: r.classifierPreamble,
        fallbackSlug: r.fallbackSlug,
        version: r.version,
      }));
    });
  }

  /** Single template by slug. 404s if missing — callers (notably
   *  `tenant/industry/reset`) use this to validate before mutating. */
  async getBySlug(tenantId: string, slug: string): Promise<IndustryTemplateRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const r = await db.industryTemplate.findUnique({ where: { slug } });
      if (!r) throw new NotFoundException('unknown_industry_template');
      return {
        slug: r.slug,
        name: r.name,
        classifierPreamble: r.classifierPreamble,
        fallbackSlug: r.fallbackSlug,
        version: r.version,
      };
    });
  }
}
