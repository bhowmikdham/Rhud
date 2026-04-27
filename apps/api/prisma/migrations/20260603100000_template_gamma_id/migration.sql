-- Per-template Gamma template id. Proposal drafting passes this to
-- Gamma's Generate API so the produced deck inherits the template's
-- layout/theme. Null = generic generation, which is the prior behaviour.
ALTER TABLE templates
  ADD COLUMN IF NOT EXISTS gamma_template_id TEXT;
