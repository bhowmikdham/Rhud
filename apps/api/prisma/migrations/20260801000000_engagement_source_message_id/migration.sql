-- Add source_message_id to engagements so the inbound-email creation flow
-- (Outlook add-in, future Gmail add-on) can dedupe retries on the
-- email's RFC822 Message-Id.
--
-- Nullable: native (rep-issued) engagements leave it NULL and Postgres
-- treats multiple NULLs as distinct under the unique index, so they never
-- collide. Only inbound-email rows compete on the constraint.

ALTER TABLE "engagements" ADD COLUMN "source_message_id" TEXT;

-- Per-tenant unique. Two tenants can both receive forwards of the same
-- email and create independent opportunities; one tenant can't create the
-- same opportunity twice from the same email.
CREATE UNIQUE INDEX "engagement_tenant_source_message_id_uniq"
  ON "engagements" ("tenant_id", "source_message_id");
