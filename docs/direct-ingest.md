# Direct-ingest opportunity pipeline

**Status:** Draft v0.1 — 2026-05-27
**Author:** TBD
**Reviewers:** TBD
**Targets:** API + Web + Outlook extension teams

## 1. Context

Today, creating an opportunity in Rhud is the same operation as issuing a tokenised gathering link. The wizard at `/opportunities/new` enforces this: every `POST /opportunities` mints a `GatheringToken`, sets `status: issued`, and emits a `link_issued` thread event in one transaction (`apps/api/src/engagements/engagements.service.ts:73`).

But sales reps don't always start from a blank link. The PM raised that requirements regularly arrive **before any Rhud interaction**: in WhatsApp threads, forwarded emails, attached PDFs, RFP files, SOWs, voice notes, or a quick call where the rep typed up bullets. Forcing a client-link round-trip in those cases is wrong — the data is already in hand.

The pattern this doc proposes: **decouple opportunity creation from link issuance, give every input channel a path to land directly as an opportunity, and treat the gathering link as an optional follow-up tool rather than the only entry point.**

The initial focus is the **in-app channels** — paste-text, file-drop (PDF/DOCX/RFP/SOW), and voice — followed by **webhook channels** (WhatsApp, SES inbound).

**An Outlook add-in (`apps/outlook-addin/`) shipped on `main` in parallel** with a narrower contract — `POST /opportunities/from-email` (see §6) — that pre-fills the existing link-share wizard from a selected email. That path **coexists** with the direct-ingest pipeline below: Outlook = "prefill a link-share opportunity from an email," direct-ingest = "land artifacts, extract them, attach a template only if the rep asks." Reps see them as one channel each on the source chip.

### Goals
- Any of: email, WhatsApp message, PDF/DOCX/RFP/SOW upload, pasted text, voice note → becomes a Rhud `Engagement` without sending a link to the client.
- Channel adapters (Outlook extension, WhatsApp webhook, paste-text UI, etc.) all converge on one ingestion service. Adding channel N+1 requires no changes to the ingestion core or to extraction.
- Track the source so reporting can distinguish "we hunted this down" from "the client filled the link."
- After direct-ingest, the rep can still issue a gathering link from the opportunity detail page for follow-up scoping ("send the client a few clarifying questions").
- Extraction, pricing, classification, and proposal generation work the same way for direct-ingest opportunities as for link-share ones.

### Non-goals (this doc)
- WhatsApp Cloud API setup, SES inbound MX rules, voice provider selection (Whisper vs Transcribe vs AssemblyAI) — covered in future docs once Sprint 1 lands.
- The Outlook extension's client-side architecture — owned by that team. This doc only specifies the HTTP shape it consumes.
- A full re-design of the gathering / template editor — those stay untouched.

## 2. Architecture

Three layers. The middle layer is the new one.

```
┌─────────────────────────────────────────────────────────────┐
│  Channel adapters                                           │
│  Outlook ext · WhatsApp wh · Paste/Drop UI · SES inbound    │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  IngestionService                          (NEW)            │
│  receive()  ·  promote()  ·  receiveAndPromote()            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  ExtractionService                       (REUSED AS-IS)     │
│  PDF / DOCX / text → LLM → structured points                │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  Engagement (existing tables, schema additions)             │
│  Classification · Pricing · Proposal (unchanged downstream) │
└─────────────────────────────────────────────────────────────┘
```

`EngagementsService.issue()` (`apps/api/src/engagements/engagements.service.ts:73`) stays — it remains the link-share path. A sibling method `createFromIngest()` becomes the no-link path. Both create an `Engagement` row; only `source`, `status`, and the existence of a `GatheringToken` differ.

## 3. Data model

### 3.1 New enum `EngagementSource`

```prisma
enum EngagementSource {
  manual_form       // link-share wizard (existing default)
  direct_upload     // rep dropped a file in the "I have it" UI
  paste_text        // pasted email body / WhatsApp transcript / call notes
  voice_note        // audio → STT → text
  email_import      // Outlook extension or SES inbound
  whatsapp_import   // WhatsApp Cloud API webhook
  rfp_import        // tender / RFP file (classifier-set)
  sow_import        // SOW file (classifier-set)
  odoo_import       // existing importedFromOdoo path
  api               // catch-all for programmatic ingestion
}
```

