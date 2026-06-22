# RHUD full-map audit — open findings (2026-06-22)

Run wf_c9f4eb6c-fe4 · 11/11 subsystem maps · 57 raw → **18 confirmed**, 3 disputed, 36 refuted.
Deduped vs prior audit + memory. Excludes already-shipped: Gemini seed/structured-output, thinking-budget truncation, JSON repair, image extraction. Prod @ f7bed8d.

Severity from adversarial verify (real/refuted votes). Tiers: 1=document→scope/extraction, 2=pricing, 3=everything else.

## Progress (step-wise fix loop)
- ✅ **Tier 1 (document → scope)** — SHIPPED `08d61e0` + scope deep-dive (run wf_708ab552-4b7).
  Prompt-injection guard on doc+image extraction; integer scope (parseNumber + LLM scopeValue).
  The deep-dive's other 6 "bugs" were rejected after code-verify (would regress: false-positive
  "inverted" filter, under-counting 60-caps, repairedWhole revert) or deferred (narrow/risky:
  scope-graph consumed-API, appId dedup, heuristic tiebreak — need live multi-app fixtures).
- ✅ **Tier 2 (pricing)** — SHIPPED `05f150e`. Live % discounts (effectiveLineItemCents),
  NaN-proof scope kernel (safeScope), Odoo money inverse (currency_to_cents + pull-skip).
- ⏳ **Tier 3 (everything else)** — NOT STARTED. HIGH cluster (sendViaOutlook double-send, gamma
  double-bill, sent→approved demote, S3 orphan-on-delete, Odoo no-timeout, setOutcome ignores
  return, LLM_KEY_ENCRYPTION_KEY no boot-enforce) + MED/LOW. Prod @ 05f150e.


## Tier 1 — Document → scope / extraction

- [ ] **[HIGH]** Document- and image-extraction prompts have no prompt-injection guard, unlike the email path — untrusted client content is fed raw with no "ignore embedded instructions" instruction
  - `apps/api/src/extraction/extraction.service.ts:122 (image prompt) and :1010 (doc prompt)` · llm-robustness · votes real=2/ref=0
  - **Fix:** Add the same untrusted-data framing to both extraction system prompts (wrap the document text in a delimiter and instruct the model to never obey instructions found inside the document/image), matching the email extractor.

## Tier 2 — Pricing

- [ ] **[HIGH]** Percentage-based discounts go stale after a re-quote — stored cents are never recomputed against the new base
  - `apps/api/src/pricing/quote-line-items.service.ts:116-119,51-58` · money-correctness · votes real=2/ref=0
  - **Fix:** In `getBreakdown` and the approval fold, when `percentageBps != null` recompute `amountCents` from the current `baseTotalCents` instead of trusting the stored cents; or re-derive all percentage line items inside `computeAndPersist` after writing the new base.
- [ ] **[MEDIUM]** `cents_to_currency` has no inverse — any pull/both money mapping divides an already-in-currency Odoo value by 100
  - `apps/api/src/integrations/odoo/odoo.mapping.ts:96-100` · money-correctness · votes real=1/ref=0
  - **Fix:** Add a `currency_to_cents` transform (`Math.round(Number(value) * 100)`) and make `cents_to_currency` reject/skip on pull rows, or have the mapping compiler forbid `cents_to_currency` on non-push directions.
- [ ] **[MEDIUM]** `QuoteEntityDto.dimensions` validated only with `@IsObject()` — non-number values reach pricing arithmetic as NaN / mis-bracketed prices
  - `apps/api/src/pricing/dto.ts:123` · validation · votes real=1/ref=0
  - **Fix:** Replace `@IsObject()` with a validated nested type or `@IsNumber({}, { each: true })` over values (e.g. validate `dimensions` as a class with known numeric keys, or guard `Number.isFinite(scopeValue)` in `computeQuote` before `pickTier`).

## Tier 3 — Everything else

