# Opportunity Workspace v2 — De-stack + Scope/Pricing editor + Permissions

> **Status:** Proposed (awaiting sign-off). Synthesized from a design workflow that explored 4 right-pane IAs (focus-pane · thread-driven · workbench-tabs · canvas-rail) against ground-truth maps of the current stacking, the auth model, and the pricing/history data. Multiple agents independently converged on the **Focus Pane**, grafting the thread-as-audit idea from the thread-driven approach.
>
> Builds on the shipped v1 redesign. **Reuse-only** — existing oklch tokens, `.card/.chip/.btn/.section-label/.accordion`, the Icon set, StageChip, the two-pane `.thread-split`. No Tailwind, no new fonts.

## Why (the problem after v1)

Even after the stage-driven redesign, the right `.artifact-pane` is **~12 stacked surfaces** at the Pricing stage (5 collapsed accordions + two 1,000-line mega-panels). Worse, the levers that actually change the price are **scattered across four of them**: per-line *scope* edit is buried in Documents/extraction, *discovered* lines in Scope evidence, *extras/discounts* in the dead-last "Pricing extras", and the *whole-quote override* inside the approval card — **none labelled "edit the price."** A reviewer who enumerates and wants to adjust has to hop all four.

## 1. The de-stack — a "Focus Pane"

**Mental model:** *Left = the conversation (the thread you love, now wider). Right = a single workbench showing ONLY the one thing this `(stage, permission)` asks you to do right now — everything else is one keystroke away, never stacked.* Like an email client: the thread is the inbox; the right pane is the single open composer.

```
┌─ THREAD (left, grows + is the audit) ─┬─ FOCUS PANE (right, fixed height) ──────────────────────┐
│ Acme Corp · #a1f9 · pentest-tmpl      │ ◇─◇─●─○─○   Pricing · YOUR TURN     [ ⌘ Jump ] [ ⓘ ]    │ ← slim rail (1 line)
│ [Pricing][Inbound][client@acme] ⋯     │ ────────────────────────────────────────────────────── │
│ ┌ Activity ──────── [Price changes] ┐ │  PRICE THIS QUOTE                       ₹ 2,14,000       │ ← the ONE number
│ │ ● Alex(rev) 2m  Network Pentest    │ │  predicted · ±8% · conf 0.82                            │
│ │   ₹22,000 → ₹18,000 "matched Q2"   │ │  [ Recommended 2.14L | Base 2.02L | Aggressive 1.88L ]  │ ← tier row (not a grid)
│ │ ● rhud 5m  price predicted         │ │  LINES                                  [+ Add line ▾]  │
│ │ ● rhud 6m  quote computed          │ │  ┌──────────────────────────────────────────────────┐  │
│ │ ● Client 1h scope submitted        │ │  │ Network Pentest  1 app · tier   ₹18,000 ✎        │  │ ← inline edit;
│ │ ● Client 1h file: scope.pdf        │ │  │   ↳ overridden · was ₹22,000 · ⟳ you used ₹18k…   │  │   history chip
│ │ ● rhud 2h  link issued             │ │  │ API Pentest      15 endpts·unit ₹46,000 ✎        │  │
│ │                                    │ │  │ Web App Review   2 roles · flat ₹ — ⚠ set price ▸ │  │ ← "needs price" = to-do
│ │                                    │ │  └──────────────────────────────────────────────────┘  │
│ │                                    │ │  ⓘ Crawl found 20 API endpoints not priced. [Apply→]   │ ← crawl nudge (v1)
│ │                                    │ │ ─────────────────────────────────────────────────────  │
│ │                                    │ │  [ ✓ Approve ₹2,14,000 ]  [ Hold ▾ ]  [ Reject ]        │ ← sticky decision bar
└────────────────────────────────────────┴──────────────────────────────────────────────────────────┘
   ⌘ Jump (overlay): Scope · Documents · Justification · Proposal · Attach-rate    ⓘ Inspector (drawer): Details · Notes · Lead HUD · Tickets · Odoo
```

**Three structural moves** kill the stack:
- **One Focus body**, chosen by `focusFor(stage, perms)` — never a column. At Pricing it's *Price-this-quote*: hero number → one-row tier picker → editable line table → at-most-one nudge → sticky decision bar.
- **`⌘ Jump`** swaps the *entire* focus body to Scope / Documents / Justification / Proposal — these become **destinations**, not cards you scroll past.
- **`ⓘ Inspector`** drawer holds *reference* (Opportunity details, Reviewer notes, Lead HUD, tickets, Odoo) — peeked on demand (the LeadHud slide-over pattern already exists; reuse it).

**The left thread grows and becomes the audit trail** (your ask: the manager sees what the reviewer did). Every edit emits an actor-stamped thread event — *"Alex (reviewer) changed Network Pentest ₹22,000 → ₹18,000 — 'matched Acme Q2'"* — so the loved pane **is** the change log; a new `[Price changes]` filter chip isolates the money trail. No separate audit panel.

**Every current surface keeps a home** (nothing lost): StageHeader → slim rail (5 dots + turn badge); LeadHud/LeadSummary/Reviewer-notes/Details → Inspector drawer; ApprovalCard/PriceHero/NoPredictionCta/hold/DealOutcome → the stage's Focus body; SiteScope/ExtractedPoints/Justification/Proposal/AttachRateCard → Jump destinations; **the editable line table is promoted out of ExtractedPoints into the Price focus.**

## 2. The Scope & Pricing editor (the Price focus body — first-class, not buried)

