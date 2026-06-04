# The Future of Rhud

*A strategy document whose north star is bettering the daily working lives of the professionals who use it.*

---

## 1. The thesis

Rhud should become the system where **work finds the right person at the right moment, already explained** — instead of people hunting for work and reconstructing context by hand. The substrate is already built: a login-less decision-tree scoping engine, per-tenant XGBoost pricing, a threshold-gated approval ladder, and an append-only SHA-256 audit chain. But its highest-leverage edges are cut. Nothing pushes "the client answered." Nothing surfaces the exec's gated deals. The ML number computed when scope settles is written to a row nobody reads. The audit chain is never sealed on a schedule.

Wiring those dark edges turns Rhud from a place people *check* into a place that *tells them*. The change is not a new product; it is lighting up the one already in the repo. Concretely, it replaces five recurring frustrations — the rep's all-day refresh, the manager's one-deal-at-a-time triage, the reviewer's four-surface scavenger hunt, the exec's invisible queue, and the client's post-submit silence — each with a specific, observable before→after grounded in a file that already exists.

---

## 2. The professionals, and how each day gets better

### The sales rep (`sales_employee`)

**Today:** An RFP lands at 9am. She opens `/opportunities/new`, drops the PDF — sometimes it stalls on a silent `s3_put_403` "Failed" row with no retry, so she re-drops. She issues the link, tries to copy the once-shown `/g/[token]` URL (clipboard says "Copied" but pastes nothing — a verified bug), pastes it into a reply. Then she waits. There is **no poll or notification for client scope submission** (verified: zero `setInterval`/`EventSource` on `opportunities/[id]/page.tsx`), so she reloads the opportunity by hand all day. Her biggest time sink, verbatim: *manually refreshing to find out whether the client submitted scope yet.*

**Before → after:** Today she reloads the page ~30 times a day to learn a binary fact (did the client submit?). Tomorrow she issues one link and gets pushed four events — `link_opened`, an answer milestone, `scope_submitted`, `price_predicted` — over a **deal heartbeat** fed by events `gathering.service.ts` *already emits* (`link_opened` at lines 201/221, `scope_submitted` at 960). The single anxiety we remove: the deal-going-cold dread of not knowing. At 9am the **Deal Warden** surfaces the deals that went quiet overnight with a pre-drafted nudge — and the nudge is grounded, not free-narrated: the gathering loop persists `loopState` (cursor node) plus per-iteration answers, so the path is *cursor node → first unanswered rate-card slug → templated sentence* ("you scoped the Web App but not the API line — pick up here?"). No LLM invents the content; it fills a template from the answer cursor. Upload failures retry inline with plain errors; copy-link gets a manual-select fallback.

### The sales manager (`sales_manager`)

**Today:** Mira lands on a dashboard band — "3 approvals waiting on you" — that filters to `e.status === 'pending_approval'` only (`dashboard/page.tsx:46`). No dedicated queue, no sort; she opens each deal one at a time. The dashboard never live-polls, so new approvals appear only on manual reload. When she approves, *every tier button spins at once* (shared busy flag), and on VP/CEO-gated deals two conflicting approval cards render with two Reject buttons.

**Before → after:** Today she triages whole deals one-by-one off a count, reloading to see new ones. Tomorrow she opens `/queue` — one self-updating, role-scoped list, draining as she clears it — ranked by **value × age × confidence-band-width**, where every term is a real field: value is deal size, age is `now − thread-event timestamp`, and band-width is `(bandHighCents − bandLowCents) / predictedPriceCents` from the prediction row (a wide band = a deal worth her eyes; "risk" is not an undefined ranking dimension, it is band width). The double-card bug is gone, per-tier feedback is fixed, and the queue updates without reload.

**The honest caveat, front-loaded:** the **Approval Co-pilot brief** on each row has two halves with very different maturity. The *drafted rationale* — "in-band with the rate-card ledger; the API line runs hot vs. its base" — is near-term, composed from the `drivers` already persisted on the prediction row. The *win-rate overlay* — "you win 78% at recommended / 41% at aggressive (n=23)" — is **not** something Mira will see in year one if she runs the seed vertical. A ~5-deal/month VAPT shop sits below `MIN_TRAIN=20` for a quarter-plus; until then there is no win-rate to aggregate and the model returns a median-based heuristic (see §6). So tomorrow's manager gets a real *rationale* now and a real *win-rate band* only once her own closed-deal corpus is deep enough — and the brief says so, with an honest `n`, rather than implying the 78% is shipping.

