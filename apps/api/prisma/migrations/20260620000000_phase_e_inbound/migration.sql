-- Phase E — inbound ingestion (email + partner API) + audit + dedup.
--
-- Three additions and two glue tables:
--   1. tenants gain a per-tenant `inbound_email_local` (the local-part of
--      the catch-all address Postmark routes to us) + two default-fk
--      columns the intake service reads when there is no logged-in user
--      to attribute the opportunity to.
--   2. partner_tokens — named tokens per partner, mirroring the invite /
--      gathering-token pattern (argon2id hash, revoked_at, one-time
--      plaintext displayed on create).
--   3. engagements gain a `source` column so the UI can render a
--      "via email" / "via partner Acme Reseller" chip on the list page,
--      plus an optional partner_token_id back-ref.
--   4. inbound_email_dedup — global (non-tenant) table so we de-dup
--      Postmark retries by their MessageID before we know which tenant
--      owns the recipient.
--   5. Two new thread event types: intake_email + intake_partner.

-- ── 1. Tenant defaults for inbound-created opportunities ─────────────

ALTER TABLE tenants
  -- Local part of the Postmark catch-all (e.g. 'acme-sales' for
  -- acme-sales@inbound.rhud.net). Nullable so existing tenants keep
  -- working; the inbound webhook returns `dropped` (not 404) when no
  -- row matches the recipient.
  -- Stored citext so case-mismatched recipients still resolve.
  ADD COLUMN inbound_email_local citext,
  -- FK + ON DELETE SET NULL: deleting the template/user wipes the
  -- default rather than dangling. Intake errors with
  -- `defaults_not_configured` if either is null AND the partner token
  -- (where applicable) didn't provide an override.
  ADD COLUMN default_template_id uuid REFERENCES templates(id) ON DELETE SET NULL,
  ADD COLUMN default_sales_owner_id uuid REFERENCES users(id) ON DELETE SET NULL;

-- Globally unique inbound local-part across all tenants — we use a
-- single catch-all domain, so two tenants can't share 'sales'. Partial
-- unique so NULL doesn't collide with NULL.
CREATE UNIQUE INDEX tenants_inbound_email_local_uniq
  ON tenants (inbound_email_local) WHERE inbound_email_local IS NOT NULL;

-- ── 2. partner_tokens — named partners, token-authed POST ───────────

CREATE TABLE partner_tokens (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Human label, shown in admin UI ("Acme Reseller", "Northwind Q4").
  -- Unique per tenant (where not revoked) so admins can rotate by
  -- re-issuing a same-named token.
  name                     text        NOT NULL,
  -- argon2id hash of the plaintext token. Plaintext lives only in the
  -- 201 response shown once, mirroring invites + gathering tokens.
  token_hash               text        NOT NULL,
  -- Per-partner overrides. NULL → fall back to tenant defaults.
  default_template_id      uuid REFERENCES templates(id) ON DELETE SET NULL,
  default_sales_owner_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Optional cutoff; NULL = no expiry.
  expires_at               timestamptz,
  revoked_at               timestamptz,
  created_by_user_id       uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  last_used_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX partner_tokens_tenant_name_active_uniq
  ON partner_tokens (tenant_id, name) WHERE revoked_at IS NULL;
CREATE INDEX partner_tokens_tenant_idx ON partner_tokens (tenant_id);

ALTER TABLE partner_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_tokens FORCE ROW LEVEL SECURITY;

-- RLS: admin CRUD is fully tenant-scoped. The public POST path (no JWT)
-- runs unscoped via UnscopedDb.findActivePartnerTokens() to discover the
-- tenant; once known, all subsequent work runs inside TenantDb.run().
CREATE POLICY partner_tokens_isolation ON partner_tokens
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON partner_tokens TO rhud_app;

-- ── 3. engagements provenance ───────────────────────────────────────

ALTER TABLE engagements
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  -- Back-ref for "via partner X" UI rendering. NULL for source != 'partner_api'.
  ADD COLUMN partner_token_id uuid REFERENCES partner_tokens(id) ON DELETE SET NULL;

-- DB-side whitelist — defense in depth if the API process is compromised.
ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_source_check;
ALTER TABLE engagements
  ADD CONSTRAINT engagements_source_check
    CHECK (source IN ('manual', 'inbound_email', 'partner_api', 'odoo'));

CREATE INDEX engagements_partner_token_idx
  ON engagements (partner_token_id) WHERE partner_token_id IS NOT NULL;

-- ── 4. Idempotency table for Postmark retries ───────────────────────
-- Postmark resends on any 5xx, so we de-dupe on MessageID. If we've
-- already processed a MessageID, the webhook returns 200 with
-- status='duplicate' and no engagement is created.
--
-- Global (not tenant-scoped) because the dedup happens BEFORE we know
-- which tenant owns the recipient. The rhud_app role inserts; nothing
-- in app code reads it through TenantDb.

CREATE TABLE inbound_email_dedup (
  message_id    text        PRIMARY KEY,
  -- The engagement we produced (or NULL when we dropped the message
  -- e.g. recipient didn't match any tenant). Useful for support
  -- ("did this email get an opportunity?").
  engagement_id uuid,
  tenant_id     uuid,
  received_at   timestamptz NOT NULL DEFAULT now()
);

-- Sweeper-friendly index: trim entries older than 30 days.
CREATE INDEX inbound_email_dedup_received_at_idx ON inbound_email_dedup (received_at);

-- Not RLS-protected because there's no tenant scope.
GRANT SELECT, INSERT, UPDATE ON inbound_email_dedup TO rhud_app;

-- ── 5. Thread event whitelist — intake events ───────────────────────
-- IMPORTANT: full CHECK rewrite (Postgres doesn't support partial edits).
-- Append ONLY at the end; everything above mirrors the Phase C copy.

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
      'final_approval_requested','final_approval_granted','final_approval_rejected',
      -- Phase E additions:
      -- intake_email: an inbound email landed and an engagement was created.
      --   Payload: { fromEmail, subject, attachmentCount, postmarkMessageId }
      -- intake_partner: a partner POSTed a new opportunity.
      --   Payload: { partnerTokenId, partnerName, attachmentCount, sourceIp }
      'intake_email',
      'intake_partner'
    ));
