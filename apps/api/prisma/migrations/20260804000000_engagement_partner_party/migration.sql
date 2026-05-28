-- Partner / distributor party on an opportunity.
--
-- Forwarded RFPs often come THROUGH an intermediary: an external reseller
-- or distributor forwards the scope on behalf of the real end client. The
-- LLM extraction now separates that intermediary from (a) the end client
-- and (b) an internal colleague who merely forwarded the mail. We capture
-- it here so the rep can record who's brokering the deal.
--
-- All nullable — most opportunities have no partner. partner_role is
-- constrained to the two roles the product offers today.

ALTER TABLE engagements
  ADD COLUMN partner_company text,
  ADD COLUMN partner_contact text,
  ADD COLUMN partner_email   text,
  ADD COLUMN partner_role    text;

-- Role whitelist. NULL allowed (no partner). Extend this list + the
-- add-in dropdown together when new roles are introduced.
ALTER TABLE engagements
  ADD CONSTRAINT engagements_partner_role_check
    CHECK (partner_role IS NULL OR partner_role IN ('partner', 'distributor'));