A single editable line table where the reviewer does the whole job in one place:
- **Edit a line's scope** (qty / methodology) → reprices via the rate card — **v1, exists** (`extraction.overrideEntity`). Shows per-unit math (`15 × ₹200 = ₹3,000`).
- **Override a line's price** by hand → **v2** (small backend, below). Shows struck-through rate-card price + an **"⟳ you used ₹X before — use same?"** history chip.
- **Add a discovered line** (`[+ Add line ▾]`) → travel/tool/resource/discount/**custom** — **v1, exists** (`quoteLineItems`). Extras render as tagged rows; totals roll up live.
- **Crawl nudge** → *"Crawl found 20 endpoints not priced → Apply"* reprices — **v1** (reads the site-enum count; no backend).
- **Whole-quote override** demoted to a fallback inside `[+ Add line ▾]`/the total, not a separate surface.
- **Live total**: base + extras = grand, recomputing on each saved edit (optimistic + rollback; validate-on-blur; per-row spinner → success/error; stable `entityId` keys; stacks to cards <640px).

**History hint — honest scope:** the comparable data is real (`price_predicted` thread event `payload.topK` = `{scopeSummary, priceCents, score}`), already loaded on the page. But comparables are **whole-deal, not per-line**, so v1 surfaces a quote-level *"comparable deals"* strip; v2 fuzzy-matches a line's name/scope to the best comparable to pre-fill the override — clearly captioned as whole-deal. A true per-line hint needs the ML service to return per-slug comparables (out of scope; flagged).

## 3. Permissions via profiles (gate by permission, not hardcoded roles)

The lightest thing that satisfies *"users create profiles and get permissions accordingly"*, coexisting with the role ladder (which stays — roles answer *who escalates/approves*; permissions answer *who may edit*):

- **Data:** one `PermissionProfile` table (`name`, `permissions Json` = string[] of slugs, `isSystem`) + a **nullable `User.profileId` FK** (`onDelete: SetNull`). One profile per user. **Null → role-derived defaults**, so day-one is byte-identical to today (every existing user starts `profileId = null`).
- **Catalog (start with 5, extensible):** `pricing:edit` (per-line override + line items + whole-quote override), `scope:edit` (entity scope/methodology + apply crawl), `price:approve`, `opportunity:delete`, `workspace:manage`.
- **Defaults (the fallback + the seed):** admin = all; **sales_manager** = pricing:edit + scope:edit + price:approve + opportunity:delete; **tech_team** = pricing:edit + scope:edit (your stated leaning); sales_employee = read-only `[OPEN Q]`; vp_sales/ceo = price:approve only.
- **Enforcement:** a `@Permissions()` decorator + `PermissionsGuard` **beside** `@Roles` (don't replace it). The guard does one `findUnique` **inside `TenantDb.run`** (RLS-isolated) on the decorated edit endpoints — **not baked into the JWT**, so an admin changing a profile takes effect immediately with no re-login. Frontend learns perms via `/auth/me` and a `can(p)` helper replaces ~6 scattered role literals; `can()` is cosmetic, the server enforces.
- **Admin UI:** a Settings → "Profiles & permissions" tab (CRUD profiles, assign to users). System profiles (the seeded role-mirrors) aren't deletable.

## 4. Phased rollout (each independently shippable, behaviour-preserving)

| Phase | What | Backend? | Cost |
|---|---|---|---|
| **1 — Focus shell** | `focusFor(stage,perms)` router replaces the stacked JSX; slim rail; `⌘ Jump`; `ⓘ Inspector` drawer. Existing cards rendered **one-at-a-time, reused as-is**. | none | mostly **S** (re-layout) |
| **2 — Scope & Pricing editor v1** | Promote `InferredEntityRow` into a `LineTable` in the Price focus; inline scope edit (`overrideEntity`), add line (`quoteLineItems`), crawl nudge, quote-level comparable strip, live total. | none | **M** |
| **3 — Permissions** | `PermissionProfile` table + nullable FK (RLS-pattern migration), `@Permissions` guard, `permissions.ts` catalog, `can()` + `/auth/me`, Profiles admin tab. Zero behaviour change until a profile is assigned. | small (1 table + 1 col) | **M** |
| **4 — v2 per-line override + trail** | `linePriceOverrides Json?` on `EngagementQuote` (keyed by `entityId`); overlay after `computeBasePrice`; `PATCH …/base-lines/:entityId/price`; `price_line_overridden` + `scope_line_overridden` thread events (+ plumb `userId` into `overrideInferredEntity`); the history pre-fill; `[Price changes]` filter. | small (1 col + endpoint + events) | **M** |

~90% of the visible win is **Phase 1–2 (re-layout + promotion, reuse-only, no backend)**. The two genuine backend items (profiles, per-line override) are both **one table / one column, additive, RLS-isolated, with zero-behaviour-change fallbacks.**

## 5. Open questions

1. **`sales_employee` editing** — default them to read-only on pricing? It's a behaviour change if any current flow lets reps edit. (Or keep the role-fallback permissive until an admin assigns a profile.)
2. **Per-line override stickiness** — when a reviewer pins a line to ₹18k, should a later scope-qty edit or re-predict **wipe** it or **keep** it until explicitly cleared? (Recommend: keep, with a visible "manual" badge + one-click clear.)
3. **Jump as command-palette vs segmented control** — ship the cheap segmented control first, palette later?
4. **History hint depth** — accept the whole-deal comparable for now, or prioritize the ML per-slug change for true per-line suggestions?
5. **Focus default per stage** confirmation (Discovery→Scope, Pricing→Price, Approval→Approve, Proposal→Proposal, Delivered→Outcome).
