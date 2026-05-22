-- Phase A — Reviewer actions, scope additions, pricing line items.
--
-- Implements the workflow PM stages 4 (Reviewer Action Screen) gaps:
--   • Send Back to Sales / Request Clarification / Escalate buttons
--     → new status values + new thread event types
--   • Assumptions / Exclusions / delivery_timeline_override on engagements
--   • Travel / Tool / Resource costs + Discounts + Custom line items
--     → engagement_quote_line_items table

-- ── 1. Engagement scope additions ─────────────────────────────────────

ALTER TABLE engagements
  ADD COLUMN assumptions               text,
  ADD COLUMN exclusions                text,
  ADD COLUMN delivery_timeline_override text;

-- ── 2. Engagement status whitelist — add reviewer-driven holds ──────

ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_status_check;
ALTER TABLE engagements
  ADD CONSTRAINT engagements_status_check
    CHECK (status IN (
      'issued','in_progress','submitted','predicted',
      'pending_approval','approved',
      'drafting','draft_ready','sent','closed','rejected','expired',
      -- Phase A additions:
      'returned_to_sales',        -- reviewer sent it back, sales must edit/resubmit
      'awaiting_clarification',   -- reviewer asked a question, waiting for an answer
      'escalated'                 -- reviewer escalated to manager
    ));

-- ── 3. Thread event whitelist — reviewer-action events ───────────────

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
      -- Phase A additions:
      'scope_returned_to_sales',  -- reviewer clicked Send Back
      'clarification_requested',  -- reviewer asked a clarifying question
      'scope_escalated',          -- reviewer escalated to manager
      'scope_assumptions_updated',-- assumptions text changed
      'scope_exclusions_updated', -- exclusions text changed
      'quote_line_item_added',    -- travel/tool/resource/discount/custom added
      'quote_line_item_removed'
    ));

-- ── 4. Extra quote line items ────────────────────────────────────────
-- One row per "additional charge" the reviewer adds to a quote during
-- pricing review. Travel, tool, resource costs are positive amounts;
-- discounts are negative amounts (we store as cents, signed). Custom
-- catches whatever the reviewer wants to itemize.
--
-- Why a separate table rather than columns on engagement_quotes:
-- arbitrary count (a reviewer may add multiple travel trips), and the
-- audit trail (one row per add, with timestamp + actor) needs natural
-- per-line provenance.

CREATE TABLE engagement_quote_line_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  engagement_quote_id uuid        NOT NULL REFERENCES engagement_quotes(id) ON DELETE CASCADE,
  -- 'travel' | 'tool' | 'resource' | 'discount' | 'custom'
  kind                text        NOT NULL,
  -- User-facing label ("Mumbai onsite — 2 trips", "Burp Suite Pro license", …)
  label               text        NOT NULL,
  -- Signed cents. Positive = additional charge, negative = discount.
  -- For discounts expressed as a percentage, we also store the
  -- percentage in `percentage_bps` (basis points, so 12.5% = 1250)
  -- and the service recomputes the cents at write time. We store
  -- amount_cents anyway for stable reads — no recomputation on read.
  amount_cents        bigint      NOT NULL,
  -- Null unless kind='discount' and the reviewer entered a percentage.
  percentage_bps      integer,
  -- Position in the displayed list. Reviewers reorder by editing.
  position            integer     NOT NULL DEFAULT 0,
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_quote_line_items_kind_chk
    CHECK (kind IN ('travel','tool','resource','discount','custom')),
  CONSTRAINT engagement_quote_line_items_percentage_chk
    CHECK (
      percentage_bps IS NULL
      OR (percentage_bps BETWEEN -10000 AND 10000)
    )
);

CREATE INDEX engagement_quote_line_items_tenant_idx
  ON engagement_quote_line_items (tenant_id);
CREATE INDEX engagement_quote_line_items_quote_idx
  ON engagement_quote_line_items (engagement_quote_id, position);

ALTER TABLE engagement_quote_line_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY engagement_quote_line_items_isolation ON engagement_quote_line_items
  FOR ALL
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON engagement_quote_line_items TO rhud_app;
