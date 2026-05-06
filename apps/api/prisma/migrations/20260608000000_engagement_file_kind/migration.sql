-- Quick-fill flow: a scoping document the client uploads as the FIRST
-- thing they do, before answering any specific question. There's no
-- template node these files belong to. Until now we anchored them to
-- the template's root node so the not-null constraint was satisfied,
-- but that conflated "scoping doc for the engagement" with "file
-- attached to a specific question" in the per-node files view.
--
-- Two changes:
--   1. Make `node_id` nullable so scoping docs can omit it cleanly.
--   2. Add a `kind` enum so the gathering UI can hide scoping docs
--      from the per-node files list (they belong at the engagement
--      level, not under a specific question).
ALTER TABLE "engagement_files"
  ALTER COLUMN "node_id" DROP NOT NULL,
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'node_attachment';

ALTER TABLE "engagement_files"
  ADD CONSTRAINT "engagement_files_kind_check"
  CHECK ("kind" IN ('scoping_doc', 'node_attachment'));

-- An index on kind keeps the per-engagement filter cheap.
CREATE INDEX "engagement_files_engagement_kind_idx"
  ON "engagement_files" ("engagement_id", "kind");