### 3.2 `Engagement` table — changes

| Column | Change | Notes |
|---|---|---|
| `source` | **NEW** `EngagementSource @default(manual_form)` | Every entry point sets it. Backfill existing rows to `manual_form`. |
| `templateId` | **CHANGE** `String?` (was `String`) | Direct-ingest may not have a template; rep can attach one later. **Invariant:** a `GatheringToken` cannot exist on an engagement where `templateId IS NULL`. Issuing a link via `POST /opportunities/:id/links` on a template-less engagement sets `templateId` (and `templateVersion`) as a side-effect of the mint. |
| `templateVersion` | **CHANGE** `Int?` (was `Int`) | Mirrors `templateId` nullability. |
| `ingestionId` | **NEW** `String? @db.Uuid` | Back-pointer to the originating `IngestionArtifact` (if any). FK with `onDelete: SetNull`. |
| `status` | **NEW VALUE** `ingesting` | Initial state for direct-ingest opportunities — artifacts attached, extraction running. Transitions to `submitted` when all artifact files reach `extraction.status = ready`. The existing FSM in `packages/shared/src/engagement.ts:2` gains one entry. |

`importedFromOdoo: Boolean` (`apps/api/prisma/schema.prisma:178`) is **kept for back-compat** but deprecated; new code should read `source == odoo_import` instead. A future migration removes the boolean once nothing references it.

### 3.3 New `IngestionArtifact` model

Captures the raw input that produced an opportunity. One opportunity may have multiple artifacts (e.g., an email with three attachments → one artifact for the email body, one per attachment). Artifacts may arrive *before* an opportunity exists (WhatsApp webhook, SES inbound) and sit unassigned until promoted.

```prisma
model IngestionArtifact {
  id            String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId      String   @db.Uuid

  // Set after promotion. Null while pending (webhook-arrived, not yet
  // promoted to an opportunity). FK to Engagement; SetNull on cascade.
  engagementId  String?  @db.Uuid

  source        EngagementSource
  kind          ArtifactKind

  // Text content (paste-text, email body, voice transcript). Capped at
  // ~256KB; longer bodies materialise to S3 and live as a file artifact.
  rawText       String?  @db.Text

  // Email-specific metadata (also populated for WhatsApp messages where
  // we have an analog of "from").
  emailSubject  String?
  emailFrom     String?
  emailTo       String[]
  emailDate     DateTime?
  emailHeaders  Json?
  externalId    String?  // provider-side message ID (RFC 5322 Message-ID, WhatsApp wamid, etc.)

  // File-shaped artifacts (file, audio). The artifact row also points to
  // the EngagementFile row it produced once promoted.
  s3Key         String?
  contentType   String?
  sizeBytes     Int?
  originalName  String?

  status        IngestionStatus
  failureReason String?

  receivedAt    DateTime @default(now())
  receivedBy    String?  @db.Uuid  // userId, null for webhooks
  promotedAt    DateTime?

  engagement    Engagement? @relation(fields: [engagementId], references: [id], onDelete: SetNull)

  @@map("ingestion_artifacts")
  @@index([tenantId, status])
  @@index([tenantId, externalId])  // dedupe inbound messages
}

enum ArtifactKind {
  text      // rawText only
  file      // s3Key + contentType
  audio     // s3Key + contentType; rawText filled by STT
  email     // email metadata + rawText body; attachments are separate file artifacts linked via emailId (see §3.4)
}

enum IngestionStatus {
  received     // landed, not yet processed
  processing   // extraction running
  promoted     // engagementId set, lifecycle handed off
  failed       // extraction or promotion errored
}
```

### 3.4 `EngagementFile` — one new column

```prisma
model EngagementFile {
  // ... existing columns ...
  originArtifactId  String?  @db.Uuid  // NEW
  originArtifact    IngestionArtifact? @relation(...)
}
```

Lets us answer "which artifact produced this file?" for audit. **No other changes** — `s3Key` stays NOT NULL. Paste-text artifacts materialise to S3 as small `.txt` objects so the extraction pipeline can run unchanged.

### 3.5 New thread events

Two additions to `packages/shared/src/thread-events.ts`:

| Event | Emitted when |
|---|---|
| `requirements_ingested` | An artifact is promoted into an opportunity. Payload: `{ source, artifactIds, kind }`. |
| `link_reissued` | A gathering link is minted against an *existing* opportunity (re-scope / follow-up). Distinct from `link_issued` (which only fires on first issuance). Payload: `{ tokenId, expiresAt, reason? }`. |

