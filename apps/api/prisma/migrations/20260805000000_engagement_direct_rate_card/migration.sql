-- Direct rate-card attachment on opportunities.
--
-- A direct-ingest opportunity (email / paste / voice) has no template,
-- and therefore no rate card to price against — every stage after
-- extraction (matching, inference, mapping, pricing) is gated on a rate
-- card. This column lets a rep attach a rate card straight to the
-- opportunity so it can be priced from extracted + inferred entities
-- without first issuing a client scoping link (the only way to attach a
-- template today).
--
-- Effective rate card used by pricing + inference:
--   engagements.rate_card_id  COALESCE  templates.rate_card_id
--
-- SET NULL on delete mirrors templates.rate_card_id: deleting a rate
-- card detaches it rather than cascading away the opportunity.

-- AlterTable
ALTER TABLE "engagements" ADD COLUMN "rate_card_id" UUID;

-- CreateIndex
CREATE INDEX "engagements_rate_card_id_idx" ON "engagements"("rate_card_id");

-- AddForeignKey
ALTER TABLE "engagements"
  ADD CONSTRAINT "engagements_rate_card_id_fkey"
  FOREIGN KEY ("rate_card_id") REFERENCES "rate_cards"("id") ON DELETE SET NULL;