- [ ] **[HIGH]** sendViaOutlook double-sends a real client email — `already_sent` guard read is in a separate transaction before the irreversible Outlook send
  - `apps/api/src/llm/proposal-draft.service.ts:697-804` · concurrency · votes real=2/ref=0
  - **Fix:** Atomically claim before sending: `const { count } = await db.engagement.updateMany({ where: { id, status: { not: 'sent' } }, data: { status: 'sending' } });` and proceed only when `count === 1`; on `sendMail` failure roll the claim back. This makes the duplicate send a no-op.
- [ ] **[HIGH]** generateViaGamma spends Gamma credits before any atomic status claim — double-click double-bills and orphans a deck
  - `apps/api/src/llm/proposal-draft.service.ts:368-433 (kickoff at 406) and 227-252` · concurrency · votes real=2/ref=0
  - **Fix:** Claim status atomically FIRST (`updateMany ... status->'drafting'`, proceed only if `count===1`), then call `startDraftFromBrief`, then persist `gammaGenerationId`; on kickoff failure roll status back via the existing `rollbackToApproved`.
- [ ] **[HIGH]** LLM re-draft failure silently demotes a `sent` (or `draft_ready`) proposal to `approved`
  - `apps/api/src/llm/proposal-draft.service.ts:340,346 (rollbackToApproved at 1119-1128)` · gamma-branch · votes real=2/ref=0
  - **Fix:** Capture the pre-flip status (or pass it into the rollback) and restore that exact status on failure, e.g. `rollbackTo(tenantId, engagementId, ctx.status)` doing `updateMany({ where: { id, status: 'drafting' }, data: { status: priorStatus } })`, instead of hardcoding `'approved'`.
- [ ] **[HIGH]** Hard-deleting an engagement orphans every S3 object it owned — no storage reclaim on delete
  - `apps/api/src/engagements/engagements.service.ts:500-508` · ingestion-storage · votes real=2/ref=0
  - **Fix:** In `remove()`, before the DB delete, collect distinct `s3Key`s (or sweep `engagements/<tid>/<eid>/`) and call `s3.deleteByPrefix` post-commit, best-effort. Note text/email artifact keys live under `ingestion/<tid>/<artifactId>/` so an engagement-prefix sweep alone misses them — delete by collected keys.
- [ ] **[HIGH]** XML-RPC client has no request timeout; a hung Odoo wedges request threads on every sync endpoint
  - `apps/api/src/integrations/odoo/odoo.client.ts:215-262` · odoo-sync · votes real=2/ref=0
  - **Fix:** Wrap each `fetch` in `AbortSignal.timeout(ms)` (e.g. 15-20s) and map the abort to `OdooApiError('timeout', ...)`; thread the timeout through both the initial and retry calls.
- [ ] **[HIGH]** setOutcome treats any non-throwing action_set_won/action_set_lost as success without checking the return value
  - `apps/api/src/integrations/odoo/odoo.service.ts:870-891` · odoo-sync · votes real=2/ref=0
  - **Fix:** Inspect the `callAction` result: treat `false`/an unexpected action-dict as a failure (`writeLog status:'error'`, throw), and re-read the lead's `stage_id`/`probability` to assert the transition actually applied before reporting `ok`.
- [ ] **[HIGH]** LLM_KEY_ENCRYPTION_KEY has no boot-time prod enforcement — failure is deferred and silent until first key write
  - `apps/api/src/config/env.ts:24` · secrets-config · votes real=2/ref=0
  - **Fix:** Add to the env.ts superRefine: `if (env.NODE_ENV === 'production' && !env.LLM_KEY_ENCRYPTION_KEY) ctx.addIssue({ path:['LLM_KEY_ENCRYPTION_KEY'], message:'required in production' })` so boot fails fast and visibly.
- [ ] **[MEDIUM]** processPendingWebhooks has no atomic claim — concurrent runs double-apply pull-mappings and double-emit events
  - `apps/api/src/integrations/odoo/odoo.service.ts:1092-1138` · concurrency · votes real=1/ref=0
  - **Fix:** Claim each event atomically before processing: `const { count } = await db.odooWebhookEvent.updateMany({ where: { id: ev.id, status: 'pending' }, data: { status: 'processing' } });` and skip when `count === 0`; or claim the whole batch with a single guarded `updateMany` returning the claimed ids.