## 4. Service contracts

### 4.1 New: `IngestionService` (`apps/api/src/ingestion/`)

```ts
class IngestionService {
  /**
   * Land a raw artifact. Does NOT create an Engagement.
   * Used by webhooks (WhatsApp, SES inbound) where the artifact arrives
   * un-attended and a human will promote it later via the dashboard.
   */
  receive(args: {
    tenantId: string;
    source: EngagementSource;
    kind: ArtifactKind;
    content: TextContent | FileContent | AudioContent | EmailContent;
    receivedBy?: string;  // userId; null for webhooks
    externalId?: string;  // dedupe key
  }): Promise<{ artifactId: string }>;

  /**
   * Promote one or more artifacts to a new Engagement. Creates the
   * Engagement (status=ingesting), materialises text artifacts as
   * EngagementFile rows, kicks off extraction via the existing
   * ExtractionService, and emits requirements_ingested.
   */
  promote(args: {
    tenantId: string;
    artifactIds: string[];
    salesEmployeeId: string;
    overrides?: Partial<ClientMetadata>;  // rep-provided fields override LLM-extracted
    name?: string;  // optional engagement label
  }): Promise<{ engagementId: string }>;

  /**
   * Convenience: receive + promote atomically. Used by the UI and the
   * Outlook extension where the rep wants immediate opportunity creation.
   */
  receiveAndPromote(args: ...): Promise<{ engagementId: string; artifactIds: string[] }>;
}
```

### 4.2 `EngagementsService` — two new methods

```ts
// Existing — unchanged.
issue(args): Promise<IssuedLink>;

// NEW — bare engagement, no template, no token. Called by IngestionService.
createFromIngest(args: {
  tenantId: string;
  salesEmployeeId: string;
  source: EngagementSource;
  client: Partial<ClientMetadata>;
  ingestionId?: string;
  name?: string;
}): Promise<{ engagementId: string }>;

// NEW — mint a gathering token against an EXISTING engagement.
// Works for direct-ingest opportunities (issue their first link) AND
// link-share opportunities (re-scope / follow-up). Emits link_reissued
// when the engagement already had a prior token, link_issued otherwise.
issueLinkForExisting(
  engagementId: string,
  args: { templateId: string; expiresInDays?: number; reason?: string },
): Promise<IssuedLink>;
```

### 4.3 `ExtractionService` — no contract change

The service (`apps/api/src/extraction/extraction.service.ts`) already operates on `EngagementFile` rows agnostic of upstream channel. For text artifacts, we materialise the body as `text/plain` to S3 and create a normal `EngagementFile` — the existing pipeline handles `text/plain` as a no-op text extractor, then runs LLM structuring.

### 4.4 Null-template guards across services

Several services currently dereference `engagement.template.X` without a null check. The Sprint 0 pre-flight (§11) audited all call sites; six fix points across four files need null-safety before the migration is cut. Concrete list in §11.

The behaviour change for `ProposalDraftService`:
- Skip the scaffold path entirely when `templateId=null` (no template, no scaffold).
- Pass the engagement's free-form extracted points + assumptions/exclusions + classifier-derived `categorySlug` to the LLM as the synthesis input.
- Service line falls back to `engagement.categorySlug` (set by the classifier) when present, else "Engagement".

The other services (`JustificationService`, `NotificationsService`) get optional-chaining + sensible defaults (`'(Untitled)'`, `'General'`).

`GatheringService` is a special case — see §11.

## 5. API surface

### 5.1 Endpoints — additions and one change

