-- Settings page wiring: profile photo (user) + workspace logo (tenant).
-- Both columns store the S3 object KEY, not a url — the API resolves a
-- short-lived signed GET url at read time (GET /auth/me, GET /tenant/me).
-- Nullable, no default: existing rows simply have no avatar/logo and the
-- UI falls back to initials.

ALTER TABLE "users" ADD COLUMN "avatar_key" TEXT;
ALTER TABLE "tenants" ADD COLUMN "logo_key" TEXT;
