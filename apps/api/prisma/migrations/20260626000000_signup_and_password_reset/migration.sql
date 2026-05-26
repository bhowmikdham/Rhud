-- Self-serve signup + forgot-password support.
--
-- 1. User gets three new columns:
--      email_verified                (Boolean, DEFAULT TRUE)
--      email_verification_token_hash (TEXT, NULL)
--      email_verification_expires_at (TIMESTAMPTZ, NULL)
--
--    Default TRUE on email_verified is deliberate: existing seeded users
--    (admin/maya/oren @everlane.test, sam@acme.test) keep their access. New
--    rows inserted via POST /auth/signup explicitly set email_verified=FALSE
--    and populate the verification columns until the user clicks the link.
--
-- 2. New password_resets table — same shape and RLS posture as magic_links.

-- ── users: verification columns ────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN "email_verified"                 BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN "email_verification_token_hash"  TEXT,
  ADD COLUMN "email_verification_expires_at"  TIMESTAMPTZ;

-- Partial index supports the unscoped lookup at /auth/verify-email
-- (filter by email_verified=FALSE AND expires_at > now()).
CREATE INDEX "users_pending_verification_idx"
  ON "users" ("email_verification_expires_at")
  WHERE "email_verified" = FALSE
    AND "email_verification_token_hash" IS NOT NULL;

-- ── password_resets ────────────────────────────────────────────────
CREATE TABLE "password_resets" (
  "id"          UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"   UUID        NOT NULL,
  "user_id"     UUID        NOT NULL,
  "token_hash"  TEXT        NOT NULL,
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "consumed_at" TIMESTAMPTZ,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "password_resets_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "password_resets_user_id_idx"   ON "password_resets"("user_id");
CREATE INDEX "password_resets_tenant_id_idx" ON "password_resets"("tenant_id");
CREATE INDEX "password_resets_open_idx"
  ON "password_resets" ("expires_at")
  WHERE "consumed_at" IS NULL;

ALTER TABLE "password_resets"
  ADD CONSTRAINT "password_resets_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "password_resets"
  ADD CONSTRAINT "password_resets_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS — same shape as magic_links.
ALTER TABLE "password_resets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "password_resets" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "password_resets_tenant_isolation" ON "password_resets"
  USING       ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK  ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "password_resets" TO rhud_app;
