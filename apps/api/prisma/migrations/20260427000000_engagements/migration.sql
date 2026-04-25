-- Sprint 3 — engagements, gathering tokens, answers, files, thread events.
--
-- This migration brings online the 5 tables that drive the gathering/thread
-- pipeline (design doc §4.4 + §4.7). Notable details:
--
--   1. `thread_events` is APPEND-ONLY at the DB level. The `rhud_app` role
--      gets only INSERT and SELECT — no UPDATE, no DELETE. Audit integrity
--      (§4.6) is enforced by Postgres, not by app code.
--   2. `gathering_tokens.token_hash` stores argon2id; the plaintext is
--      issued exactly once (in the issuance response) and never retrievable.
--   3. RLS policies on every table key on current_setting('app.tenant_id').
--      Operations through tokens (no JWT) still go through TenantDb after
--      the token resolves to a tenant — see GatheringService.
--   4. Foreign keys cascade from tenant/engagement so cleanup is sane.

-- ── engagements ──────────────────────────────────────────────────────────────
CREATE TABLE "engagements" (
  "id"                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"             UUID        NOT NULL,
  "template_id"           UUID        NOT NULL,
  "template_version"      INTEGER     NOT NULL DEFAULT 1,
  "sales_employee_id"     UUID        NOT NULL,
  "sales_manager_id"      UUID,
  "client_email"          CITEXT      NOT NULL,
  "status"                TEXT        NOT NULL DEFAULT 'issued',
  "predicted_price_cents" BIGINT,
  "price_low_cents"       BIGINT,
  "price_high_cents"      BIGINT,
  "approved_price_cents"  BIGINT,
  "odoo_quotation_id"     TEXT,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "submitted_at"          TIMESTAMPTZ,
  "closed_at"             TIMESTAMPTZ,
  CONSTRAINT "engagements_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagements_status_check"
    CHECK ("status" IN (
      'issued','in_progress','submitted','predicted','pending_approval',
      'approved','drafting','draft_ready','sent','closed','rejected','expired'
    ))
);

CREATE INDEX "engagements_tenant_id_idx"            ON "engagements"("tenant_id");
CREATE INDEX "engagements_tenant_id_status_idx"     ON "engagements"("tenant_id","status");
CREATE INDEX "engagements_sales_employee_id_idx"    ON "engagements"("sales_employee_id");

ALTER TABLE "engagements"
  ADD CONSTRAINT "engagements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "engagements"
  ADD CONSTRAINT "engagements_template_id_fkey"
  FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE RESTRICT;