### The technical reviewer (`tech_team`)

**Today:** A deal lands at `pending_approval`. To verify scope, set price, and write terms, he hops **four un-labelled surfaces** in a ~12-card stacked pane: per-line scope/methodology inside the extraction card, discovered endpoints in Scope evidence, travel/discount in the dead-last `QuoteLineItemsCard`, and the whole-deal override buried *inside the approval card* (`techAdjust` — one number for the entire quote; verified the only override columns are `techAdjusted*`, there is no `linePriceOverrides`). Every edit pops the `RepredictBanner` → he clicks Re-predict → babysits the ML round-trip → scrolls back up, sometimes to find a re-predict silently nuked his adjustment. He retypes assumptions/exclusions/timeline free-hand every deal. His biggest time sink: *hopping four un-labelled surfaces and re-typing the same scope judgement deal after deal.*

**Before → after:** Today a single price change costs him a banner, a manual re-predict click, a round-trip wait, and a scroll — and can silently erase the adjustment he just made. Tomorrow one **Price Workbench** (the shipped Focus Pane v2 `ScopePricingTable` promoted to the single screen): hero number on top; one table where each line shows scope, methodology, the ML hint, and an **inline editable price** (this lands the *missing* `linePriceOverrides` column and a new `price_line_overridden` event — both verified absent today). Inline edits **reprice silently in place** via the existing `extraction.overrideEntity → reprice` path, and his lodged override is preserved across the re-predict — the exact failure removed. Assumptions/exclusions/timeline pull from **reusable per-slug snippets** mined from his own won deals. One decision bar, one Approve, no scroll. (Per-line *comparables* are deliberately not promised here — see the comparables note in §3.)

### The exec approver (`vp_sales` / `ceo`)

**Today:** Priya's queue is **invisible**. The dashboard band counts only `pending_approval`; her gates (`pending_vp_approval`, `pending_ceo_approval`) are not a band, a stage, or a count. Worse, `final_approval_requested` routing never reaches her: the email layer's `recipientRole` type is hardcoded to `'sales_employee' | 'sales_manager' | 'client'` (`email.templates.ts:20`) — `vp_sales`/`ceo` are not even valid recipient types — so the person who must sign is never pinged. She learns of a six-figure deal only via a Slack ping from the rep or by scrolling the opportunities list. CEO-gated deals stall silently while the CEO travels.

**Before → after:** Today she finds out a deal needs her signature by accident, after it has already sat. Tomorrow the instant a deal crosses her threshold she gets a notification routed *to her role* — which requires a net-new addition to the `recipientRole` type and an email-resolution path for exec recipients (this is the real work behind the "S," not a one-line array push). Her **"waiting on YOU" queue** shows exactly her gated deals, oldest-and-largest first. Email and the in-app queue are near-term. The **one-tap Slack/mobile approve is explicitly the heaviest, later part** of this bundle: the `routes` JSONB reserves the channel, but interactive Block Kit callbacks plus request-signature verification are fiddly M/L work, not a quick win — her exec experience improves *first* through the queue and email, and only later through mobile one-tap.

### The client buyer (tokenised, no login)

**Today:** A clean login-less card prefills scope from their uploaded doc (a real moment of delight), walks the decision tree, then Submit warns "Submitting locks the link — you won't be able to edit." They confirm, see "Scope received — your rep will come back within 24 hours," and then: **silence.** No tracking. They refresh email until a proposal arrives. And if the rep's copy-link silently failed, they got a dead link.

**Before → after:** Today, after Submit the client is in a black box and refreshes email. Tomorrow the *same trusted token* becomes a live status page driven by the audit thread. The single anxiety removed: post-submit dead-air. Because the page is **login-less and device-bound — anyone holding the link can open it** — the status mapping is an explicit allow-list, not the raw lifecycle:

| Internal state | Client sees | Redacted |
|---|---|---|
| `scope_submitted` | "Scope received" | — |
| `price_predicted`, pricing edits, internal margins, exact pre-send price | "Pricing your quote" | all prices and margins |
| `pending_*_approval`, who rejected, rejection reasons | "Under review" | approver identity, reasons, gate level |
| `drafting` / proposal sent | "Proposal on its way" | — |

