/**
 * One-shot backfill — retire the deprecated questionnaire→Gamma binding.
 *
 * Seeds the new per-tenant Gamma template LIBRARY from the legacy
 * `templates.gamma_template_id` values, elects a tenant default, and sets the
 * per-opportunity selection (`engagements.selected_gamma_template_id`) for
 * everything still in play — so in-flight proposals keep their expected deck
 * once the old binding is removed from the runtime path.
 *
 * Idempotent (re-runnable): step 1 dedupes via the (tenant_id, gamma_template_id)
 * unique index + ON CONFLICT DO NOTHING; step 2 only elects a default when the
 * tenant has none; step 3 only fills selections that are still NULL.
 *
 * Lives OUTSIDE src/ on purpose: it talks to the BYPASSRLS superuser directly
 * (cross-tenant), and a standalone PrismaClient avoids the Nest-DI-under-tsx
 * decorator-metadata problem. Run once, post-deploy:
 *
 *   pnpm --filter @rhud/api exec -- dotenv -e ../../.env -- \
 *     tsx scripts/backfill-gamma-templates.ts
 *
 * DATABASE_URL must point at the migration/superuser role (BYPASSRLS) so the
 * cross-tenant statements aren't filtered by RLS.
 */
import { PrismaClient } from '@prisma/client';

// Opportunities already delivered or closed are left untouched (the
// NOT IN (...) list in step 3) — rewriting the template selection on a
// sent/won/lost proposal is pointless and misleading. Everything else
// (pre-send, any approval stage) is "in play" and gets linked.

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // 1. Seed one library entry per (tenant, Gamma File ID). Label from the
    //    oldest questionnaire template that referenced it.
    const seeded = await prisma.$executeRaw`
      INSERT INTO gamma_templates
        (tenant_id, label, gamma_template_id, format, is_default, manifest, status)
      SELECT DISTINCT ON (t.tenant_id, t.gamma_template_id)
             t.tenant_id,
             COALESCE(NULLIF(t.name, ''), 'Imported template'),
             t.gamma_template_id,
             'presentation',
             false,
             '{}'::jsonb,
             'active'
      FROM templates t
      WHERE t.gamma_template_id IS NOT NULL AND t.gamma_template_id <> ''
      ORDER BY t.tenant_id, t.gamma_template_id, t.created_at ASC
      ON CONFLICT (tenant_id, gamma_template_id) DO NOTHING`;
    console.log(`[1/3] seeded library entries (new rows): ${seeded}`);

    // 2. Elect a default per tenant = most-referenced legacy binding
    //    (tie-break: oldest). Only when the tenant has no default yet, so a
    //    re-run never flips an admin's chosen default.
    await prisma.$executeRaw`
      WITH ranked AS (
        SELECT t.tenant_id,
               t.gamma_template_id,
               COUNT(*)        AS refs,
               MIN(t.created_at) AS first_seen
        FROM templates t
        WHERE t.gamma_template_id IS NOT NULL AND t.gamma_template_id <> ''
        GROUP BY t.tenant_id, t.gamma_template_id
      ),
      winner AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, gamma_template_id
        FROM ranked
        ORDER BY tenant_id, refs DESC, first_seen ASC
      )
      UPDATE gamma_templates g
      SET is_default = true
      FROM winner w
      WHERE g.tenant_id = w.tenant_id
        AND g.gamma_template_id = w.gamma_template_id
        AND NOT EXISTS (
          SELECT 1 FROM gamma_templates d
          WHERE d.tenant_id = g.tenant_id AND d.is_default = true
        )`;
    console.log('[2/3] elected tenant defaults (where none existed)');

    // 3. Link in-play opportunities to their library entry (old File ID → new
    //    library UUID). Skips already-set selections and delivered/terminal
    //    opportunities.
    const linked = await prisma.$executeRaw`
      UPDATE engagements e
      SET selected_gamma_template_id = g.id
      FROM templates t
      JOIN gamma_templates g
        ON g.tenant_id = t.tenant_id
       AND g.gamma_template_id = t.gamma_template_id
      WHERE e.template_id = t.id
        AND e.selected_gamma_template_id IS NULL
        AND t.gamma_template_id IS NOT NULL AND t.gamma_template_id <> ''
        AND e.status NOT IN (
          'sent','closed','won','lost','rejected','expired','cancelled','canceled','archived'
        )`;
    console.log(`[3/3] linked in-play opportunities: ${linked}`);

    console.log('backfill complete.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exitCode = 1;
});
