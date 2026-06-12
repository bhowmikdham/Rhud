# Gamma proposals v2 — multi-template library + per-proposal field review

**Status:** design (no code yet) · **Date:** 2026-06-05 · **Author:** Claude (with Bhowmik)

This doc designs two upgrades to the Gamma proposal integration:

1. **Multiple templates** — a tenant-level **Gamma template library** with a **picker** at proposal time (replacing today's single, implicit, per-questionnaire binding).
2. **Selective field changes** — a **per-proposal review form**: before generating, the rep sees the values Rhud computed, edits/toggles which ones to push into the deck, and which sections to keep verbatim.

Decisions already locked (from the design conversation):
- Model = **tenant Gamma library + picker** (not extending the questionnaire `Template`).
- Selective fields = **per-proposal review form**.
- Deliverable now = **this design doc**, build later.

---

## 1. Where we are today (discovery summary)

The "template ID" is **not** in settings. It lives **per Rhud `Template`** (the scoping-questionnaire model), as a single free-text column, edited in the template editor.

| Concern | Location |
|---|---|
| `gammaTemplateId` storage | `apps/api/prisma/schema.prisma` → `Template.gammaTemplateId` (line 137, `templates.gamma_template_id`, nullable string ≤200 chars) |
| Write | `PATCH /templates/:id` → `templates.service.ts update()` (≈68–113); UI input `apps/web/src/app/templates/[id]/page.tsx:413` |
| Read at draft time | `proposal-draft.service.ts loadContext()` (line 956, 1003) — pulls the engagement's **one bound template's** `gammaTemplateId` |
| Per-tenant Gamma config | `tenantGammaConfig` (workspace, encrypted API key, `proposalDriver` llm\|gamma, `enabled`) — **no template id** |
| Deck persistence | `Engagement` columns: `gammaDeckUrl`, `gammaDeckId`, `gammaGenerationId`, `proposalPdfUrl`, `proposalPdfExpiresAt`, `proposalDraftSource` |

The draft pipeline (`apps/api/src/llm/proposal-draft.service.ts`) already has **three** Gamma paths in `generate()` → `generateViaGamma()` (lines 217–399):

1. **Scaffold path** (`template.proposalScaffold` set, lines 243–268): Rhud renders a markdown scaffold with `{{token}}` substitution **deterministically — no LLM** — then hands the rendered text to Gamma. *This is the only path with exact-value guarantees.*
2. **From-template path** (`gammaTemplateId` set, no scaffold): `buildGammaTemplateBrief()` (893–939) sends a natural-language "adapt this deck, swap the client/price/date, keep the layout" prompt to Gamma's `from-template` endpoint.
3. **Freeform path** (neither): `buildGammaBrief()` (840–878) tells Gamma to build a deck from a section list.

**UI gaps:** no way to choose a template at generation time (`proposal-workspace.tsx` just has a "Generate draft" button, lines 320–333), and no notion of which fields/sections change.

**Two structural flaws (both confirmed in code) — the reason we're not building on the existing binding:**
1. **Coupling to the questionnaire `Template` is wrong.** A Gamma deck is a *presentation* concern; the questionnaire is a *data-gathering* concern. Binding one to the other conflates two unrelated things, and means the rep can't switch the deck for the proposal they're generating right now.
2. **Template-less opportunities are locked out.** Direct-ingest opportunities often have **no** questionnaire template (`loadContext` lines 985–989: *"may not have a template attached … skip the scaffold path entirely"*), so `gammaTemplateId` resolves to `null` (line 1003) and those proposals can **never** inherit a deck layout. The selection must live on the **opportunity**, not the questionnaire template.

---

## 2. The hard constraint that shapes the design

From the live Gamma API (developers.gamma.app, 2026):

- **No field-level updates. No merge-fields. No edit-existing-deck endpoint.** Every `from-template` call produces a **brand-new deck**.
- Selectivity is expressed **only as natural-language instructions in the `prompt`** — "replace `[[client-name]]` with Acme", "do not edit the legal or bios cards". Tokens like `[[client-name]]` are a **convention you invent**, not something Gamma parses. It is **LLM best-effort, not deterministic**.
- The template source must be **exactly one Page** (multi-card).
- **No REST endpoint to list templates** — only Gamma's MCP `get_gammas` can enumerate. Users obtain a template's File ID by copying it from the Gamma app URL.
- `GET /generations/{id}` now returns the new deck's `gammaId` (Feb 2026) — useful for chaining.

**Implication:** "change only certain items" can't be a guaranteed structured operation against Gamma. The practical design is:
- **Exact-required fields** (price, client name, legal) → ride Rhud's **deterministic** token render where it matters, and/or **validate after generation**.
- **Everything else** → a **generated lock/substitute prompt** built from the rep's per-proposal choices.
We make this honest in the UI rather than pretending Gamma guarantees substitution.

---

## 3. Data model

### 3.1 New model: `GammaTemplate` (the library)

A tenant-level library entry. Decoupled from the questionnaire `Template`.

```prisma
model GammaTemplate {
  id              String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId        String   @map("tenant_id") @db.Uuid
  label           String                                  // "Standard VAPT Proposal"
  gammaTemplateId String   @map("gamma_template_id")      // Gamma File ID (one Page)
  format          String   @default("presentation")       // presentation | document
  serviceLine     String?  @map("service_line")           // optional auto-match hint
  isDefault       Boolean  @default(false) @map("is_default")
  manifest        Json     @default("{}")                 // GammaTemplateManifest (see §4)
  status          String   @default("active")             // active | archived
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@index([tenantId])
  @@index([tenantId, status])
  @@map("gamma_templates")
}
```

- **RLS:** add a tenant-isolation policy mirroring the other tenant-scoped tables; all access via `TenantDb` (per the project's tenant-isolation rule). One migration adds the table + policy.
- `isDefault`: enforce "at most one default per tenant" in the service (clear others on set), not a DB constraint (simpler, and partial unique indexes get fiddly).
- `Template.gammaTemplateId` (the questionnaire binding) is **deprecated** — removed from the runtime path, kept only for a one-time backfill (§8). The selection moves to the engagement (§3.3).

### 3.2 Manifest (stored in `GammaTemplate.manifest`, typed in `packages/shared`)

```ts
// packages/shared/src/gamma.ts
export type GammaFieldKey =
  | 'clientName' | 'clientEmail' | 'opportunityName' | 'serviceLine'
  | 'tenantName' | 'investment' | 'date' | 'lineItems' | 'scopeSummary';

export interface GammaTemplateManifest {
  /** Placeholder→Rhud-field bridges. `token` is the literal text the rep
   *  put in the Gamma deck (e.g. "[[investment]]"); `fieldKey` says which
   *  computed Rhud value feeds it. Drives the substitution prompt. */
  fields: Array<{
    token: string;
    fieldKey: GammaFieldKey;
    label: string;            // UI label, e.g. "Investment"
    defaultInclude: boolean;  // pre-ticked in the review form
  }>;
  /** Named cards/sections to keep verbatim by default (e.g. ["Methodology",
   *  "Legal", "Team bios"]). Free-text because Gamma REST can't enumerate
   *  cards — the rep names them as they appear in their deck. */
  lockedSections: string[];
}
```

The manifest is the bridge between "the rep's Gamma deck" and "Rhud's data." Authored once per library entry; reused on every proposal.

### 3.3 Per-opportunity selection (on `Engagement`, not `Template`)

The chosen Gamma template is a property of **the proposal/opportunity** — set and changeable in the proposal workspace, never inherited from the questionnaire template. Add one nullable FK column:

```prisma
// on model Engagement
selectedGammaTemplateId String? @map("selected_gamma_template_id") @db.Uuid  // → GammaTemplate.id
```

Why this, specifically:
- **Decoupled & universal.** Works identically for template-based *and* direct-ingest (template-less) opportunities — the selection no longer depends on a questionnaire template existing.
- **Sticky but changeable.** Pre-filled on first proposal open (default resolution, §5.2), persisted so reopening shows the choice, and re-selectable before **every** generate/regenerate — so the rep can swap the deck for the proposal they're working on right now.
- **No questionnaire coupling.** `Template.gammaTemplateId` is out of the resolution chain entirely (deprecated, §8).
- FK `onDelete: SetNull` to `GammaTemplate` — archiving a library entry just drops the selection back to the default, never orphans an engagement.

---

## 4. The dynamic-field catalog

These are the values Rhud can already compute per engagement (from `buildScaffoldContext`, `proposal-draft.service.ts:805–838`). The review form exposes exactly these as `GammaFieldKey`s:

| fieldKey | Source | Exact-required? |
|---|---|---|
| `clientName` | `nameFromEmail(clientEmail)` | usually |
| `clientEmail` | `engagement.clientEmail` | yes |
| `opportunityName` | `engagement.name` | no |
| `serviceLine` | `template.serviceLine` / `categorySlug` | no |
| `tenantName` | `tenant.name` | no |
| `investment` | `fmtMoney(approvedPriceCents ?? baseTotalCents)` | **yes (money)** |
| `date` | today, `"27 Apr 2026"` shape | no |
| `lineItems` | `quote.baseBreakdown` → name/qty/unit/price | **yes (money)** |
| `scopeSummary` | `engagementAnswer[]` + `templateNode.question` | no |

"Exact-required" fields are where Gamma's LLM best-effort is risky → §7 covers the safeguard.

---

## 5. API design

All new endpoints are admin/sales-manager gated and tenant-scoped via `TenantDb`.

### 5.1 Library CRUD (new controller, e.g. `tenant/gamma-templates`)

```
GET    /api/v1/tenant/gamma-templates              → GammaTemplate[]          (list, active first)
POST   /api/v1/tenant/gamma-templates              → GammaTemplate            (create)
PATCH  /api/v1/tenant/gamma-templates/:id          → GammaTemplate            (edit label/manifest/default/format/serviceLine)
DELETE /api/v1/tenant/gamma-templates/:id          → 204                      (archive, soft)
POST   /api/v1/tenant/gamma-templates/:id/test     → { ok, error? }           (validate the Gamma id is reachable)
```

`/test` reuses `GammaClient.ping()` semantics (the API key already lives in `tenantGammaConfig`); optionally a cheap `from-template` dry-run is out of scope (costs credits).

### 5.2 Field preview (powers the review form, no generation)

```
GET /api/v1/opportunities/:id/draft/field-preview?gammaTemplateId=<libraryId>
→ {
    templates: Array<{ id, label, isDefault, serviceLine, format }>,  // for the picker
    resolvedTemplateId: string | null,                                // server's default pick
    fields: Array<{ fieldKey, label, token, computedValue, include }>,
    lockedSections: string[],
  }
```

- Reuses `buildScaffoldContext()` to compute `computedValue` per `fieldKey`.
- `include` defaults from the manifest's `defaultInclude`.
- **Resolution order** for `resolvedTemplateId`: explicit query param → `engagement.selectedGammaTemplateId` (the persisted pick) → **tenant default** entry → none (freeform). The deprecated questionnaire `template.gammaTemplateId` is **not** in the chain. On first open with no saved pick, the resolved tenant default is written back to `engagement.selectedGammaTemplateId` so the choice is sticky. (`GammaTemplate.serviceLine` stays as a label and a hook for a future per-service-line default; tenant default is the v1 pre-fill.)

### 5.3 Persist the picker choice

So the chosen template sticks (survives reload, drives regenerate) independent of generating:

```
PATCH /api/v1/opportunities/:id/proposal-template   { gammaTemplateId: string | null }
→ sets Engagement.selectedGammaTemplateId   (null = back to default resolution / freeform)
```

The workspace picker calls this immediately on change. Generation then reads the engagement column as the source of truth (the request override below is just belt-and-suspenders for an atomic "switch + generate").

### 5.4 Generate (extend the existing endpoint)

Today: `POST /opportunities/:id/draft` with **no body** → `ProposalDraftService.generate(tenantId, engagementId, actorId)`.

Add an **optional** body (back-compatible — empty body = today's behavior + default resolution):

```ts
interface GenerateDraftRequest {
  gammaTemplateId?: string;                 // library entry id (NOT the raw Gamma id)
  fieldOverrides?: Array<{
    fieldKey: GammaFieldKey;
    include: boolean;                        // push this value into the deck?
    value?: string;                         // rep's edited value; omit = use computed
  }>;
  lockedSections?: string[];                // per-proposal override of manifest default
}
```

`generate()` threads this into `generateViaGamma()`, which composes the prompt (§6). The auto-trigger-on-approval path (`tryAutoGenerateAfterApproval`) passes no overrides → resolution defaults apply, so automation keeps working.

---

## 6. Prompt construction (the selective part)

Replace the hardcoded `buildGammaTemplateBrief()` (893–939) with a manifest-driven builder, `buildGammaTemplateBriefV2(ctx, libraryEntry, overrides)`:

1. Compute the field catalog via `buildScaffoldContext(ctx)`.
2. For each manifest field that is **included** (override.include ?? manifest.defaultInclude), emit a substitution line:
   `Replace {token} with "{override.value ?? computedValue}".`
3. Append an explicit **lock** instruction:
   `Do not modify these sections — keep them exactly as written: {lockedSections.join(', ')}.`
4. Append a global guard:
   `Leave all other content, layout, theme, and section order unchanged. Do not add or remove sections.`

Excluded fields simply get **no** substitution line → the template's existing value stays. This is exactly the "only change certain items" behavior, expressed the only way Gamma supports it.

The freeform (`buildGammaBrief`) and scaffold paths are **unchanged**. The library entry could *optionally* also carry a scaffold for the deterministic tier (future; out of scope for v2).

---

## 7. Honesty & safeguards (exact-required fields)

Because substitution is LLM best-effort:

- **Surface it in the UI.** The review form labels exact-required fields (money) and notes "Gamma applies these as instructions, not a guaranteed find-and-replace."
- **Post-generation validation (recommended Phase 3).** After the deck completes, we already fetch a PDF export (`proposalPdfUrl`). Parse its text for each *included exact-required* value (client name, formatted price). If a value is missing, set a soft flag on the draft (`gammaFieldDriftWarning`) and show a "verify the deck — a value may not have applied" banner. Non-blocking.
- **Deterministic escape hatch.** Tenants who need guaranteed pricing/legal keep using the **scaffold path** (#1), which Rhud renders exactly. The doc/UI points there for compliance-sensitive proposals.

---

## 8. Migration & back-compat

- **Retire the questionnaire binding.** `Template.gammaTemplateId` leaves the runtime path; it is read **only** by the one-time backfill below, then the column can be dropped in a later migration. No engagement ever resolves its deck through the questionnaire template again.
- **Idempotent backfill (Phase 1).** A one-shot script creates one `GammaTemplate` per distinct non-null `templates.gamma_template_id` per tenant (`label` from the Rhud template name, empty `manifest` = today's generic swap prompt). The **most-referenced** binding becomes the tenant `isDefault` (ties → oldest template). It then sets `engagement.selectedGammaTemplateId` **only for opportunities at or before `draft_ready`** (statuses: `approved`, `pending_*_approval`, `drafting`, `draft_ready`) whose questionnaire template had a binding — so anything still in play keeps its expected deck. Opportunities already `sent` or terminal (`won`/`lost`/archived) are **left untouched**: their proposal already shipped, so the selection is moot and we don't rewrite delivered records. After backfill, the questionnaire column is dead.
- **Graceful default for everyone else.** Tenants who never curate a library get freeform generation (today's path-3 behavior) — unchanged.
- **Validation on add:** warn (not block) if the Gamma deck isn't one Page — we can't detect this via REST, so it's a UI hint citing Gamma's constraint.

---

## 9. Web UX

### 9.1 Settings → Integrations → Gamma → "Templates" tab

Library manager (admin/sales-manager): list entries (label, default chip, service line, status), **Add template** (label, paste Gamma File ID, format, set default, optional service line, **Test**), and an **Edit manifest** drawer:
- **Field map** rows: `token` (text, e.g. `[[investment]]`) → `fieldKey` (dropdown) → `label` → default-include toggle.
- **Locked sections**: tag input of section names.

### 9.2 Opportunity workspace — "Proposal setup" card (before Generate)

```
┌─ Proposal setup ─────────────────────────────────────────────┐
│ Template:  [ Standard VAPT Proposal  ▾ ]   (default)          │
│                                                              │
│ Fields to apply  (Gamma applies these as instructions)       │
│  ☑ Client name        Acme Corp                  [edit]      │
│  ☑ Investment  $       USD 45,000      ⚠ exact   [edit]      │
│  ☑ Date                05 Jun 2026               [edit]      │
│  ☐ Opportunity name    Acme – Web App VAPT       [edit]      │
│  ☑ Priced line items   3 items                   [view]      │
│  ☑ Confirmed scope     12 points                 [view]      │
│                                                              │
│ Keep unchanged (verbatim)                                    │
│  ☑ Methodology   ☑ Legal & terms   ☐ Team bios               │
│                                                              │
│              [ Generate draft ]                              │
└──────────────────────────────────────────────────────────────┘
```

- Card data comes from `GET …/draft/field-preview`. Unticking a field excludes it; the inline edit sets `value`.
- **The Template dropdown is the whole point of the decoupling:** it's present on every opportunity — template-based or direct-ingest — and changing it `PATCH`es `selectedGammaTemplateId` immediately, so the rep can swap the deck for *this* proposal (including right before a regenerate) without touching any questionnaire template.
- **Generate** calls `proposalDraft.generate(engagementId, body)` with the assembled `GenerateDraftRequest`.
- Existing iframe preview / regenerate / PDF flow is unchanged downstream. Regenerate re-reads the (possibly just-changed) selection + review-form state.

### 9.3 Web API client (`apps/web/src/lib/api.ts`)

- New `gammaTemplates` namespace (list/create/update/archive/test).
- New `proposalDraft.fieldPreview(engagementId, libraryId?)`.
- Extend `proposalDraft.generate(engagementId, body?)` to send the optional `GenerateDraftRequest`.

---

## 10. End-to-end flow

```
Settings: admin adds library entries + manifests (token→field, locked sections)
        ↓
Opportunity (approved): rep opens proposal → GET …/draft/field-preview
        ↓ (review form shows computed values + include toggles + locked list)
rep adjusts, clicks Generate → POST …/draft { gammaTemplateId, fieldOverrides, lockedSections }
        ↓
generate() → generateViaGamma() → buildGammaTemplateBriefV2() composes substitute+lock prompt
        ↓
gamma.startDraftFromBrief() → client.createFromTemplate({ prompt, gammaId, exportAs:pdf })
        ↓ (status='drafting', gammaGenerationId set; frontend polls GET …/draft every 5s)
deck completes → persistGammaDraft() (deckUrl, deckId, pdfUrl) → status='draft_ready'
        ↓ (Phase 3) PDF text validation → optional drift warning
```

---

## 11. Phased delivery

- **Phase 1 — Multiple templates (ships the picker).** `GammaTemplate` model + `Engagement.selectedGammaTemplateId` column + migration/RLS, library CRUD API, `PATCH …/proposal-template` to persist the pick, Settings "Templates" tab, **opportunity-level** workspace picker (works on template-less opportunities too), engagement-based resolution order, idempotent backfill that retires the questionnaire binding. No manifest/review-form yet — picker just swaps which Gamma deck is used (reusing the current generic swap prompt).
- **Phase 2 — Selective fields (ships the review form).** Manifest editor, `field-preview` endpoint, the "Proposal setup" review card, `buildGammaTemplateBriefV2` prompt composition from overrides.
- **Phase 3 — Guarantees & polish.** Post-generation PDF validation + drift banner, optional MCP-backed "browse my Gamma decks" picker (so reps select instead of pasting File IDs), optional per-entry scaffold for the deterministic tier.

---

## 12. File-change map (anchors)

| Area | File | Change |
|---|---|---|
| Schema | `apps/api/prisma/schema.prisma` (after `Template`, ~157; `Engagement` ~284) | add `GammaTemplate` + `Engagement.selectedGammaTemplateId` FK (`onDelete: SetNull`) + migration + RLS policy |
| Shared types | `packages/shared/src/gamma.ts` (new) | `GammaFieldKey`, `GammaTemplateManifest`, `GammaTemplate`, `GenerateDraftRequest` |
| Library service/controller | `apps/api/src/gamma/gamma-template.service.ts`, `…controller.ts` (new) | CRUD + test + default-enforcement |
| Resolution + preview | `apps/api/src/llm/proposal-draft.service.ts` | new `resolveGammaTemplate()`, `fieldPreview()`, `buildGammaTemplateBriefV2()`; thread overrides through `generate()` (217) → `generateViaGamma()` (345) |
| Controller | `apps/api/src/llm/proposal-draft.controller.ts` (~74) | accept `GenerateDraftRequest` body; add `GET …/draft/field-preview` + `PATCH …/proposal-template` |
| Gamma client | `apps/api/src/gamma/gamma.client.ts` (162) | none required (from-template already supported) |
| Web client | `apps/web/src/lib/api.ts` (~1295) | `gammaTemplates` ns, `fieldPreview`, extend `generate` |
| Settings UI | `apps/web/src/app/integrations/gamma-modal.tsx` (+ new Templates tab) | library manager + manifest editor |
| Workspace UI | `apps/web/src/app/opportunities/[id]/proposal/proposal-workspace.tsx` (~320) | "Proposal setup" card |

---

## 13. Open questions

**Resolved:**
- The Gamma template is selected **on the opportunity** (`Engagement.selectedGammaTemplateId`), fully decoupled from the questionnaire `Template`, changeable before every generate/regenerate, and works on template-less (direct-ingest) opportunities. The questionnaire `Template.gammaTemplateId` binding is retired.
- **Default pre-fill (Q2):** first open lands on the **tenant default** library entry (no service-line matching in v1).
- **Backfill reach (Q3):** sets `selectedGammaTemplateId` only on opportunities **at or before `draft_ready`**; `sent`/terminal opportunities are left untouched (§8).

Still open:

1. **Locked sections** are rep-typed names (Gamma REST can't enumerate cards). Acceptable for v2, or wait for the MCP-backed picker (Phase 3) to make this selectable?
2. **Deterministic tier:** fold an optional per-library-entry scaffold (for money/legal exact-guarantees) into v2, or keep the deterministic path on the questionnaire `Template`'s `proposalScaffold` as today?
3. **Credits:** each review-form generate is a full new deck (credits). Surface a cost hint in the UI?
