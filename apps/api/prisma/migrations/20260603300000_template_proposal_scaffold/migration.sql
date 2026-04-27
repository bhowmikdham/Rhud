-- Per-template proposal scaffold (Markdown + merge tokens). Lets the
-- consultancy lock down boilerplate so only dynamic parts (price,
-- client name, scope summary) vary per opportunity.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS proposal_scaffold TEXT;
