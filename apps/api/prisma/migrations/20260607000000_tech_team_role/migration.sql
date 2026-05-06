-- New role: `tech_team`. The tech team can adjust the predicted price
-- before it goes to the sales manager for approval. They have no other
-- controls (no approve, no reject, no revert).
--
-- Adjustments are recorded on the engagement_quotes row (one per
-- engagement) plus a `price_tech_adjusted` thread event for audit. The
-- adjustment is bound to a specific prediction so a re-predict makes
-- the prior adjustment stale (the manager UI hides it).

-- ── 1. Extend role CHECK constraints on users + invites ──────────────────────
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_role_check
    CHECK (role IN ('admin', 'sales_manager', 'sales_employee', 'tech_team'));

ALTER TABLE invites
  DROP CONSTRAINT IF EXISTS invites_role_check;
ALTER TABLE invites
  ADD CONSTRAINT invites_role_check
    CHECK (role IN ('admin', 'sales_manager', 'sales_employee', 'tech_team'));

-- ── 2. Add `price_tech_adjusted` to thread_events whitelist ─────────────────
ALTER TABLE thread_events
  DROP CONSTRAINT IF EXISTS thread_events_event_type_check;
ALTER TABLE thread_events
  ADD CONSTRAINT thread_events_event_type_check
    CHECK (event_type IN (
      'link_issued','link_opened','node_answered','file_uploaded',
      'scope_submitted','price_predicted','price_tech_adjusted',
      'approval_requested',
      'approval_granted','approval_adjusted','approval_rejected',
      'approval_reverted',
      'proposal_draft_requested','proposal_draft_ready','proposal_sent',
      'engagement_synced','engagement_closed',
      'quote_computed','quote_approved'
    ));

-- ── 3. Tech-adjustment columns on engagement_quotes ──────────────────────────
ALTER TABLE engagement_quotes
  ADD COLUMN tech_adjusted_price_cents BIGINT,
  ADD COLUMN tech_adjusted_at          TIMESTAMPTZ,
  ADD COLUMN tech_adjusted_by          UUID,
  ADD COLUMN tech_adjustment_note      TEXT,
  -- Bound to a specific prediction so a re-predict stales the adjustment.
  -- No FK — predictions live in the same tenant and the FK adds little
  -- beyond the tenant_id/RLS isolation already covering both rows.
  ADD COLUMN tech_adjusted_prediction_id UUID;
