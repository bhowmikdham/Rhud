-- Direct-ingest opportunity pipeline — Sprint 1 schema.
-- See docs/direct-ingest.md §3 for the full design.
--
-- This migration:
--   1. Makes engagements.template_id / template_version nullable (a
--      direct-ingest opportunity doesn't need a template; the rep can
--      attach one later via POST /opportunities/:id/links).
--   2. Adds engagements.source (channel of origin) and engagements
--      .ingestion_id (back-pointer to the primary IngestionArtifact).
--   3. Adds engagement_files.origin_artifact_id (which artifact this
--      file materialised from).
--   4. Creates the new ingestion_artifacts table — captures the raw
--      input (paste text, file bytes, email body + attachments, voice
--      transcripts) before/at the moment of opportunity creation.
--   5. Extends the engagements.status CHECK to include 'ingesting'
--      (the initial state for direct-ingest opportunities) and the
--      thread_events.event_type CHECK to include the two new event
--      types — 'requirements_ingested' and 'link_reissued'.

-- ── 1. engagements: nullable templateId/templateVersion + new columns ──

ALTER TABLE engagements
  ALTER COLUMN template_id      DROP NOT NULL,
  ALTER COLUMN template_version DROP NOT NULL;

ALTER TABLE engagements
  ADD COLUMN source        text NOT NULL DEFAULT 'manual_form',
  ADD COLUMN ingestion_id  uuid;

-- CHECK ensures the source column only ever holds one of the values
-- whitelisted in @rhud/shared (packages/shared/src/ingestion.ts).
-- Update this list when ENGAGEMENT_SOURCES is extended.
ALTER TABLE engagements
  ADD CONSTRAINT engagements_source_check
    CHECK (source IN (
      'manual_form',     -- existing link-share wizard (default)
      'direct_upload',   -- rep dropped a file in the "I have it" UI
      'paste_text',      -- pasted email/WhatsApp/call notes
      'voice_note',      -- audio → STT → text
      'email_import',    -- SES inbound or future Outlook extension
      'whatsapp_import', -- Meta Cloud API webhook
      'rfp_import',      -- classifier-tagged tender / RFP
      'sow_import',      -- classifier-tagged SOW
      'odoo_import',     -- Odoo sync (replaces imported_from_odoo bool)
      'api'              -- programmatic ingestion catch-all
    ));

-- Existing rows: all have status='issued'-or-later and originate from
-- the link-share wizard. The DEFAULT 'manual_form' value on the new
-- column already populated them — no explicit backfill needed.

CREATE INDEX engagements_tenant_source_idx ON engagements (tenant_id, source);

-- ── 2. engagements.status — add 'ingesting' ──────────────────────

ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_status_check;
ALTER TABLE engagements
  ADD CONSTRAINT engagements_status_check
    CHECK (status IN (
      -- NEW: direct-ingest initial state. Artifacts attached, extraction
      -- running. Transitions to 'submitted' when every attached file
      -- reaches extraction.status = 'ready'.
      'ingesting',
      'issued','in_progress','submitted','predicted',
      'pending_approval','approved',
      'drafting','draft_ready','sent','closed','rejected','expired',
      'returned_to_sales','awaiting_clarification','escalated',
      'pending_vp_approval','pending_ceo_approval'
    ));

-- ── 3. engagement_files.origin_artifact_id ───────────────────────

ALTER TABLE engagement_files
  ADD COLUMN origin_artifact_id uuid;

CREATE INDEX engagement_files_origin_artifact_idx
  ON engagement_files (origin_artifact_id);

-- ── 4. ingestion_artifacts table ─────────────────────────────────

