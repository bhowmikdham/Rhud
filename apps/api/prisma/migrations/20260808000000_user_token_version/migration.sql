-- auth-2: per-user session-revocation counter.
-- Embedded in every issued JWT as `tv`; JwtAuthGuard rejects a token whose
-- value no longer matches this column. Bumped on role change / password reset
-- to force re-login. Existing tokens (no `tv` claim) are treated as tv=0 and
-- remain valid until the first bump, so the deploy doesn't log everyone out.
ALTER TABLE "users" ADD COLUMN "token_version" INTEGER NOT NULL DEFAULT 0;