| Method | Path | Source | Caller | Notes |
|---|---|---|---|---|
| POST | `/opportunities` | manual_form | link-share wizard | **Unchanged contract.** Internally calls `issue()`. |
| POST | `/opportunities/from-ingest` | varies | "I have it" UI mode | NEW. Body: `{ artifactIds[], overrides?, name? }`. |
| POST | `/opportunities/:id/links` | n/a | detail page "Send scoping questions"; replaces inline mint in the wizard | NEW. Body: `{ templateId, expiresInDays?, reason? }`. |
| POST | `/ingest/text` | paste_text | UI paste box | NEW. **Sprint 1.** Body: `{ rawText, hints? }`. |
| POST | `/ingest/file` | direct_upload \| rfp_import \| sow_import | UI file-drop | NEW. **Sprint 1.** Multipart or two-step (presigned PUT then notify). |
| POST | `/ingest/audio` | voice_note | UI audio upload | NEW. **Sprint 2.** Same two-step as file. |
| POST | `/webhooks/whatsapp` | whatsapp_import | Meta Cloud API | NEW. **Sprint 3.** Signed-request verification, no JWT. |
| POST | `/opportunities/from-email` | email_import *(set by us)* | **Outlook add-in (shipped on main)** | **Already live** — narrower contract. See §6. |
| POST | `/ingest/email` | email_import | SES inbound only | NEW. **Sprint 3.** Future server-side inbound mail. |

### 5.2 Auth

- All `/ingest/*` and `/opportunities/*` endpoints — `JwtAuthGuard` + `RolesGuard('sales_employee', 'sales_manager', 'admin')` matching the existing controller.
- Webhooks — provider-specific signature verification, no Rhud JWT. Webhook endpoints will live under `/webhooks/*` to make the lack of JWT explicit.
- SES inbound — shared secret in `X-Rhud-Ingest-Token` header validated against an env var; or replace with sigv4 once we're past MVP.

## 6. Outlook add-in — already shipped (narrow contract)

> **Status: live on `main`** as of `9add052`. The Outlook add-in (`apps/outlook-addin/`) is a Vite + TS task pane that drops a "Create Opportunity" button into the Outlook message-read ribbon. It hits a dedicated endpoint that **deliberately doesn't go through the direct-ingest artifact pipeline below** — it pre-fills the regular link-share path from email metadata instead.

### 6.1 The actual contract

```http
POST /opportunities/from-email
Authorization: Bearer <rep JWT>
Content-Type: application/json

{
  "templateId":          "uuid",      // rep picks in the task pane
  "fromEmail":           "alex@northwind.io",
  "subject":             "Need pen test for Q4",
  "bodyText":            "Hi team, ...",       // ≤ 20 KB
  "messageId":           "<abc123@outlook.com>",  // RFC 5322 Message-Id
  "fromName":            "Alex Park",           // optional
  "clientNameOverride":  "Acme Corp",           // optional rep edit
  "source":              "outlook"              // 'outlook' | 'gmail' | 'manual_paste'
}

→ 201
{
  "engagementId": "uuid",
  "token":        "...",                       // gathering token (link is auto-minted)
  "url":          "https://rhud.net/g/<token>",
  "expiresAt":    "2026-06-03T..."
}
```

### 6.2 How it differs from the direct-ingest pipeline

| Dimension | Outlook (`/opportunities/from-email`) | Direct-ingest (`/ingest/text`, `/ingest/file`, `/opportunities/from-ingest`) |
|---|---|---|
| Template required? | **Yes** — rep picks in the task pane | No — `templateId` stays NULL until the rep issues a scoping link |
| Gathering link issued? | Yes, immediately (`issue()` path) | No — link is opt-in via `POST /opportunities/:id/links` |
| Email body lands as… | A snippet in the `engagement_created_from_email` thread event payload | A full `EngagementFile` in S3 + LLM extraction runs |
| Engagement status starts at | `issued` | `ingesting` |
| Dedupe key | `engagements.source_message_id` (per-tenant unique) | `ingestion_artifacts.external_id` (partial index) |
| Thread event emitted | `engagement_created_from_email` | `requirements_ingested` |
| `Engagement.source` value | `email_import` *(set by issueFromEmail)* | `paste_text` / `direct_upload` / etc. |

### 6.3 Why two paths

The Outlook team's narrower approach made sense for the add-in's UX: the rep is already deciding "this email is a scoping opportunity for service line X" — they want to pick a template right there. A full direct-ingest flow (no template, extract the body, ask the rep to attach a template later) would have been more clicks for the same outcome.

The direct-ingest pipeline targets a different shape: the rep has *raw* requirements (a WhatsApp screenshot, a voice memo, an SOW PDF) where extraction adds value before a template is chosen.

Both write into the same `Engagement` row shape (now with `source`, `templateId?`, `source_message_id?`, `ingestion_id?` columns side by side). The source chip on list/detail (§7.3) reads `source` and presents the right channel label regardless of which path created the row.

