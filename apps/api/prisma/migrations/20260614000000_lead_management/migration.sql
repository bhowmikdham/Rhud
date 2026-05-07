-- Lead-management tables: tickets, follow-ups, AI-generated summaries.
--
-- Why these live next to engagements rather than as a separate domain:
--   - All three are 1:N off engagements, all tenant-scoped.
--   - Tickets + follow-ups are the operational layer the summariser
--     reads from when it builds a lead-status digest.
--   - The cached summary table lives so the manager dashboard can
--     render last-known status fast without re-invoking the LLM on
--     every page load (refresh on demand).

-- ── 1. Engagement tickets (complaints, change requests, check-ins) ────

CREATE TABLE engagement_tickets (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  engagement_id     uuid        NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  -- 'complaint' = client unhappy about something.
  -- 'question' = client asked us, awaiting reply.
  -- 'change_request' = client wants scope change.
  -- 'check_in' = internal "nudge the client" task.
  -- 'internal_note' = ops/manager note that isn't a true ticket.
  category          text        NOT NULL,
  -- 'low' | 'medium' | 'high' | 'urgent'
  priority          text        NOT NULL DEFAULT 'medium',
  -- 'open' | 'in_progress' | 'resolved' | 'wont_fix'
  status            text        NOT NULL DEFAULT 'open',
  title             text        NOT NULL,
  description       text,
  -- 'client' | 'sales_rep' | 'sales_manager' | 'admin' | 'system'
  raised_by         text        NOT NULL,
  -- User id for Rhud-side raisers, null for client-raised.
  raised_by_user_id uuid,
  raised_by_email   text,
  -- Sales rep / manager assigned to handle. Null = unassigned.
  assigned_to       uuid,
  resolved_at       timestamptz,
  resolution_note   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_tickets_category_chk
    CHECK (category IN ('complaint', 'question', 'change_request', 'check_in', 'internal_note')),
  CONSTRAINT engagement_tickets_priority_chk
    CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  CONSTRAINT engagement_tickets_status_chk
    CHECK (status IN ('open', 'in_progress', 'resolved', 'wont_fix')),
  CONSTRAINT engagement_tickets_raised_by_chk
    CHECK (raised_by IN ('client', 'sales_rep', 'sales_manager', 'admin', 'system'))
);

CREATE INDEX engagement_tickets_tenant_idx
  ON engagement_tickets (tenant_id);
CREATE INDEX engagement_tickets_engagement_idx
  ON engagement_tickets (engagement_id);
CREATE INDEX engagement_tickets_open_idx
  ON engagement_tickets (tenant_id, status)
  WHERE status IN ('open', 'in_progress');
CREATE INDEX engagement_tickets_assigned_idx
  ON engagement_tickets (assigned_to, status)
  WHERE status IN ('open', 'in_progress');

ALTER TABLE engagement_tickets ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_tickets_isolation ON engagement_tickets
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_tickets TO rhud_app;

-- ── 2. Follow-ups (scheduled "remind me" reminders) ───────────────────

CREATE TABLE engagement_follow_ups (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id)     ON DELETE CASCADE,
  engagement_id   uuid        NOT NULL REFERENCES engagements(id) ON DELETE CASCADE,
  scheduled_for   timestamptz NOT NULL,
  reason          text        NOT NULL,
  -- Sales rep / manager who owns the follow-up. Null = unassigned.
  assigned_to     uuid,
  -- Set on completion; row stays for audit ("we did follow up on X").
  completed_at    timestamptz,
  completed_by    uuid,
  completion_note text,
  -- Optional link to a ticket the follow-up resolved or surfaced.
  related_ticket_id uuid REFERENCES engagement_tickets(id) ON DELETE SET NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX engagement_follow_ups_tenant_idx
  ON engagement_follow_ups (tenant_id);
CREATE INDEX engagement_follow_ups_engagement_idx
  ON engagement_follow_ups (engagement_id);
-- Hot index for the manager dashboard's "due this week" widget — only
-- pending rows.
CREATE INDEX engagement_follow_ups_pending_idx
  ON engagement_follow_ups (tenant_id, scheduled_for)
  WHERE completed_at IS NULL;
CREATE INDEX engagement_follow_ups_assignee_pending_idx
  ON engagement_follow_ups (assigned_to, scheduled_for)
  WHERE completed_at IS NULL;

ALTER TABLE engagement_follow_ups ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_follow_ups_isolation ON engagement_follow_ups
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_follow_ups TO rhud_app;

-- ── 3. LLM-generated lead summary cache ───────────────────────────────
-- One row per engagement (the latest summary). Older summaries aren't
-- preserved for now — re-generate when stale. The thread events table
-- is already an immutable audit, which is enough provenance for v1.

CREATE TABLE engagement_summaries (
  engagement_id              uuid        PRIMARY KEY REFERENCES engagements(id) ON DELETE CASCADE,
  tenant_id                  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Plain-English status summary the rep / manager reads first.
  summary_text               text        NOT NULL,
  -- 'low' | 'medium' | 'high' — derived heuristically from open
  -- tickets, stage stagnation, and LLM judgment.
  risk_level                 text        NOT NULL DEFAULT 'low',
  -- JSON array: [{ title, urgency: 'low'|'medium'|'high', owner?: string }]
  next_actions               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Suggested follow-up cadence (days from now). Null = no recommendation.
  recommended_follow_up_days integer,
  -- 'llm' | 'manual' — manual = user pasted text from another tool.
  generated_by               text        NOT NULL DEFAULT 'llm',
  -- LLM provider/model used (e.g. 'anthropic:claude-opus-4-7'). Null
  -- when generated_by='manual' or for future deterministic generators.
  model                      text,
  -- Snapshot of input tokens at generation time; for budget tracking.
  input_tokens               integer,
  output_tokens              integer,
  generated_by_user_id       uuid,
  generated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_summaries_risk_chk
    CHECK (risk_level IN ('low', 'medium', 'high')),
  CONSTRAINT engagement_summaries_generated_by_chk
    CHECK (generated_by IN ('llm', 'manual'))
);

CREATE INDEX engagement_summaries_tenant_idx
  ON engagement_summaries (tenant_id);
CREATE INDEX engagement_summaries_risk_idx
  ON engagement_summaries (tenant_id, risk_level);

ALTER TABLE engagement_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_summaries_isolation ON engagement_summaries
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_summaries TO rhud_app;

-- ── 4. Thread event types (extend whitelist) ──────────────────────────
-- Tickets and follow-ups emit thread events so the existing audit
-- timeline picks them up. Extend the CHECK constraint inline.

ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;
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
      -- Lead-management events (this migration):
      'ticket_opened','ticket_status_changed','ticket_resolved',
      'follow_up_scheduled','follow_up_completed',
      'summary_generated'
    ));
