-- LLM extraction cache for the Outlook add-in preview.
--
-- The add-in calls POST /opportunities/preview-from-email on every pane
-- open. The expensive part is the per-tenant LLM pass that resolves the
-- real client (disambiguating internal forwarders) and the scope fields.
-- We cache that JSON result keyed by (tenant_id, message_id) so reopening
-- the same email is free. Rows older than 30 days are swept by
-- UnscopedDb.purgeStaleEmailExtractions (cross-tenant, system role).
--
-- RLS + grant mirror ingestion_artifacts (20260802000000).

CREATE TABLE email_extraction_cache (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- RFC822 Message-Id of the source email.
  message_id  text        NOT NULL,
  -- Extractor result: { client, isForwarded, forwardedFrom, structuredFields }.
  payload     jsonb       NOT NULL,
  -- Provider-reported model id that produced this result (audit).
  model       text,
  created_at  timestamptz NOT NULL DEFAULT now(),

  -- One cached extraction per email per tenant. A re-preview of the same
  -- message reads through this; a different tenant forwarded the same
  -- email gets its own row (RLS keeps them apart anyway).
  CONSTRAINT email_extraction_tenant_message_uniq UNIQUE (tenant_id, message_id)
);

-- Sweep query filters on created_at across all tenants.
CREATE INDEX email_extraction_cache_created_idx ON email_extraction_cache (created_at);

ALTER TABLE email_extraction_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY email_extraction_cache_isolation ON email_extraction_cache
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_extraction_cache TO rhud_app;