So the buyer sees *coarse progress*, never a price before it is formally sent, never an internal margin, never which exec rejected or why. The link also stays **editable until a human picks it up** (lock only past `predicted`, not at Submit), removing the "Submitting locks the link" anxiety. A "what we read vs. what you told us" panel from `buildScopeSummary` and a "cryptographically sealed, reference a1b2c3…" trust seal turn the black box into an observable, forwardable receipt.

---

## 3. The 3–5 strategic bets

> **Comparables note (applies to every bet below).** `similarPast` is persisted **empty** today — `prediction.service.ts:192` writes `similarPast: []` and the read at `:283` returns that empty array. So "top-K comparables" is **not a shippable surface** on any approval card, Slack card, reviewer view, or Co-pilot brief until persistence is built. It is therefore carved out as its own line item (roadmap LATER, "populate `similarPast`"), gated behind the prediction loop, and is **not** claimed as a NOW/NEXT deliverable anywhere in this document.

### Bet 1 — The Deal Nervous System: nothing waits unseen

**The bet:** Wire the dark notification and live-update edges so every stakeholder is *pushed* their exact next action — the rep's deal heartbeat, the role-aware "waiting on YOU" queue, the exec gate-push, and the client status page — all projected off the append-only `thread_events` spine that already records every transition.

**Professional payoff:** Kills the rep's all-day refresh, the manager's one-by-one triage, the exec's invisible queue, and the client's post-submit dead-air — the single most-cited pain of *four of five personas* at once.

**Why it compounds / is defensible:** Because Rhud runs the *client's* login-less decision-tree walk server-side (`gathering.service.ts` persists `loopState` + per-iteration answers), it can surface "client answered 6 of 18" — a signal a tool without a tokenised client-side gathering engine simply does not have. Age-in-gate and "who is blocking" are *exact*, computed from timestamped thread events. Note: this bet ships **coarse progress signals**, never the internal price or margin, to the device-bound client link (see the §2 allow-list).

**Bundles:** Deal heartbeat · "waiting on YOU" queue · exec gate-push (email/queue near-term; Slack one-tap later) · Deal Warden cold-deal watcher · login-less client status page.

### Bet 2 — Close the Prediction Loop (a higher-volume-tenant bet)

**The crux, stated first:** there are **two divergent prediction writers today, and one of them is silently discarded** — a correctness bug, not just an unwired feature. When scope settles, `gathering.service.ts:1009` fires `ml.predictForEngagement`, which writes `predictedPriceCents` onto the **engagement row** (`ml.service.ts:72/81`). But the approval path reads the **prediction row** that `prediction.service.ts` writes. So an ML number is being computed and thrown away right now; the manager never sees it. Before any retraining is layered on top, the loop must **reconcile which row is authoritative** — this reconciliation is the hard, risky core of the bet (rated L precisely because of it), not a parenthetical "flip the cascade."

**The bet:** Reconcile the two writers; then flip the regime cascade to dispatch into the per-tenant XGBoost (`apps/ml/rhud_ml/predict.py`) for `linear`/`boosted`, wire `markOutcome` to enqueue a retrain, and surface SHAP drivers + quantile bands inline on the approval card.

**The honest scope of the moat:** Bet 2's XGBoost flywheel **visibly compounds only for higher-volume tenants**. The seed vertical — a low-volume VAPT shop under `MIN_TRAIN=20` — will *not* feel a tightening band in year one; for them the near-term value is the **rules cascade** (`computeBasePrice` ledger + regime composition) and, later, comparables — *not* the learned model. This bet is sold as a higher-volume play, not a universal one.

**Professional payoff:** For higher-volume tenants, Mira stops approving against a "watch the band" blurb and starts seeing a win-rate band backed by *her firm's own* closed deals, behind an honest `n`. For everyone, fixing the discarded-write bug means the ML number that already exists stops vanishing.

**Why it compounds / is defensible:** the per-tenant corpus lives inside the RLS boundary and trains only that tenant's model. A competitor starting fresh has no data to copy — but this is a moat that *accrues with volume*, and the document does not pretend otherwise.

**Bundles:** Reconcile the two prediction writers (do this first) · wire XGBoost into the approval path · drafted rationale on the card (near-term) · win-rate-at-this-price overlay (depends on outcome aggregation, later) · quantile bands + SHAP drivers.

### Bet 3 — The Price Workbench: one screen, one judgement, no stale wait