### 6.4 Future: SES inbound (Sprint 3)

A separate `POST /ingest/email` will land in Sprint 3 for **server-side inbound mail** (SES inbound rule → API). That path *will* go through the direct-ingest pipeline (artifact → S3 → extraction) because no rep is in the loop to pick a template. The Outlook add-in path stays as-is; the two coexist by source value.

## 7. UI changes (web)

### 7.1 `/opportunities/new` — mode toggle

Add a segmented control above the existing 3-step wizard:

```
┌────────────────────────────────────┬──────────────────────────────────────┐
│ ▼ Send a scoping link              │   I already have it                  │
│   (existing wizard)                │   (drop / paste / upload)            │
└────────────────────────────────────┴──────────────────────────────────────┘
```

**"I already have it"** opens a different layout with three sub-tabs:

1. **Drop files** — drag PDF/DOCX/XLSX/RFP/SOW. Each file shows an extraction status pill (queued → extracting → ready). The first ready file shows a card with the top extracted points so the rep can sanity-check.
2. **Paste text** — large textarea labelled "Paste the email, WhatsApp thread, or your call notes." Counter shows character count (warn at 200KB).
3. **Upload audio** (*Sprint 3*) — file drop for audio, shows a transcription progress bar.

Below the artifact area, the same client-metadata form (email/name/address/contact/phone) appears, **prefilled with values the LLM extracted** from the artifacts. Rep can correct any field. Pressing "Create opportunity" calls `POST /opportunities/from-ingest`.

### 7.2 Opportunity detail page — "Send scoping questions" card

A new card on the right rail, visible on every opportunity (direct-ingest or link-share):

```
┌──────────────────────────────────────┐
│  Need more from the client?         │
│  ────────────────────────────       │
│  Send a scoping link with a few     │
│  follow-up questions.               │
│                                      │
│  [ Send scoping questions ]          │
│                                      │
│  Past links (1)                     │
│   • Live · expires May 30 (revoke)  │
└──────────────────────────────────────┘
```

Pressing the button opens the existing template-picker + TTL modal (extracted from `/opportunities/new` into a reusable component) and calls `POST /opportunities/:id/links`. For direct-ingest opportunities this is the *first* link; for link-share opportunities it's a re-issue.

### 7.3 List + detail page — `source` chip

Show the source as a small chip next to the opportunity title:
`manual_form` → "Link" · `email_import` → "Email" · `direct_upload` → "Upload" · `paste_text` → "Notes" · `whatsapp_import` → "WhatsApp" · `voice_note` → "Voice" · etc.

## 8. Verification

End-to-end test scenarios for Sprint 1 acceptance:

1. **Paste-text happy path**
   - POST `/ingest/text` with raw text (or via the UI paste box).
   - Assert: `IngestionArtifact` (kind=text, source=paste_text) + `EngagementFile` (text/plain in S3) + `Engagement` row with `source=paste_text`, `templateId=null`, `status=ingesting`. `requirements_ingested` event in the thread.
   - Poll: extraction completes; structured points non-empty; engagement moves to `status=submitted`.
2. **File-drop happy path (PDF)**
   - POST `/ingest/file` with a PDF (or via the UI drop zone).
   - Assert: `IngestionArtifact` (kind=file, source=direct_upload) + `EngagementFile` with `originArtifactId` set + `Engagement` row. Extraction completes; structured points reflect PDF content.
3. **Direct-ingest then re-scope**
   - Create direct-ingest opportunity via the UI "I have it" mode.
   - Press "Send scoping questions" → `POST /opportunities/:id/links` with a templateId.
   - Assert: `GatheringToken` minted, `link_issued` event present (first link on this engagement), `engagement.templateId` populated. Opening the link as the client works exactly as the link-share flow.
4. **Re-issue on existing link-share opportunity**
   - Create via the original `POST /opportunities`.
   - Call `POST /opportunities/:id/links` again with a different templateId.
   - Assert: a second `GatheringToken` row, `link_reissued` event (not `link_issued`).
5. **Proposal without template**
   - Direct-ingest opportunity with no template ever attached.
   - Trigger proposal draft.
   - Assert: draft renders (LLM synthesis path), no crash on missing `template.serviceLine` / `template.proposalScaffold`.
6. **Backfill correctness**
   - All pre-migration `Engagement` rows have `source=manual_form` post-migration. No row has null `source`.

