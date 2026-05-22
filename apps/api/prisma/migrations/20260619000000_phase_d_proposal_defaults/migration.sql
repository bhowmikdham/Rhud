-- Phase D — tenant proposal defaults JSONB.
--
-- Holds the boilerplate sections that go into every generated DOCX
-- proposal but don't vary per-engagement: methodology + tools per
-- category, generic team-details block, and tenant-wide terms &
-- conditions. The DOCX renderer reads this column at render time
-- and substitutes per-category strings based on the engagement's
-- categorySlug.
--
-- Shape (validated server-side; column is plain JSONB so future
-- additions don't require a migration):
--   {
--     "methodologyByCategory": { "vapt": "...", "grc": "...", ... },
--     "toolsByCategory":       { "vapt": "Burp Suite Pro, Nessus, ...", ... },
--     "teamDetails":           "We're a 12-person team based in ...",
--     "termsConditions":       "1. Payment terms ... 2. ..."
--   }

ALTER TABLE tenants
  ADD COLUMN proposal_defaults jsonb NOT NULL DEFAULT '{}'::jsonb;
