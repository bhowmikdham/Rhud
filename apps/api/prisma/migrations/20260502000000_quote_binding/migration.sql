-- Pricing Engine — Phase 1b: bind templates to rate cards, persist quotes.
--
-- This wires the deterministic base-price kernel into the engagement
-- flow:
--
--   1. Templates point at a default rate card. Engagements pin to that
--      card at submission time so historical proposals stay reproducible
--      after rate-card edits.
--   2. Template nodes carry a "binding" (which rate-card dimension this
--      answer fills). Stage 1 (scope normalisation) walks loops + body
--      answers via these bindings to produce a flat ScopedEntity[].
--   3. Submitted engagements compute + persist an engagement_quotes row
--      with the line-item breakdown for the manager approval card.

-- ── Templates pin to a rate card (optional; nullable for legacy templates) ──
ALTER TABLE "templates"
  ADD COLUMN "rate_card_id" UUID;
ALTER TABLE "templates"
  ADD CONSTRAINT "templates_rate_card_id_fkey"
  FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE SET NULL;
CREATE INDEX "templates_rate_card_id_idx" ON "templates"("rate_card_id");

-- ── Per-node binding ────────────────────────────────────────────────────────
-- JSONB shape: { field: 'scope_value' | 'methodology' | 'customer_type',
--                valueMap?: Record<string, string> }
-- See @rhud/shared NodeBinding for the canonical type.
ALTER TABLE "template_nodes"
  ADD COLUMN "binding" JSONB;

-- ── engagement_quotes ──────────────────────────────────────────────────────
-- One quote per engagement (UNIQUE on engagement_id). Recomputed on
-- submission; older revisions are not retained for now (a `revision`
-- column would unblock that without changing the integration surface).
CREATE TABLE "engagement_quotes" (
  "id"                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id"                   UUID NOT NULL,
  "engagement_id"               UUID NOT NULL UNIQUE REFERENCES "engagements"("id") ON DELETE CASCADE,
  "rate_card_id"                UUID REFERENCES "rate_cards"("id") ON DELETE SET NULL,
  "rate_card_version"           INTEGER NOT NULL,
  "currency"                    TEXT NOT NULL,
  "base_total_cents"            BIGINT NOT NULL,
  -- Full BasePriceLine[] from @rhud/shared. Stored verbatim so the
  -- proposal renders the same numbers months later even if the rate
  -- card schema evolves.
  "base_breakdown"              JSONB NOT NULL,
  -- Stage 3 (modifier prediction). Nullable until the model has data.
  "predicted_adjustment_pct"    NUMERIC,
  "predicted_price_cents"       BIGINT,
  "predicted_band_low_cents"    BIGINT,
  "predicted_band_high_cents"   BIGINT,
  "win_probability"             NUMERIC,
  "modifier_drivers"            JSONB,
  -- Manager approval (rec or override). Null until the card is used.
  "approved_price_cents"        BIGINT,
  "approved_at"                 TIMESTAMPTZ,
  "approved_by"                 UUID,
  "computed_at"                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX "engagement_quotes_tenant_idx"        ON "engagement_quotes"("tenant_id");
CREATE INDEX "engagement_quotes_rate_card_id_idx"  ON "engagement_quotes"("rate_card_id");

ALTER TABLE "engagement_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement_quotes" FORCE  ROW LEVEL SECURITY;
CREATE POLICY "engagement_quotes_tenant_isolation" ON "engagement_quotes"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_quotes" TO rhud_app;