Deferred (later sprints):
- **Email-ingest endpoint** (`POST /ingest/email`) — covered when Sprint 3 lands.
- **WhatsApp webhook** — covered when Sprint 3 lands.
- **Voice ingest** — covered when Sprint 2 lands.

## 9. Sprint sequencing

| Sprint | Scope | Exit criteria |
|---|---|---|
| **0 — Doc + pre-flight (this sprint)** | Land this doc. Spike: verify proposal/classification/pricing/gathering fallback with `template=null` (read-only investigation). | **Done.** Doc approved; pre-flight findings captured in §11 (6 must-fix sites, 1 invariant codified). |
| **1 — Foundation + in-app direct-ingest** | Prisma migration: `EngagementSource` enum, nullable `templateId`/`templateVersion`, new `IngestionArtifact` model, `EngagementFile.originArtifactId`, new `ingesting` status. `IngestionService` skeleton + `receive` / `promote` / `receiveAndPromote`. `POST /ingest/text` and `POST /ingest/file`. `POST /opportunities/from-ingest`. `POST /opportunities/:id/links` + extract the link-mint logic into a reusable service method. New thread events (`requirements_ingested`, `link_reissued`). Backfill `source=manual_form` on existing rows. `ProposalDraftService` null-template fallback. UI: mode toggle on `/opportunities/new` + "I have it" sub-tabs for drop and paste + "Send scoping questions" card on detail page + source chip on list/detail. | Rep can create an opportunity from a PDF, DOCX, RFP, SOW, or pasted text end-to-end via the UI. Rep can issue a (re-)scoping link from any opportunity. Existing link-share flow still passes its tests. |
| **2 — Voice + RFP/SOW hinting** | Voice provider selection (Whisper / Transcribe / AssemblyAI — see §10). `POST /ingest/audio` + STT pipeline. UI audio-upload tab. Document-type classifier annotates `source` as `rfp_import` / `sow_import` when applicable. | Audio note becomes an opportunity. Tender / SOW files surface a distinguishing chip. |
| **3 — WhatsApp + inbound email** | WhatsApp webhook (`POST /webhooks/whatsapp`) with Meta signature verification. SES inbound rule → `POST /ingest/email` via shared-secret header. Webhook-arrived artifacts land in a "pending promotion" inbox the rep reviews and promotes. | WhatsApp message becomes an opportunity (with rep review). Emails forwarded to a Rhud inbox become opportunities. |
| **Outlook add-in** *(already shipped — see §6)* | Already on `main` via `9add052`. `POST /opportunities/from-email`, narrow contract: pre-fills the link-share wizard from an Outlook message. Doesn't use the direct-ingest pipeline. | ✅ Live. The only follow-up here is the **source-attribution tweak** (Sprint 1 close-out): `issueFromEmail` sets `engagement.source = 'email_import'` so the chip reads "Email" rather than the default "Link". |

Sprint 1 closes the PM's gap for the in-app channels (paste / drop / RFP / SOW). Sprints 2-3 add voice and webhook channels. Sprint 4 is held until the Outlook extension work resumes.

## 10. Open questions

1. **`importedFromOdoo` → `source=odoo_import` migration timing.** Backfill in Sprint 1 or wait? Cost: a one-time pass over Odoo-imported engagements.
2. **Artifact retention.** How long do we keep raw artifacts (`IngestionArtifact.rawText`, attached S3 objects) after promotion? Sensible default: same TTL as `EngagementFile`. Worth an explicit policy in the next iteration.
3. **PII in artifacts.** Email bodies and WhatsApp messages may contain client PII the existing redaction pipeline doesn't see. Sprint 2 should run the same PII watermark/redaction the link-share file path uses.
4. **Voice provider.** Whisper API (OpenAI) vs AWS Transcribe vs AssemblyAI — cost, latency, and tenant data-residency implications. Decision deferred to Sprint 3 kickoff.
5. **Outlook add-in auth.** *(Resolved on `main`.)* The shipped add-in uses `Office.context.ui.displayDialogAsync` to bridge sign-in to a same-origin `addin.rhud.net/login` page, then passes the JWT back via `messageParent`. Rep JWT in `localStorage` of the task pane is the v1 approach. If long-lived background flows ever surface, revisit.

## 11. Sprint 0 pre-flight findings — null-template audit

