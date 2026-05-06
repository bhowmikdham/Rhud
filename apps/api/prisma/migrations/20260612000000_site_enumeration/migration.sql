-- Site enumeration: crawl a prospect's existing website, classify the
-- discovered URLs into canonical categories, and feed the aggregated
-- counts into the existing pricing engine as ScopedEntity[]. One-to-one
-- with engagement; same retry-queue + RLS shape as engagement_files so
-- the cron sweeper can poll due retries without bespoke infra.
--
-- Status enum mirrors the extraction pipeline:
--   pending → crawling → classifying → ready
--                                   └─→ failed
--                                   └─→ retry_queued (cron picks up)

-- ── site_enumerations ───────────────────────────────────────────────────────
CREATE TABLE "site_enumerations" (
  "id"                UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"         UUID        NOT NULL,
  "engagement_id"     UUID        NOT NULL,
  "site_url"          TEXT        NOT NULL,
  "status"            TEXT        NOT NULL DEFAULT 'pending',
  "started_at"        TIMESTAMPTZ,
  "completed_at"      TIMESTAMPTZ,
  "total_urls"        INTEGER     NOT NULL DEFAULT 0,
  "classified_urls"   INTEGER     NOT NULL DEFAULT 0,
  "categories_json"   JSONB,
  "inferred_entities" JSONB,
  "options_json"      JSONB,
  "attempts"          INTEGER     NOT NULL DEFAULT 0,
  "retry_at"          TIMESTAMPTZ,
  "error"             TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "site_enumerations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_enumerations_engagement_id_uniq" UNIQUE ("engagement_id"),
  CONSTRAINT "site_enumerations_status_chk"
    CHECK ("status" IN ('pending', 'crawling', 'classifying', 'ready', 'failed', 'retry_queued'))
);

CREATE INDEX "site_enumerations_tenant_id_idx" ON "site_enumerations"("tenant_id");
-- Partial index for the cron's hot path — only retry_queued rows ever match.
CREATE INDEX "site_enumerations_retry_idx"
  ON "site_enumerations" ("status", "retry_at")
  WHERE "status" = 'retry_queued';

ALTER TABLE "site_enumerations"
  ADD CONSTRAINT "site_enumerations_engagement_id_fkey"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

-- ── site_enumeration_pages ──────────────────────────────────────────────────
CREATE TABLE "site_enumeration_pages" (
  "id"                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"             UUID        NOT NULL,
  "enumeration_id"        UUID        NOT NULL,
  "url"                   TEXT        NOT NULL,
  "http_status"           INTEGER,
  "content_type"          TEXT,
  "title"                 TEXT,
  "description"           TEXT,
  "category"              TEXT,
  "classifier_confidence" DOUBLE PRECISION,
  "classifier_source"     TEXT,
  "fetched_at"            TIMESTAMPTZ NOT NULL,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "site_enumeration_pages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "site_enumeration_pages_enum_url_uniq" UNIQUE ("enumeration_id", "url")
);

CREATE INDEX "site_enumeration_pages_enum_category_idx"
  ON "site_enumeration_pages" ("enumeration_id", "category");
CREATE INDEX "site_enumeration_pages_tenant_id_idx"
  ON "site_enumeration_pages" ("tenant_id");

ALTER TABLE "site_enumeration_pages"
  ADD CONSTRAINT "site_enumeration_pages_enumeration_id_fkey"
  FOREIGN KEY ("enumeration_id") REFERENCES "site_enumerations"("id") ON DELETE CASCADE;

-- ── Row-Level Security ──────────────────────────────────────────────────────
ALTER TABLE "site_enumerations"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_enumerations"      FORCE  ROW LEVEL SECURITY;
ALTER TABLE "site_enumeration_pages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "site_enumeration_pages" FORCE  ROW LEVEL SECURITY;

CREATE POLICY "site_enumerations_tenant_isolation" ON "site_enumerations"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "site_enumeration_pages_tenant_isolation" ON "site_enumeration_pages"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── Runtime role grants ─────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE ON "site_enumerations"      TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "site_enumeration_pages" TO rhud_app;

-- ── Whitelist the new thread event types ────────────────────────────────────
-- Bring the CHECK constraint in line with @rhud/shared THREAD_EVENT_TYPES,
-- including event types that were declared in code but never reflected in
-- the DB constraint (mapper_fallback_heuristic, loop_iteration_removed).

ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;

ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'file_extracted',
      'loop_iteration_removed',
      'mapper_fallback_heuristic',
      'scope_submitted','price_predicted','approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved',
      'site_enumerated','site_enumeration_failed'
    ));