**The bet:** Promote the shipped Focus Pane v2 `ScopePricingTable` into the single "Price this quote" workbench — inline per-line price override (the *missing* `linePriceOverrides` column + a new `price_line_overridden` event), silent debounced auto-reprice that preserves lodged overrides, and reusable per-slug assumption/exclusion/methodology snippets mined from won deals.

**Professional payoff:** Collapses the reviewer's four-surface scavenger hunt and stale-number babysit into one calm pass; his hardest-won scoping judgement stops evaporating after each deal, and his lodged override stops getting nuked by re-predict.

**Why it compounds / is defensible:** This is **institutional scoping memory** — snippets keyed to rate-card slugs, captured and reused on the same per-tenant corpus. A generic CPQ lets you edit a line price; it cannot auto-reprice against a per-tenant model and a provenanced `computeBasePrice` ledger, nor record every override as an audit event. Per-slug *comparables* are deferred to the comparables line item (they need `similarPast` populated and the ML path live).

**Bundles:** Price Workbench de-stack · inline per-line price + silent reprice · reusable scoping snippets · per-slug history hints (after comparables persistence lands).

### Bet 4 — Seal & Prove: the audit chain becomes a closing line

**The bet:** Register the missing `ScheduleModule`, add a nightly `@Cron` that calls the already-built `AuditService.build()`, then — as a *separate, later* step — mirror the rootHash to S3 Object-Lock (populating the dormant `mirroredS3Key`), and ship a one-click per-engagement evidence pack + client-facing seal.

**The honest threat-model scope:** **until the WORM anchor lands, the nightly seal proves app-level integrity only — that the application code did not tamper with the chain. It does not prevent a DB superuser from rewriting history**, which is the exact threat the file's own comment names. The off-DB anchor is also the *riskiest infra*: Object-Lock COMPLIANCE mode is irreversible, and it needs bucket configuration the EC2 role may lack (the role already lacked `PutBucketCORS`, requiring Console intervention). So the closing-line rhetoric is scoped: today's deliverable is "app-level tamper-evidence, sealed nightly"; "provably immune to DB-superuser tampering" is the *later* WORM milestone, not what ships first.

**Professional payoff:** The compliance officer answers "prove this ₹X quote history wasn't altered at the application layer" with a standing green badge instead of a hand-run endpoint; once the anchor lands, that proof extends to DB-superuser tampering and becomes a six-figure-dispute evidence pack and a forwardable client receipt.

**Why it compounds / is defensible:** the SHA-256 hash-chain (`audit.service.ts` build/verify, GENESIS root, canonical JSON) is structurally impossible to retrofit onto a mutable-quote data model. For the seed vertical — security firms selling to security buyers — that structural property is the closing line. ~80% built; the seal cron, the WORM anchor, and the export surface are what remain.

**Bundles:** nightly chain seal (app-level) · WORM anchor (later; DB-superuser coverage) · compliance evidence pack · `[Price changes]` money-trail filter · client provenance receipt.

---

## 4. The roadmap

**Hard sequencing constraint:** four scheduled jobs in this roadmap — nightly chain seal, Deal Warden, SLA timers, and the follow-up digest — are **the same missing `@Cron` wearing different hats.** A naive per-tenant sweep on the t3.small box has no job queue, no idempotency, no retry. Therefore the **Scheduler foundation is the first NOW item and a blocker for all four.** Do not budget them as independent builds.

