-- tenant-isolation-2: enforce FORCE ROW LEVEL SECURITY on every RLS-enabled
-- tenant table.
--
-- Postgres exempts a table's OWNER from its RLS policies unless FORCE is set.
-- Migrations run as the superuser/owner `rhud`; only 8 of ~40 tenant tables
-- previously had FORCE, leaving the bulk of engagement/quote/thread/odoo data
-- without the owner-side backstop the most sensitive config tables already had.
--
-- Note: a superuser (`rhud`) still bypasses RLS entirely even with FORCE, so the
-- unscoped/auth paths via SystemPrismaService are unaffected (the same reason
-- the pre-existing FORCE on users/magic_links/invites never broke login). The
-- runtime `rhud_app` role is NOBYPASSRLS and was already subject to RLS. This
-- migration makes the posture uniform and protects against any future
-- non-superuser owner-role access path.

ALTER TABLE "audit_chain_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "email_extraction_cache" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_answers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_files" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_follow_ups" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_quote_line_items" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_quotes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_summaries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagement_tickets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "engagements" FORCE ROW LEVEL SECURITY;
ALTER TABLE "gathering_tokens" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ingestion_artifacts" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_connections" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_entity_links" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_field_mappings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_imported_opportunities" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_sync_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "odoo_webhook_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_categories" FORCE ROW LEVEL SECURITY;
ALTER TABLE "opportunity_routing_rules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "password_resets" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_open_priced_services" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_service_lines" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_tiers" FORCE ROW LEVEL SECURITY;
ALTER TABLE "rate_cards" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_enumeration_pages" FORCE ROW LEVEL SECURITY;
ALTER TABLE "site_enumerations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "template_nodes" FORCE ROW LEVEL SECURITY;
ALTER TABLE "templates" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_outlook_app" FORCE ROW LEVEL SECURITY;
ALTER TABLE "thread_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "user_integrations" FORCE ROW LEVEL SECURITY;
