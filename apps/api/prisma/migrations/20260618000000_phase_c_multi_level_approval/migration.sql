-- Phase C — full client metadata + multi-level approval (PM stages 1 + 5).
--
-- Three changes:
--   1. Engagements gain four client-info columns the PM wants captured
--      at issuance / editable post-issuance.
--   2. Two new roles (vp_sales, ceo) added to users + invites role
--      whitelists. They're orthogonal to the existing roles — admin
--      stays the top-level superuser; vp_sales + ceo are escalation
--      tiers for approval workflow.
--   3. Tenant approval thresholds + new engagement status values
--      gate the existing approve() flow: above the VP threshold,
--      sales_manager approval no longer flips status → 'approved'
--      directly; instead, status → 'pending_vp_approval' (or
--      'pending_ceo_approval' for higher) and a VP/CEO has to
--      green-light it via the new final-approve endpoint.

-- ── 1. Client metadata columns on engagements ────────────────────────

ALTER TABLE engagements
  ADD COLUMN client_name    text,
  ADD COLUMN client_address text,
  ADD COLUMN contact_name   text,
  ADD COLUMN contact_phone  text;

-- ── 2. Extend users + invites role whitelist ────────────────────────

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'sales_manager', 'sales_employee', 'tech_team', 'vp_sales', 'ceo'));

ALTER TABLE invites DROP CONSTRAINT IF EXISTS invites_role_check;
ALTER TABLE invites
  ADD CONSTRAINT invites_role_check
    CHECK (role IN ('admin', 'sales_manager', 'sales_employee', 'tech_team', 'vp_sales', 'ceo'));

-- ── 3. Tenant approval thresholds ───────────────────────────────────
-- Cents value above which the corresponding role's approval is
-- required. NULL = threshold disabled (everything flows through
-- sales_manager → approved). Sensible defaults: NULL/NULL ⇒ existing
-- behaviour preserved for current tenants.

ALTER TABLE tenants
  ADD COLUMN requires_vp_approval_above_cents  bigint,
  ADD COLUMN requires_ceo_approval_above_cents bigint;

-- ── 4. Engagement status whitelist — new pending-* states ──────────

ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_status_check;
ALTER TABLE engagements
  ADD CONSTRAINT engagements_status_check
    CHECK (status IN (
      'issued','in_progress','submitted','predicted',
      'pending_approval','approved',
      'drafting','draft_ready','sent','closed','rejected','expired',
      'returned_to_sales','awaiting_clarification','escalated',
      -- Phase C additions:
      'pending_vp_approval',   -- sales_manager approved but price > VP threshold
      'pending_ceo_approval'   -- sales_manager approved but price > CEO threshold
    ));

-- ── 5. Thread event whitelist — multi-level approval events ────────

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
      -- Phase C additions:
      -- final_approval_requested: sales_manager approved, but threshold
      --   bumped it into VP/CEO escalation. Payload includes the level.
      -- final_approval_granted: VP or CEO greenlit the gated approval.
      -- final_approval_rejected: VP or CEO rejected; status → 'rejected'.
      'final_approval_requested',
      'final_approval_granted',
      'final_approval_rejected'
    ));
