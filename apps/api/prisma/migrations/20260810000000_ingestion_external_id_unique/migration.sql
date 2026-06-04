-- concurrency-4: dedupe inbound artifacts atomically.
--
-- receive() previously did findFirst-then-create on (tenant_id, external_id)
-- backed by only a NON-unique index, so two concurrent webhook redeliveries of
-- the same message could both pass the check and both insert — creating
-- duplicate artifacts and, downstream, duplicate opportunities. Promote the
-- dedup key to a real UNIQUE index so a racing insert fails with P2002, which
-- receive() now catches and resolves to the row the other request created.
--
-- A full (non-partial) unique index is used so it matches Prisma's @@unique in
-- schema.prisma (no drift). NULL external_id (manual uploads / non-message
-- artifacts) is exempt automatically: Postgres treats NULLs as distinct in a
-- unique index, so any number of NULL-external_id rows coexist.
--
-- NOTE: this assumes no pre-existing duplicate (tenant_id, external_id) rows.
-- If the pre-fix bug already produced some, this CREATE fails loudly — dedupe
-- them manually (keep the promoted row) rather than auto-deleting linked data.
DROP INDEX IF EXISTS "ingestion_artifacts_tenant_external_idx";
CREATE UNIQUE INDEX "ingestion_artifacts_tenant_external_uniq"
  ON "ingestion_artifacts" ("tenant_id", "external_id");