ALTER TABLE "engagements"
  ADD CONSTRAINT "engagements_sales_employee_id_fkey"
  FOREIGN KEY ("sales_employee_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "engagements"
  ADD CONSTRAINT "engagements_sales_manager_id_fkey"
  FOREIGN KEY ("sales_manager_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- ── gathering_tokens ─────────────────────────────────────────────────────────
CREATE TABLE "gathering_tokens" (
  "id"                      UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"               UUID        NOT NULL,
  "engagement_id"           UUID        NOT NULL,
  "token_hash"              TEXT        NOT NULL,
  "expires_at"              TIMESTAMPTZ NOT NULL,
  "bound_fingerprint_hash"  TEXT,
  "access_count"            INTEGER     NOT NULL DEFAULT 0,
  "revoked_at"              TIMESTAMPTZ,
  "created_at"              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "gathering_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gathering_tokens_tenant_id_idx"     ON "gathering_tokens"("tenant_id");
CREATE INDEX "gathering_tokens_engagement_id_idx" ON "gathering_tokens"("engagement_id");

ALTER TABLE "gathering_tokens"
  ADD CONSTRAINT "gathering_tokens_engagement_id_fkey"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

-- ── engagement_answers ───────────────────────────────────────────────────────
CREATE TABLE "engagement_answers" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID        NOT NULL,
  "engagement_id" UUID        NOT NULL,
  "node_id"       UUID        NOT NULL,
  "answer"        JSONB       NOT NULL,
  "answered_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "engagement_answers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "engagement_answers_unique_per_node" UNIQUE ("engagement_id","node_id")
);

CREATE INDEX "engagement_answers_tenant_id_idx" ON "engagement_answers"("tenant_id");

ALTER TABLE "engagement_answers"
  ADD CONSTRAINT "engagement_answers_engagement_id_fkey"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

-- ── engagement_files ─────────────────────────────────────────────────────────
CREATE TABLE "engagement_files" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID        NOT NULL,
  "engagement_id" UUID        NOT NULL,
  "node_id"       UUID        NOT NULL,
  "s3_key"        TEXT        NOT NULL,
  "filename"      TEXT        NOT NULL,
  "size_bytes"    BIGINT      NOT NULL,
  "content_type"  TEXT        NOT NULL,
  "uploaded_at"   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "engagement_files_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "engagement_files_tenant_id_idx"     ON "engagement_files"("tenant_id");
CREATE INDEX "engagement_files_engagement_id_idx" ON "engagement_files"("engagement_id");

ALTER TABLE "engagement_files"
  ADD CONSTRAINT "engagement_files_engagement_id_fkey"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

-- ── thread_events (APPEND-ONLY) ──────────────────────────────────────────────
CREATE TABLE "thread_events" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID        NOT NULL,
  "engagement_id" UUID        NOT NULL,
  "event_type"    TEXT        NOT NULL,
  "actor_type"    TEXT        NOT NULL,
  "actor_id"      TEXT,
  "payload"       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "thread_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "thread_events_event_type_check"
    CHECK ("event_type" IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'scope_submitted','price_predicted','approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed'
    )),
  CONSTRAINT "thread_events_actor_type_check"
    CHECK ("actor_type" IN ('user','client','system','integration'))
);

CREATE INDEX "thread_events_tenant_id_idx"        ON "thread_events"("tenant_id");
CREATE INDEX "thread_events_engagement_id_created_at_idx"
  ON "thread_events"("engagement_id","created_at");

ALTER TABLE "thread_events"
  ADD CONSTRAINT "thread_events_engagement_id_fkey"
  FOREIGN KEY ("engagement_id") REFERENCES "engagements"("id") ON DELETE CASCADE;

-- ── Row-Level Security ──────────────────────────────────────────────────────
ALTER TABLE "engagements"        ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagements"        FORCE  ROW LEVEL SECURITY;
ALTER TABLE "gathering_tokens"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "gathering_tokens"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "engagement_answers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement_answers" FORCE  ROW LEVEL SECURITY;
ALTER TABLE "engagement_files"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "engagement_files"   FORCE  ROW LEVEL SECURITY;
ALTER TABLE "thread_events"      ENABLE ROW LEVEL SECURITY;
ALTER TABLE "thread_events"      FORCE  ROW LEVEL SECURITY;

CREATE POLICY "engagements_tenant_isolation" ON "engagements"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "gathering_tokens_tenant_isolation" ON "gathering_tokens"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "engagement_answers_tenant_isolation" ON "engagement_answers"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "engagement_files_tenant_isolation" ON "engagement_files"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

CREATE POLICY "thread_events_tenant_isolation" ON "thread_events"
  USING      ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

-- ── Runtime role grants ─────────────────────────────────────────────────────
-- thread_events is INTENTIONALLY append-only at the role level. SELECT lets
-- the API render timelines; INSERT lets services emit events. UPDATE/DELETE
-- are deliberately omitted so even a buggy or compromised app cannot mutate
-- the audit trail. Compliance work later layers a hash chain on top.
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagements"        TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "gathering_tokens"   TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_answers" TO rhud_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "engagement_files"   TO rhud_app;
GRANT SELECT, INSERT                 ON "thread_events"      TO rhud_app;