Audit ran 2026-05-27 against `apps/api/src/**` to catalogue every code path that would crash when `engagement.templateId` is null. Result: **6 must-fix sites across 4 files**, plus an invariant clarification for the gathering flow.

### 11.1 Must-fix before migration (Sprint 1)

| # | File:line | Issue | Fix |
|---|---|---|---|
| 1 | `apps/api/src/llm/proposal-draft.service.ts:956` | `loadContext` dereferences `engagement.template.name / .serviceLine / .gammaTemplateId / .proposalScaffold` | Optional chaining + defaults. Skip scaffold path entirely when null. |
| 2 | `apps/api/src/llm/proposal-draft.service.ts:243` | Scaffold short-circuit guards on `proposalScaffold` truthiness but assumes `template` is non-null inside `buildScaffoldContext()` | Add `if (ctx.template !== null && ctx.proposalScaffold)` guard; LLM-synthesis path for null. |
| 3 | `apps/api/src/gathering/gathering.service.ts:242` (and the parallel block at `:613`) | Token resolution `.include({ template: { include: { nodes } } })` then dereferences `engagement.template.{id,tenantId,serviceLine,name,version,status,rootNodeId,nodes}` | **Fail loud, not silent.** Add an entry-point guard: if `engagement.templateId IS NULL`, throw `NotFoundException('no_template_attached')`. The gathering link only makes sense when a template exists — this enforces the invariant in §3.2. |
| 4 | `apps/api/src/gathering/gathering.service.ts:380` | `const rateCardId = engagement.template.rateCardId;` | Same: caller should not reach this code path on a template-less engagement; entry-point guard from #3 covers it. |
| 5 | `apps/api/src/llm/justification.service.ts:113-114` | Dereferences `engagement.template.name` and `.serviceLine` | Optional chaining: `template?.name ?? '(No template)'`, `template?.serviceLine ?? 'General'`. |
| 6 | `apps/api/src/notifications/notifications.service.ts:146` | `templateName: engagement.template.name` | `template?.name ?? '(Untitled)'`. |

### 11.2 Confirmed safe (no changes needed)

- **`ClassificationService.loadContext()`** (`apps/api/src/classification/classification.service.ts:276`) already uses `eng.template?.serviceLine ?? null`. Direct-ingest engagements pass `serviceLine=null` to the classifier; the existing prompt handles the ambiguous case ("prefer the most specific category"). ✓
- **`ExtractionService`** (`apps/api/src/extraction/extraction.service.ts:405-410`) — rate-card lookup already optional-chains. `matchPointsToTemplate` at `:659-673` returns an empty array when `templateId=null` (query returns no rows). Extraction proceeds with unmatched points, which is the intended behaviour. ✓
- **`RateCardMapperService`** — no template reads. Pricing depends on rate card + extracted entities, not template-keyed answers. ✓
- **`Engagement` row-level reads** in controllers — surveyed; existing optional chaining covers list/summary responses. ✓

### 11.3 Nice-to-have (Sprint 1 or 2)

- **Web app opportunity detail page** (`apps/web/src/app/opportunities/[id]/page.tsx` and child components) — likely renders a template chip / metadata section. Audit when implementing the source chip (§7.3) to avoid undefined renders. Not a crash risk (React tolerates missing props), but produces ugly UI.

### 11.4 Invariant codified

Add to `apps/api/src/engagements/engagements.service.ts`:

> **Invariant**: `Engagement.templateId IS NULL ⇔ no GatheringToken exists for this engagement.`
>
> Enforced at two points:
> 1. `issueLinkForExisting()` sets `engagement.templateId` and `templateVersion` as part of the mint transaction; idempotent if values are already set.
> 2. `GatheringService` entry-point guard (fix #3 above) throws `no_template_attached` if a token is somehow resolved against a template-less engagement.

### 11.5 Migration risk assessment

- **Reversibility**: schema change is forward-only (nullable columns can't easily be made non-null again if any nullable rows exist). Backfill `source=manual_form` on existing rows is non-destructive; the templateId/templateVersion of existing rows stays populated.
- **Rollout**: ship the 6 fixes in §11.1 in the same PR as the Prisma migration so the codebase is null-safe at the moment templates become nullable. No window where a query path can crash on prod data.
- **Total fix effort**: ~10 fix points, ~30 LOC of guarded logic across 4 files. Low-risk.
