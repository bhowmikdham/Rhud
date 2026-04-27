-- Cache Gamma's PDF export URL for the current proposal draft, plus
-- an approximate expiry timestamp (Gamma export URLs lapse after ~7
-- days per the public docs).

ALTER TABLE engagements
  ADD COLUMN proposal_pdf_url        text,
  ADD COLUMN proposal_pdf_expires_at timestamptz;