| Direction | Persona | Day-impact | Effort | Feasibility note (real files) |
|---|---|---|---|---|
| **NOW (0–3mo)** | | | | |
| **Scheduler foundation** — register `ScheduleModule`; back per-tenant sweeps with the present BullMQ/Redis for idempotency + retry | platform | High | M | No `@Cron` exists anywhere (verified); blocks chain-seal, Deal Warden, SLA timers, follow-up digest |
| Fix the "waiting on YOU" gate band + role-aware `/queue` | exec, manager | High | S→M | One-line band fix `dashboard/page.tsx:46`; states already route in `prediction.controller.ts:283-291` |
| Route `final_approval_requested` to vp_sales/ceo (email) | exec | High | S* | *Net-new: `recipientRole` type is hardcoded to `sales_employee\|sales_manager\|client` (`email.templates.ts:20`); the exec email-FK resolution may not exist → needs a tenant-role-lookup fallback. That FK resolution is the one real risk inside the "S." |
| Deal heartbeat — live activity feed (10s poll over thread) | rep, client | High | M | Events already emitted `gathering.service.ts:201,221,960`; poll v1 before SSE |
| Fix double approval card (two Reject buttons on gated deals) | manager | Med | S | One-condition guard at `page.tsx:476` vs `FinalApprovalCard` at `:466`; preserve approved-sticks at `:486` |
| `[Price changes]` money-trail filter on the audit thread | manager | Med | S | Client-side filter over typed events `thread-events.ts:26-32,105-111` |
| **Reconcile the two prediction writers** (which row is authoritative) | manager | Med | M | Correctness bug: `gathering.service.ts:1009` writes the engagement row; approval reads the prediction row. Fix before Bet 2 retraining lands. |
| Nightly `@Cron` to seal the audit chain (app-level) + verify badge | admin | Med | S | `AuditService.build/verify` done; depends on Scheduler foundation |
| Upload retry + plain-language errors; reliable copy-link | rep, client | Med | S | Verified UX bugs: `s3_put_403` silent fail; clipboard "Copied" pastes nothing |
| `delivery_timeline_override` own event | reviewer, admin | Low | S | Today it `continue`s and emits **nothing** (`engagements.service.ts:716-719`) — invisible to the chain and the money-trail filter |
| **NEXT (3–9mo)** | | | | |
| Close the prediction loop (XGBoost → approval path + retrain) | manager, reviewer | High | L | Crux is the writer reconciliation above; then flip `effectiveRegime` `prediction.service.ts:167`, wire `markOutcome` `engagements.service.ts:739` |
| Approval Co-pilot — **drafted rationale only** (from existing drivers) | manager, exec | High | M | Clone `tryAutoGenerateAfterApproval` hook; reuse persisted `drivers`. **No comparables, no win-rate** here. |
| Win-rate-at-this-price overlay | manager, exec | High | L | Depends on prediction loop + outcome aggregation (`prediction` rows × `markOutcome`); only non-noisy for higher-volume tenants |
| Price Workbench — inline per-line price + silent reprice | reviewer | High | L | New `linePriceOverrides` column + `price_line_overridden` event (verified absent); extends `ScopePricingTable` + `extraction.overrideEntity` |
| Deal Warden — cold-deal watcher + grounded templated nudges | rep | High | M | `FollowUpsService.listUpcomingForTenant:170` exists, nothing fires it; depends on Scheduler foundation; nudge from `loopState` cursor (no LLM free-narration) |
| Reusable scoping snippets (assumptions/exclusions/timeline) | reviewer | Med | M | Mine won-deal thread events; pairs with the timeline own-event fix |
| Login-less client status page + edit-until-reviewed | client, rep | Med | M | Read-only **allow-listed** projection over `thread_events` (see §2 table); `buildScopeSummary` reused |
| SLA timers on holds + auto-nudge + delegate-while-away | exec, rep | Med | M | Time-in-state from `thread_events`; depends on Scheduler foundation |
| **Onboarding completeness HUD** | admin | High | M | Surfaces the four silent-break gaps (no-rule routing, silent auto-classify fail, `inferenceHint=null` rate cards, scope-less direct ingest `extraction.service.ts:178`) as amber-with-Fix before the first real deal |
| **LATER (9–18mo)** | | | | |
| **Populate `similarPast` / persist top-K comparables** | reviewer, manager | High | M | `prediction.service.ts:192` writes `[]`; this unblocks every comparables surface deferred above |
| Quantile-XGBoost bands + real SHAP drivers | reviewer, manager | High | L | Gated on prediction loop; add quantile heads in `apps/ml` |
| WORM S3 Object-Lock anchor + signed per-deal evidence pack | admin, exec | Med | M | Extends app-level seal to DB-superuser coverage; `mirroredS3Key` null by design; Object-Lock COMPLIANCE is irreversible, needs bucket config the EC2 role may lack |
| Permission Profiles + segregation-of-duties (**see §6 note**) | admin | High | M→L | `canEdit` hardcoded literals `page.tsx:621`, `roles.guard.ts`; the enterprise-sales gate for the seed vertical |
| Vertical Packs — clone a whole practice, not just taxonomy | admin | Med | L | `resetFromTemplate` clones only categories `categories.service.ts:301-330`; bundle template + rate card + scaffold |

---

## 5. The flywheel & moat

Rhud gets better with every deal along **three reinforcing loops on the same corpus** — with one honest asymmetry: the loops compound at very different speeds.