- [ ] **[MEDIUM]** `winProbability` is populated from band-derived `confidence`, which is a near-constant (≈0.85) for the real-model path, not a win probability
  - `apps/api/src/ml/ml.service.ts:84-86 (and apps/ml/rhud_ml/predict.py:161)` · ml-contract · votes real=1/ref=0
  - **Fix:** Either derive `winProbability` from real signal (historical win rate at this price band) or stop mapping `confidence`→`winProbability`; at minimum rename to `modelConfidence` and don't present it as a win probability.
- [ ] **[MEDIUM]** Polling refresh paints a permanent error banner on a single transient tick and never clears it on recovery
  - `apps/web/src/app/opportunities/[id]/proposal/proposal-workspace.tsx:100-117` · web-state · votes real=1/ref=0
  - **Fix:** Add `setErr(null)` at the top of each polling `refresh` success path (right before/after `setCurrent`/`setFiles`/`setState`), so a recovered poll clears the stale banner.
- [ ] **[LOW]** Concurrent create/update of a default Gamma template races the partial-unique index → raw P2002 500
  - `apps/api/src/gamma/gamma-template.service.ts:111-124, 153-157` · concurrency · votes real=1/ref=0
  - **Fix:** Wrap the create/update in a serializable transaction or catch P2002 on the default-unique index and retry/return 409; alternatively elect the default via a single guarded `updateMany` that also clears others in the same statement.

Notes: I deliberately did NOT re-report the deferred `settleAndMaybePredict` double-fire (concurrency-1/-2), the documented predict 3-transaction race (pricing-quotes-4
- [ ] **[LOW]** Public `/g/:token` answer submission has no length/array-size cap on `answer` — unbounded string/array persisted to JSONB
  - `apps/api/src/gathering/dto.ts:13` · validation · votes real=1/ref=0
  - **Fix:** Add length/size caps in `validateAnswerShape` (e.g. cap string length ~16KB and `multi_select` array length/element length), returning a precise `reason` like the existing shape errors.
- [ ] **[LOW]** downloadPdf maps an expired-token 401 to the same "PDF unavailable" message as a real missing PDF
  - `apps/web/src/lib/api.ts:1401-1418` · web-state · votes real=1/ref=0
  - **Fix:** Branch on `res.status === 401` (signal re-auth, e.g. throw an ApiError the caller maps to "sign in again") and reserve the "PDF unavailable" copy for 404/410.
- [ ] **[NIT]** Archived-status rendering in the templates panel is dead code — `list()` only returns active rows
  - `apps/web/src/app/integrations/gamma/gamma-templates-panel.tsx:209,235,255 (and service list at gamma-template.service.ts:59-67)` · gamma-branch · votes real=1/ref=0
  - **Fix:** Either drop the archived-status branches (they are unreachable), or add an "include archived" toggle that calls a list variant returning archived rows plus an un-archive action, matching the rendered affordances.

Notes on scope checked and deliberately NOT re-reported (already in docs/architecture-debug-report.md): `pickUrl` open value-scan and the unsanitized gamma deck URL → iframe/email (templ

## Disputed (judgment call / partial-dup)

- **[HIGH]** Public /g/:token can write answers/files to ANY tenant templateNode, not just its engagement's template (cross-template object-level authz gap) — `apps/api/src/gathering/gathering.service.ts:505`
- **[HIGH]** Ticket/follow-up/AI-summary write endpoints have NO @Roles — every role (incl. tech_team, vp_sales, ceo) can mutate any engagement's lead-mgmt data — `apps/api/src/lead-management/lead-management.controller.ts:93`
- **[HIGH]** Vision/text extraction ignores finishReason='length'; truncated LLM output is silently accepted as a partial point list — `apps/api/src/extraction/extraction.service.ts:1196 (call) and :1298 (parse), :1086 (chunked swallow)`