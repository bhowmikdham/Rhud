-- Persist AI-generated proposal drafts on the engagement. One draft at
-- a time — regenerate overwrites. Status flips approved → drafting →
-- draft_ready → sent as the rep moves through the lifecycle.
ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS proposal_draft         TEXT,
  ADD COLUMN IF NOT EXISTS proposal_drafted_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS proposal_draft_source  TEXT;
