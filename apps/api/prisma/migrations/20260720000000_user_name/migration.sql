-- Add a display name column to users so the Account settings page can
-- store the human-readable name separately from the email login. Nullable
-- because existing rows don't have one; the UI falls back to the email
-- local-part when null.

ALTER TABLE "users" ADD COLUMN "name" TEXT;
