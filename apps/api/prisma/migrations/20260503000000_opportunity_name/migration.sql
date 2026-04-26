-- Add a free-text "name" so the sales team can call an engagement
-- something memorable ("Acme Q3 Security Assessment") rather than a UUID.
-- We keep the table name `engagements` for now — a deeper rename touches
-- dozens of FK columns and tests, deferred to a quiet sprint.
ALTER TABLE engagements
  ADD COLUMN IF NOT EXISTS name TEXT;