CREATE TABLE ingestion_artifacts (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Set after promotion. NULL while pending (webhook-arrived; not yet
  -- promoted to an opportunity). ON DELETE SET NULL — deleting an
  -- engagement detaches its artifacts rather than blowing them away,
  -- so audit history survives.
  engagement_id   uuid        REFERENCES engagements(id) ON DELETE SET NULL,
  source          text        NOT NULL,
  kind            text        NOT NULL,

  -- Text-shaped artifacts. Capped by the application at ~256KB; the
  -- column itself accepts longer values to avoid silent truncation.
  raw_text        text,

  -- Email-shaped artifact metadata.
  email_subject   text,
  email_from      text,
  email_to        text[]      NOT NULL DEFAULT '{}',
  email_date      timestamptz,
  email_headers   jsonb,
  external_id     text,

  -- File-shaped artifact storage pointers.
  s3_key          text,
  content_type    text,
  size_bytes      integer,
  original_name   text,

  status          text        NOT NULL DEFAULT 'received',
  failure_reason  text,

  received_at     timestamptz NOT NULL DEFAULT now(),
  received_by     uuid,
  promoted_at     timestamptz,

  -- Source whitelist matches the engagements_source_check above.
  CONSTRAINT ingestion_artifacts_source_check
    CHECK (source IN (
      'manual_form','direct_upload','paste_text','voice_note',
      'email_import','whatsapp_import','rfp_import','sow_import',
      'odoo_import','api'
    )),
  -- Kind whitelist matches @rhud/shared ARTIFACT_KINDS.
  CONSTRAINT ingestion_artifacts_kind_check
    CHECK (kind IN ('text','file','audio','email')),
  -- Status whitelist matches @rhud/shared INGESTION_STATUSES.
  CONSTRAINT ingestion_artifacts_status_check
    CHECK (status IN ('received','processing','promoted','failed')),
  -- Cross-field invariants: text-shaped artifacts must carry raw_text
  -- (paste-text is meaningless without content); file/audio artifacts
  -- must carry s3_key (otherwise there's nothing to extract from).
  CONSTRAINT ingestion_artifacts_text_shape_check
    CHECK (kind != 'text' OR raw_text IS NOT NULL),
  CONSTRAINT ingestion_artifacts_file_shape_check
    CHECK (kind NOT IN ('file','audio') OR s3_key IS NOT NULL)
);

CREATE INDEX ingestion_artifacts_tenant_idx
  ON ingestion_artifacts (tenant_id);
CREATE INDEX ingestion_artifacts_tenant_status_idx
  ON ingestion_artifacts (tenant_id, status);
-- Partial index — only inbound messages carry an external_id; we use
-- it to deduplicate redelivered webhook payloads.
CREATE INDEX ingestion_artifacts_tenant_external_idx
  ON ingestion_artifacts (tenant_id, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX ingestion_artifacts_engagement_idx
  ON ingestion_artifacts (engagement_id);

ALTER TABLE ingestion_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY ingestion_artifacts_isolation ON ingestion_artifacts
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ingestion_artifacts TO rhud_app;

-- ── 5. engagements.ingestion_id FK (deferred to here so the
--      target table exists before the constraint is added). ────────

ALTER TABLE engagements
  ADD CONSTRAINT engagements_ingestion_id_fkey
    FOREIGN KEY (ingestion_id)
    REFERENCES ingestion_artifacts(id)
    ON DELETE SET NULL;

CREATE INDEX engagements_ingestion_id_idx ON engagements (ingestion_id);

-- ── 6. engagement_files.origin_artifact_id FK ────────────────────

ALTER TABLE engagement_files
  ADD CONSTRAINT engagement_files_origin_artifact_id_fkey
    FOREIGN KEY (origin_artifact_id)
    REFERENCES ingestion_artifacts(id)
    ON DELETE SET NULL;

-- ── 7. thread_events — new event types ───────────────────────────

ALTER TABLE thread_events DROP CONSTRAINT IF EXISTS thread_events_event_type_check;
ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'file_extracted','loop_iteration_removed','mapper_fallback_heuristic',
      'scope_submitted','price_predicted','price_tech_adjusted',
      'approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved',
      'site_enumerated','site_enumeration_failed',
      'ticket_opened','ticket_status_changed','ticket_resolved',
      'follow_up_scheduled','follow_up_completed',
      'summary_generated',
      'scope_returned_to_sales','clarification_requested','scope_escalated',
      'scope_assumptions_updated','scope_exclusions_updated',
      'quote_line_item_added','quote_line_item_removed',
      'engagement_classified','engagement_reclassified',
      'reviewer_assigned','reviewer_reassigned',
      'final_approval_requested',
      'final_approval_granted',
      'final_approval_rejected',
      -- Direct-ingest pipeline (Sprint 1):
      -- requirements_ingested: one or more IngestionArtifact rows
      --   were promoted into this engagement. Payload carries
      --   { source, artifactIds, kind }.
      -- link_reissued: a gathering token was minted against an
      --   already-existing engagement (re-scope / follow-up). Distinct
      --   from link_issued, which is emitted only on first issuance.
      --   Payload: { tokenId, expiresAt, reason? }.
      'requirements_ingested',
      'link_reissued'
    ));
