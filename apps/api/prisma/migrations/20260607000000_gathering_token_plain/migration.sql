-- Surface the gathering link on the opportunity detail page.
--
-- Today the plain token is only emitted in the response of POST /opportunities
-- (the issuance flow). The DB only keeps an argon2id hash for verification,
-- so once the rep navigates away from the wizard the URL is unrecoverable.
--
-- Sales teams need to look the URL up later — copy it into a chat message,
-- forward it to a teammate, etc. We store the plain token alongside the
-- hash. Trade-off accepted: a DB compromise leaks active tokens. Mitigations:
-- single-use + 7-day expiry already cap the blast radius, and revoking via
-- the existing revokedAt path stays effective.
ALTER TABLE "gathering_tokens"
  ADD COLUMN "token_plain" TEXT;