- **Pricing flywheel (volume-gated).** Each closed deal (via `markOutcome`) retrains the tenant's own XGBoost; the band tightens and win-rate-at-price sharpens. The corpus lives inside the RLS boundary (`withTenant`/`TenantDb`, `set_config('app.tenant_id',…,true)`) and trains only that tenant's model — a structural claim a shared-schema `org_id` SaaS cannot make. **But this loop only *visibly* compounds for higher-volume tenants**; the seed VAPT shop under `MIN_TRAIN=20` will not feel it in year one (see §6). For that tenant the early compounding comes from the next two loops, not this one.

- **Scoping memory flywheel (compounds from deal one).** Every reviewer override and won-deal assumption becomes a reusable, slug-keyed snippet; the decision tree maps answers → rate-card slugs → price, so each ingest improves per-tenant extraction *and* pricing regardless of channel. This loop needs no volume threshold — the firm's hardest-won judgement compounds from the first won deal instead of evaporating.

- **Trust flywheel (compounds from event one).** Every transition is an INSERT-only, actor-stamped, hash-chained event. The longer a tenant runs, the longer the tamper-evident chain — and the harder to copy, because it is enforced at the *data-model* layer, not bolted onto a mutable log.

**Why it is hard to copy:** A generic CPQ (DealHub, PandaDoc, Odoo quotation) starts *after* scope is known. Rhud *produces* scope from a non-technical buyer login-lessly, prices it with a per-tenant learned model, gates it through a threshold ladder, and seals it cryptographically. To match that, a competitor would have to build the decision-tree engine, the login-less client runtime, doc-extraction prefill, the answer→price mapping, the per-tenant training loop, *and* re-architect their data model for an append-only hash chain. The append-only hash chain in particular cannot be retrofitted onto a mutable-quote data model — it is a foundational decision, not a feature toggle. The moat is the convergence of all of these onto one corpus.

---

## 6. Risks & what could kill it

- **ML cold-start trap (the dominant near-term risk).** A VAPT consultancy doing ~5 deals/month sits below `MIN_TRAIN=20` for a quarter-plus; `predict.py` returns the tenant's own training-set median with a ×0.25 band — a heuristic wearing an ML costume. This is why §2 and §5 explicitly tell the seed-vertical manager she will *not* see a tightening band in year one. **Mitigation:** ship the loop now (the compounding is genuine but slow-burn), gate every win-rate claim behind an honest `n`, and surface "0 of your deals + VAPT baseline, confidence Low, tightens as you close." **Do NOT** synthesize the first 20 deals from `computeBasePrice` — the model would only learn to reproduce the rate card it was seeded from, manufacturing false confidence at the exact approval moment it is meant to help. The strategic admission: **Bet 2 is a higher-volume-tenant bet; for the seed vertical the near-term value is the rules cascade and comparables, not the XGBoost.**

- **Two prediction writers — a correctness bug, not just a gap.** `gathering.service.ts:1009` fires `ml.predictForEngagement`, writing `predictedPriceCents` to the engagement row, while approval reads the prediction row — so an ML number is **computed and silently discarded today**. This must be reconciled (which write is authoritative?) *before* Bet 2 layers retraining on an ambiguous path; otherwise retraining sharpens a number nobody reads. It is in the NOW roadmap for this reason.

- **Over-automation eroding trust.** A confidently-wrong "why this price" or a clumsy nudge at the approval moment is *worse than silence*. **Mitigation:** Deal Warden nudges are always one-click-to-send, never auto-send, and are templated from the `loopState` cursor (not LLM free-narration); the Approval Co-pilot ships *drafted rationale from real drivers only* — comparables and win-rate are withheld until their data actually exists; SLA windows are tunable to avoid notification fatigue.

- **Audit seal proves less than the rhetoric until WORM lands.** The nightly seal proves **app-level** integrity only; a DB superuser can still rewrite history until the off-DB WORM anchor is in place — the exact threat the file's own comment names. **Mitigation:** ship the DB-side seal first and *say* it is app-level; defer the Object-Lock anchor (irreversible COMPLIANCE mode; bucket config the EC2 role may lack) and only then claim DB-superuser tamper-evidence.

- **Access control is hardcoded literals — an enterprise-sales inconsistency.** `canEdit` is hardcoded role literals (`page.tsx:621`, `roles.guard.ts`). Shipping cryptographic audit (Bet 4) while access control stays hardcoded is something a buyer's security team — *the* buyer in the seed vertical — will catch in the first review. **Sequencing rationale:** audit lands before full Permission Profiles because the audit chain is ~80% built and the SoD layer is a net-new guard; but SoD is **High-impact in LATER, not Med**, and is explicitly named the enterprise-sales gate. We cannot sell "provable least-privilege" with no permission layer, so it is the priority promotion candidate the moment a security-buyer deal is in flight.

