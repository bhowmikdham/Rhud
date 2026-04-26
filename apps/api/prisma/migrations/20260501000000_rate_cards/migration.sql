-- Pricing Engine — Phase 1: Canonical Rate Card schema.
--
-- Design lifted from Rhud_Pricing_Engine.pdf §2.2 + §3.2-3.3.
-- A rate_card is a versioned, tenant-owned price book. Each service_line
-- (e.g. "VAPT — Web App") has a list of tiers — the tier whose
-- [range_min, range_max] window contains the responder's scope dimension
-- value, filtered by methodology + customer_type, gives the unit price.
--
-- The PDF's reframe matters: this layer is *deterministic*. ML never
-- touches it. Stage 3 (modifier prediction) wraps the deterministic
-- output, but the base price is auditable line-by-line against the
-- specific rate-card version that was active at quote time.
--
-- Versioning: a tenant can have many rate cards (draft, published,
-- archived). Engagement quotes pin to a specific rate_card_id at quote
-- time so historical proposals stay reproducible after pricing changes.

-- ── rate_cards ──────────────────────────────────────────────────────────────
CREATE TABLE "rate_cards" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        UUID NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "name"             TEXT NOT NULL,
  "version"          INTEGER NOT NULL DEFAULT 1,
  "status"           TEXT NOT NULL DEFAULT 'draft',
  "currency"         TEXT NOT NULL DEFAULT 'INR',
  "effective_from"   TIMESTAMPTZ,
  "effective_to"     TIMESTAMPTZ,
  -- Pointer to the original uploaded xlsx in object storage. Optional —
  -- rate cards can be authored manually or seeded from fixtures too.
  "source_file_key"  TEXT,
  "created_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "rate_cards_status_check"   CHECK ("status" IN ('draft','published','archived')),
  CONSTRAINT "rate_cards_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
CREATE UNIQUE INDEX "rate_cards_tenant_name_version_uniq" ON "rate_cards"("tenant_id","name","version");
CREATE INDEX "rate_cards_tenant_id_idx"      ON "rate_cards"("tenant_id");
CREATE INDEX "rate_cards_tenant_status_idx"  ON "rate_cards"("tenant_id","status");

ALTER TABLE "rate_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_cards" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "rate_cards_tenant_isolation" ON "rate_cards"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── rate_card_service_lines ─────────────────────────────────────────────────
-- e.g. { slug: 'vapt_web_app', display_name: 'VAPT — Web Application',
--        scope_unit: 'pages', pricing_model: 'tier_lookup' }
CREATE TABLE "rate_card_service_lines" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL,                 -- denormalised for RLS
  "rate_card_id"   UUID NOT NULL REFERENCES "rate_cards"("id") ON DELETE CASCADE,
  "slug"           TEXT NOT NULL,                 -- machine id; templates reference this
  "display_name"   TEXT NOT NULL,
  -- Dimension the scope question resolves to. Drives Stage 1 normalisation.
  "scope_unit"     TEXT NOT NULL,
  -- tier_lookup is the only model implemented today; per_unit/flat/hourly
  -- are placeholders so the schema can absorb other tenants' shapes.
  "pricing_model"  TEXT NOT NULL DEFAULT 'tier_lookup',
  "position"       INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "rate_card_service_lines_scope_unit_check"
    CHECK ("scope_unit" IN ('pages','screens','apis','loc','devices','hours','other')),
  CONSTRAINT "rate_card_service_lines_pricing_model_check"
    CHECK ("pricing_model" IN ('tier_lookup','per_unit','flat','hourly'))
);
CREATE UNIQUE INDEX "rate_card_service_lines_card_slug_uniq"
  ON "rate_card_service_lines"("rate_card_id","slug");
CREATE INDEX "rate_card_service_lines_tenant_idx" ON "rate_card_service_lines"("tenant_id");

ALTER TABLE "rate_card_service_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_service_lines" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "rate_card_service_lines_tenant_isolation" ON "rate_card_service_lines"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── rate_card_tiers ─────────────────────────────────────────────────────────
-- A row per (service_line, methodology, customer_type, range). The
-- pricing engine picks the row where range_min ≤ scope ≤ range_max,
-- methodology + customer_type match, and price_cents > 0.
CREATE TABLE "rate_card_tiers" (
  "id"               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"        UUID NOT NULL,
  "service_line_id"  UUID NOT NULL REFERENCES "rate_card_service_lines"("id") ON DELETE CASCADE,
  "range_min"        INTEGER NOT NULL,                  -- inclusive
  "range_max"        INTEGER,                           -- inclusive; NULL = open-ended
  "methodology"      TEXT,                              -- 'grey_box' | 'black_box' | 'va' | 'pt' | NULL
  "customer_type"    TEXT NOT NULL,
  "price_cents"      BIGINT NOT NULL,                   -- ×100 in rate_card.currency
  -- Original tier label as written in the source ("Upto 50", "0-30",
  -- "200 & Above") — preserved for traceability in proposal line items.
  "display_label"    TEXT,
  CONSTRAINT "rate_card_tiers_customer_type_check"
    CHECK ("customer_type" IN ('internal','external')),
  CONSTRAINT "rate_card_tiers_price_nonneg"  CHECK ("price_cents" >= 0),
  CONSTRAINT "rate_card_tiers_range_valid"   CHECK ("range_max" IS NULL OR "range_max" >= "range_min")
);
CREATE INDEX "rate_card_tiers_service_line_idx" ON "rate_card_tiers"("service_line_id");
CREATE INDEX "rate_card_tiers_tenant_idx"       ON "rate_card_tiers"("tenant_id");
CREATE INDEX "rate_card_tiers_lookup_idx"
  ON "rate_card_tiers"("service_line_id","customer_type","methodology");

ALTER TABLE "rate_card_tiers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_tiers" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "rate_card_tiers_tenant_isolation" ON "rate_card_tiers"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── rate_card_open_priced_services ──────────────────────────────────────────
-- "SEBI CSCR", "SOC II", "ISO 27001:2022" — case-by-case items that exist
-- in the rate card without a published price. The pricing engine emits
-- a "manual_quote_required" line item when the scope hits one of these.
CREATE TABLE "rate_card_open_priced_services" (
  "id"             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"      UUID NOT NULL,
  "rate_card_id"   UUID NOT NULL REFERENCES "rate_cards"("id") ON DELETE CASCADE,
  "slug"           TEXT NOT NULL,
  "display_name"   TEXT NOT NULL,
  "category"       TEXT,
  "position"       INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX "rate_card_open_priced_services_card_slug_uniq"
  ON "rate_card_open_priced_services"("rate_card_id","slug");
CREATE INDEX "rate_card_open_priced_services_tenant_idx"
  ON "rate_card_open_priced_services"("tenant_id");

ALTER TABLE "rate_card_open_priced_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_card_open_priced_services" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "rate_card_open_priced_services_tenant_isolation"
  ON "rate_card_open_priced_services"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- Runtime grants — match the convention used by other tenant-scoped tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_cards"                       TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_card_service_lines"          TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_card_tiers"                  TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "rate_card_open_priced_services"   TO rhud_app;