- **Adoption / onboarding silent-breaks.** New tenants break quietly in four named ways: no-rule routing no-ops, silent auto-classify failure, rate cards with `inferenceHint=null`, scope-less zero-priced direct-ingest deals (`extraction.service.ts:178`). A founder can "finish" setup with three things broken. **Mitigation:** the onboarding completeness HUD — now an actual NEXT roadmap item, not just a sentence here — surfaces these as amber-with-Fix before the first real deal strands.

- **Tenant-isolation & cross-tenant priors.** RLS is a hard wall; pooling *any* signal across tenants breaks the isolation that *is* the moat. **Mitigation:** retrain on the tenant's own deals only; treat vertical priors as a later, opt-in, k-anonymized experiment. Mechanize the rule with a CI lint that fails if any Prisma call escapes `withTenant`.

- **Single-node deploy constraints.** This is why the **Scheduler foundation is one shared build**, not four "agents": one naive per-tenant `@Cron` sweep on t3.small has no queue, no idempotency, no retry, and SSE without a clean reconnection story recreates the stall it removes. **Mitigation:** build the scheduler once, back it with the present BullMQ/Redis, start with 10s polling over the existing thread endpoint before true SSE, and ship the DB-side audit seal before the WORM anchor.

---

## 7. Near-term shippable backlog

Start this sprint. Ordered by day-impact ÷ effort, with the shared-infra blocker first.

1. **Scheduler foundation** — register `ScheduleModule`, back per-tenant sweeps with the existing BullMQ/Redis for idempotency + retry (M, platform). Blocks items 6 and 10, plus Deal Warden and SLA timers. No `@Cron` exists today (verified). Build it once.
2. **Gate-band fix** — change the dashboard filter at `dashboard/page.tsx:46` so `pending_vp_approval`/`pending_ceo_approval` surface for execs (S, exec). Pure read fix; states already route.
3. **Route final-approval to execs (email)** — add `vp_sales`/`ceo` to the `recipientRole` type (currently hardcoded to three roles at `email.templates.ts:20`) and resolve exec emails (S, exec). The one risk inside this "S": the exec email-FK resolution may not exist, forcing a tenant-role-lookup fallback.
4. **Double approval-card fix** — guard `ApprovalCard` at `page.tsx:476` behind `status ∉ {pending_vp_approval, pending_ceo_approval}`, preserving approved-sticks at `:486` (S, manager). Removes the two-Reject-button bug.
5. **Reconcile the two prediction writers** — decide whether the engagement-row write (`gathering.service.ts:1009` → `ml.service.ts:72/81`) or the prediction-row write is authoritative, and make the approval card read the live one (M, manager). Fixes the silently-discarded ML number before Bet 2.
6. **Money-trail filter** — one client-side filter chip over typed `price_*`/`approval_*`/`final_approval_*` events in `thread-events.ts` (S, manager). Zero backend.
7. **Deal heartbeat (poll v1)** — 10s poll on the existing thread endpoint on `opportunities/[id]/page.tsx`, rendering `link_opened`/answer-milestone/`scope_submitted` (already emitted `gathering.service.ts:201,221,960`) (M, rep).
8. **Nightly chain seal (app-level)** — using item 1's scheduler, add one `@Cron` calling `AuditService.build()`, render a "chain sealed nightly, 0 divergences — app-level integrity" badge from `verify()` (S, admin). Label it app-level; WORM is later.
9. **Upload retry + reliable copy-link** — inline retry/remove on the `s3_put_403` "Failed" row, and a manual-select fallback for the once-shown `/g/[token]` clipboard copy (S, rep + client). Both verified bugs.
10. **`delivery_timeline_override` own event** — today the change `continue`s and emits **nothing** (`engagements.service.ts:716-719`), so it is invisible to both the audit chain and the money-trail filter; emit a dedicated event (S, reviewer + admin). Makes the money trail lossless.
11. **Fire `FollowUpsService.listUpcomingForTenant`** — wire `listUpcomingForTenant:170` into a stale-deal digest behind item 1's scheduler (M, rep). Data model exists; only the trigger is missing — the Deal Warden's first step.
