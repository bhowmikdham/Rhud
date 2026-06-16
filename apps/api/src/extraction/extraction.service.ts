/**
 * Document extraction pipeline.
 *
 * Client-uploaded files (typically requirements PDFs, scope spreadsheets,
 * or one-pager briefs) are extracted into structured pricing-relevant
 * data points so the rep + the ML model see everything the client
 * dropped in. Two stages:
 *
 *   1. Text extraction — pure-JS, content-type-driven:
 *        - application/pdf            → pdf-parse
 *        - .xlsx / .xls / spreadsheet → exceljs (cell-by-cell)
 *        - text/* / csv               → utf8 decode
 *        - other                      → marked `skipped`
 *
 *   2. LLM structuring — the per-tenant LlmService is given the
 *      template's questions plus the extracted text and asked for a
 *      JSON list of `{ key, value, sourceQuote, relatedQuestion }`
 *      points. Manual provider tenants get a `skipped` outcome (the
 *      paste-and-return flow doesn't make sense for per-file work).
 *
 * State machine on engagement_files:
 *
 *   null → pending → processing → ready
 *                              └─→ failed
 *                              └─→ skipped
 *
 * Re-running extraction (manual button) wipes existing points + flips
 * back to `processing`. A fire-and-forget kickoff is the entry point;
 * callers don't `await` the heavy work — they poll the row instead.
 */

import { Injectable, Logger, NotFoundException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RhudDocument } from '@rhud/shared';

// Prisma's nullable-Json columns require this explicit sentinel rather
// than a literal `null`. Aliased here so the explicit-null intent reads
// clearly at the persistence call site.
const PrismaJsonNull = Prisma.JsonNull;
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { S3Service } from '../storage/s3.service.js';
import { LlmService } from '../llm/llm.service.js';
import { MlService } from '../ml/ml.service.js';
import { QuoteService } from '../pricing/quote.service.js';
import { createHash } from 'node:crypto';
import { PricingService } from '../pricing/pricing.service.js';
import {
  RateCardFieldMapperService,
  MAPPER_PROMPT_VERSION,
  type InferredEntity,
} from '../pricing/rate-card-mapper.service.js';
import { ThreadService } from '../thread/thread.service.js';
import { buildPromotionPlan } from './inferred-promote.js';
import type { ChatMessage } from '../llm/llm.types.js';
import {
  parseSpreadsheetStructured,
  parseSpreadsheetToDocument,
  documentToRawPoints,
  documentToLlmText,
  scoreLabelMatch,
  type RawPoint,
} from './spreadsheet.parser.js';

/** Cap on text we hand to the LLM. Bigger inputs hit the provider's
 *  context window AND eat into per-minute token budgets. Gemini's
 *  paid tier in particular has a per-minute TPM ceiling that one
 *  chunky XLSX can blow on a single call.
 *
 *  15K chars is ~3.5K tokens — leaves room for the question list +
 *  system prompt (~2K tokens) inside ~6K total per call, which fits
 *  every paid tier's per-minute window with headroom for a retry.
 *
 *  When the document is larger we keep the head + tail; boilerplate
 *  in the middle is usually the least signal-dense part. */
/**
 * Single-call budget for the LLM extractor (input text). 30K chars is
 * roughly 7-8K tokens — comfortably inside the input window of every
 * provider we ship (Gemini Flash, gpt-4o-mini, Claude Haiku at minimum).
 * Documents larger than this get the chunked path below.
 */
const MAX_TEXT_CHARS = 30_000;
/** Per-chunk size when chunking large docs. Slightly under the single-
 *  call cap so chunk-1 + a small overlap fits each call's window. */
const CHUNK_TEXT_CHARS = 25_000;
/** Overlap between consecutive chunks. Reading question phrases that
 *  span a chunk boundary becomes possible because both halves see them. */
const CHUNK_OVERLAP_CHARS = 1_500;
/** Hard cap on chunk count — a 1MB doc would otherwise produce 40
 *  chunks. After this many we trust we've sampled enough. */
const MAX_CHUNKS = 12;

/** Max length per spreadsheet cell. Stops a single comment-style cell
 *  from dominating the entire document budget. */
const MAX_CELL_CHARS = 280;
/** Max joined-row length. Wide questionnaires with 30+ columns can
 *  exceed 1KB per row; truncate so the head/tail trim above keeps
 *  more rows alive. */
const MAX_ROW_CHARS = 600;

/** Cap stored text. Same shape as MAX_TEXT_CHARS but a touch larger
 *  so the UI's "view full extracted text" affordance can show more
 *  than what we shipped to the LLM. */
const MAX_STORED_TEXT = 200_000;

/** Cap on individual extracted-point fields so a runaway LLM can't
 *  blow up a postgres row. */
const MAX_VALUE_LEN = 1_000;
const MAX_QUOTE_LEN = 500;

/** Layer 2 categories — semantic classification each extracted point
 *  gets tagged with so the UI can show what kind of data was found
 *  and the downstream pipeline can route by category. */
export type PointCategory =
  | 'scope'         // numeric scale: pages, apis, users, counts
  | 'methodology'   // testing approach: black/grey box, va, pt
  | 'service_type'  // domain: web, mobile, api, thick client, network
  | 'identity'      // names, emails, phones, company, contact info
  | 'environment'   // cloud, on-prem, host, staging, production
  | 'compliance'    // soc, iso, pci, hipaa, gdpr
  | 'other';        // doesn't fit the above

export interface ExtractedPoint {
  /** snake_case identifier — `team_size`, `compliance_required`, etc. */
  key: string;
  /** The extracted value. Always a string for storage simplicity;
   *  numeric-looking values stay as their literal string form. */
  value: string;
  /** Verbatim quote from the document this point was lifted from.
   *  Empty string when the LLM couldn't tie it to a span. */
  sourceQuote: string;
  /** Matching template question key when the point answers one of
   *  the template's questions; null when it's a "bonus" signal the
   *  document carried but no question asked. */
  relatedQuestion: string | null;
  /** Sheet name the point came from, when extracted from a multi-sheet
   *  spreadsheet. `null` for PDFs / single-sheet xlsx / LLM extracts.
   *  Surfaces in the UI as a per-sheet count breakdown so the rep can
   *  verify every tab contributed signal. */
  sheet?: string | null;
  /** Application instance this point belongs to, for WIDE multi-app
   *  questionnaires (questions in one column, each app's answers in its
   *  own column). Lets the mapper price every app separately and the UI
   *  show per-app scope. Undefined for ordinary single-app sheets. */
  appId?: string;
  /** Layer-2 semantic classification. Computed by `categorisePoint`
   *  at extraction time. Surfaces as a chip in the UI so the rep can
   *  spot misclassifications (e.g. an identity field mistakenly
   *  flagged as scope). */
  category?: PointCategory;
}

export interface FileExtractionRow {
  id: string;
  filename: string;
  contentType: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped' | 'retry_queued' | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** When status === 'retry_queued', the ISO timestamp the cron will
   *  re-fire. Null otherwise. The UI uses this to render a live
   *  countdown so the rep can see *something* will happen on its own. */
  retryAt: string | null;
  /** Retry attempts so far (1-indexed at the moment of retry). */
  attempts: number;
  error: string | null;
  points: ExtractedPoint[];
  /** Layer 3 — service-line entities the field mapper inferred from
   *  this file's points. Surfaced so the rep can see WHY each line is
   *  priced (reasoning + sourceQuote) and override scope value /
   *  methodology / customer type when the model was conservative. */
  inferredEntities: InferredEntity[];
  /** True when the LLM produced no points — surfaces "extracted but
   *  found nothing useful" distinctly from "extraction failed". */
  emptyResult: boolean;
  /**
   * Diagnostic counts so the user can see exactly where the
   * extraction-to-pricing chain breaks. When the price comes back at
   * INR 0, this tells them whether (a) we extracted nothing useful,
   * (b) we matched but the template's questions have no rate-card
   * bindings, or (c) the rate card has no tiers that match the
   * answers. Computed at read-time from the points + the engagement's
   * current quote breakdown, so it always reflects the live state.
   */
  diagnostics: {
    /** Total points the extraction produced (Layer 1). */
    extracted: number;
    /** Subset that matched a template question (relatedQuestion set). */
    matchedToQuestion: number;
    /** Layer 3 inference — high-confidence service-line entities the
     *  field mapper produced (LLM-first, heuristic safety net). >0
     *  here means doc-only pricing is healthy regardless of whether
     *  any template question got matched. */
    inferredHighConfidence: number;
    /** Engagement-wide: how many template questions actually have an
     *  answer (form OR auto-promoted). */
    answeredQuestions: number;
    /** Service-line entities the rate-card field mapper produced
     *  directly from extracted points (independent of template
     *  questions). > 0 here even with `matchedToQuestion = 0` means
     *  the doc-only pricing path is working. */
    mappedToRateCard: number;
    /** How many priced line items the current quote has — i.e. how
     *  many answers translated into bookable money. Zero here means
     *  the issue is on the rate-card side. */
    quoteLineItems: number;
    /** Whether the engagement's template actually has a rate card
     *  bound. False = nothing pricing can do regardless of input. */
    rateCardBound: boolean;
  };
}

/** Max times we'll retry a single file before giving up. After this
 *  the row flips to `failed` and the rep needs to act manually
 *  (re-extract / switch provider / wait for tier reset). */
const MAX_RETRY_ATTEMPTS = 5;

/** Delay schedule for retry-queued items. First retry waits 90s
 *  (cleanly past the per-minute throttle window), then doubles up to
 *  10 min. Per-minute LLM budgets reset every minute, but credit
 *  budgets reset hourly — the longer waits let those recover too. */
const RETRY_DELAY_MS = [
  90_000,    // attempt 1 → wait 90s
  180_000,   // attempt 2 → wait 3m
  300_000,   // attempt 3 → wait 5m
  600_000,   // attempt 4 → wait 10m
  600_000,   // attempt 5 → wait 10m
];

/** How often the cron sweeps for due retries. Tighter than the
 *  shortest retry delay so we don't over-shoot the wake time. */
const RETRY_TICK_MS = 30_000;

@Injectable()
export class ExtractionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ExtractionService.name);
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly unscoped: UnscopedDb,
    private readonly s3: S3Service,
    private readonly llm: LlmService,
    private readonly thread: ThreadService,
    private readonly ml: MlService,
    private readonly quotes: QuoteService,
    private readonly pricing: PricingService,
    private readonly fieldMapper: RateCardFieldMapperService,
  ) {}

  // ── Cron-style retry sweeper ──────────────────────────────────────
  //
  // Runs every RETRY_TICK_MS, pulls files where extraction_status =
  // 'retry_queued' AND retry_at <= now(), and re-fires kickoff. The
  // SystemPrismaService bypass is needed because the cron has no
  // tenant scope; we look across tenants and dispatch each via the
  // tenant-scoped path inside `kickoff`.

  onModuleInit(): void {
    this.retryTimer = setInterval(() => {
      void this.sweepDueRetries().catch((e) => {
        this.logger.warn(`extraction retry sweep failed: ${(e as Error).message}`);
      });
    }, RETRY_TICK_MS);
    // Don't keep the process alive purely for the timer.
    this.retryTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  /** Find every file due for a retry across the whole platform and
   *  re-kick its extraction. Cross-tenant find via the system role
   *  (curated UnscopedDb method), then per-row dispatch via the
   *  tenant-scoped kickoff. */
  private async sweepDueRetries(): Promise<void> {
    const due = await this.unscoped.findDueExtractionRetries(50);
    for (const f of due) {
      this.logger.log(`extraction retry firing file=${f.id} attempt=${f.attempts + 1}`);
      void this.kickoff(f.tenantId, f.id).catch(() => undefined);
    }
  }

  // ── Public surface ────────────────────────────────────────────────

  /**
   * Kick off extraction for a file. Fire-and-forget: returns once the
   * row has been moved to `processing`; the heavy work runs in the
   * background and the caller polls.
   *
   * Idempotent — re-calling on a `processing` file is a no-op; on
   * `ready` / `failed` / `skipped` it resets and re-runs.
   */
  async kickoff(tenantId: string, fileId: string): Promise<void> {
    const moved = await this.tenantDb.run(tenantId, async (db) => {
      // Use a conditional update so two concurrent kickoffs don't both
      // win — the second one sees status='processing' and bails.
      const row = await db.engagementFile.findUnique({
        where: { id: fileId },
        select: { id: true, extractionStatus: true },
      });
      if (!row) return null;
      if (row.extractionStatus === 'processing') return null;

      await db.engagementFile.update({
        where: { id: fileId },
        data: {
          extractionStatus: 'processing',
          extractionStartedAt: new Date(),
          extractedAt: null,
          extractionError: null,
          extractedPoints: [],
          // Clear the retry handle so a re-kick from the cron OR a
          // manual Re-extract doesn't loop with stale scheduling.
          extractionRetryAt: null,
        },
      });
      return row.id;
    });
    if (!moved) return;

    // Don't `await` — heavy work runs after the request returns.
    void this.runExtraction(tenantId, fileId).catch((e) => {
      this.logger.error(`extraction crashed file=${fileId}: ${(e as Error).message}`);
    });
  }

  /**
   * Kick off extraction for every file on an engagement that hasn't
   * been processed yet (or failed last time). Used by the gathering
   * "submit scope" path so the predict step has structured data to
   * read.
   *
   * Skips `retry_queued` rows — the cron has them; double-firing
   * would just hit the same rate limit again. Also skips
   * `processing` so we don't race an in-flight worker.
   */
  async kickoffForEngagement(tenantId: string, engagementId: string): Promise<number> {
    const files = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.findMany({
        where: {
          engagementId,
          OR: [
            { extractionStatus: null },
            { extractionStatus: 'failed' },
            { extractionStatus: 'pending' },
          ],
        },
        select: { id: true },
      }),
    );
    for (const f of files) {
      await this.kickoff(tenantId, f.id);
    }
    return files.length;
  }

  /**
   * Snapshot of every file on the engagement + its extraction state.
   * The shape is what the opportunity page renders — list of files,
   * statuses, points. Sorted oldest-first to match upload order.
   */
  async listForEngagement(tenantId: string, engagementId: string): Promise<FileExtractionRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagementFile.findMany({
        where: { engagementId },
        orderBy: { uploadedAt: 'asc' },
        select: {
          id: true, filename: true, contentType: true,
          extractionStatus: true, extractionStartedAt: true,
          extractedAt: true, extractionError: true, extractedPoints: true,
          extractionRetryAt: true, extractionAttempts: true,
          inferredEntities: true,
        },
      });

      // Engagement-wide signals — read once, share across every file
      // row. Tells the rep whether the chain breaks at extraction,
      // matching, or rate-card pricing.
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { templateId: true, rateCardId: true },
      });
      const answeredQuestions = await db.engagementAnswer.count({
        where: { engagementId },
      });
      const quote = await db.engagementQuote.findFirst({
        where: { engagementId },
        orderBy: { computedAt: 'desc' },
        select: { baseBreakdown: true },
      });
      const breakdown = Array.isArray(quote?.baseBreakdown)
        ? (quote!.baseBreakdown as unknown as Array<{ entityId?: string }>)
        : [];
      const quoteLineItems = breakdown.length;
      // Lines the rate-card field mapper produced have `entityId`
      // prefixed `extracted-llm:` or `extracted-heuristic:`.
      const mappedToRateCard = breakdown.filter(
        (l) => typeof l.entityId === 'string' && l.entityId.startsWith('extracted'),
      ).length;
      // High-confidence inference count across all files — Layer 3
      // signal. Lets the user see "the LLM did decide on N service
      // lines" even before the quote runs.
      const inferredHighConfidence = rows.reduce((sum, r) => {
        if (!Array.isArray(r.inferredEntities)) return sum;
        const arr = r.inferredEntities as unknown as Array<{ confidence?: number }>;
        return sum + arr.filter((e) => (e.confidence ?? 0) >= 0.6).length;
      }, 0);
      // Direct-ingest engagements may have no template attached
      // (docs/direct-ingest.md §3.2). In that case there's no rate
      // card to look up — leave `tpl` null and downstream logic falls
      // back to its "no rate card bound" path.
      const tpl = eng?.templateId
        ? await db.template.findUnique({
            where: { id: eng.templateId },
            select: { rateCardId: true },
          })
        : null;
      // Effective rate card: direct attachment on the opportunity wins,
      // else the template's binding. Drives the "rate card ✓/✗" chip.
      const rateCardBound = !!(eng?.rateCardId ?? tpl?.rateCardId);

      return rows.map((r) => {
        const points = Array.isArray(r.extractedPoints)
          ? (r.extractedPoints as unknown as ExtractedPoint[])
          : [];
        const matchedToQuestion = points.filter((p) => p.relatedQuestion).length;
        const inferredEntities = Array.isArray(r.inferredEntities)
          ? (r.inferredEntities as unknown as InferredEntity[])
          : [];
        return {
          id: r.id,
          filename: r.filename,
          contentType: r.contentType,
          status: r.extractionStatus as FileExtractionRow['status'],
          startedAt: r.extractionStartedAt?.toISOString() ?? null,
          finishedAt: r.extractedAt?.toISOString() ?? null,
          retryAt: r.extractionRetryAt?.toISOString() ?? null,
          attempts: r.extractionAttempts,
          error: r.extractionError,
          points,
          inferredEntities,
          emptyResult: r.extractionStatus === 'ready' && points.length === 0,
          diagnostics: {
            extracted: points.length,
            matchedToQuestion,
            inferredHighConfidence,
            answeredQuestions,
            mappedToRateCard,
            quoteLineItems,
            rateCardBound,
          },
        };
      });
    });
  }

  /**
   * True when every file on the engagement has reached a terminal
   * state (`ready` / `failed` / `skipped`) — i.e. the price-prediction
   * gate can fire. `null` (legacy rows that pre-date the feature) is
   * treated as terminal to avoid blocking older opportunities.
   *
   * `retry_queued` counts as in-flight: a file scheduled for retry
   * could still produce points, so we shouldn't predict prematurely.
   */
  async isAllSettled(tenantId: string, engagementId: string): Promise<boolean> {
    const inFlight = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.count({
        where: {
          engagementId,
          extractionStatus: { in: ['pending', 'processing', 'retry_queued'] },
        },
      }),
    );
    return inFlight === 0;
  }

  // ── Internals — the actual extraction work ────────────────────────

  private async runExtraction(tenantId: string, fileId: string): Promise<void> {
    let file;
    try {
      file = await this.tenantDb.run(tenantId, async (db) =>
        db.engagementFile.findUnique({
          where: { id: fileId },
          select: {
            id: true, engagementId: true, filename: true,
            contentType: true, s3Key: true,
          },
        }),
      );
    } catch (e) {
      this.logger.error(`extraction load failed file=${fileId}: ${(e as Error).message}`);
      return;
    }
    if (!file) {
      await this.markFailed(tenantId, fileId, 'engagement_file_not_found');
      return;
    }

    // Step 1 — fetch the bytes once. Used by the structured spreadsheet
    // path (when applicable) AND the text-extraction-then-LLM path.
    let bytes: Buffer;
    try {
      bytes = await this.s3.fetchBytes(file.s3Key);
    } catch (e) {
      const err = e as Error & { retryable?: boolean };
      this.logger.error(`s3 fetch failed file=${fileId}: ${err.message}`);
      // S3Service tags transient failures (NoSuchKey races,
      // 5xx, network) with `retryable: true`. Route those to the
      // extraction retry queue so a delayed PUT or eventual-consistency
      // hiccup doesn't permanently fail the file. P1-8 in
      // majestic-whistling-whistle.md.
      if (err.retryable) {
        await this.queueForRetry(tenantId, fileId, `s3_fetch:${err.message}`);
      } else {
        await this.markFailed(tenantId, fileId, `s3_fetch:${err.message}`);
      }
      return;
    }

    // Step 2 — structural shortcut for spreadsheets. Most security
    // questionnaires + scoping docs are clean two-column Q/A sheets;
    // we can pull the answers deterministically with no LLM round-trip.
    // Wins: instant, free, no rate limits, no rate-card mismatch errors.
    // The parser returns null for files it can't make sense of (free-
    // form prose docs, unconventional layouts), in which case we fall
    // through to the LLM path below.
    let parsedDocument: RhudDocument | null = null;

    if (this.isSpreadsheet(file.contentType, file.filename)) {
      try {
        // Phase B canonical-Document path: parse xlsx → RhudDocument,
        // then run the same Q/A heuristic against the Document. The
        // Document carries every cell, merge anchors, and detected
        // sheet shape — useful for the LLM-fallback path below and
        // for future admin-review tooling. documentToRawPoints applies
        // the existing 7-hit threshold + dedup-across-sheets rules,
        // so the output is bit-identical to the legacy path.
        const doc = await parseSpreadsheetToDocument(bytes, {
          id: fileId,
          filename: file.filename,
          contentType: file.contentType,
        });
        if (doc) parsedDocument = doc; // capture for persistence even when Q/A fails
        const raw = doc ? documentToRawPoints(doc) : null;
        if (raw && raw.length > 0) {
          const points = await this.matchPointsToTemplate(tenantId, file.engagementId, raw);
          this.logger.log(
            `extraction structured file=${fileId} points=${points.length} (skipped LLM)`,
          );
          // Persist with the joined text content so the UI's "extracted
          // text" view still has something to show.
          const text = raw
            .map((r) => `[${r.sheetName}] ${r.label}: ${r.value}`)
            .join('\n');
          await this.persistResult(tenantId, fileId, text, points, parsedDocument);
          return;
        }
      } catch (e) {
        // Don't fail outright — fall through to the LLM path which
        // can handle quirky layouts.
        this.logger.warn(`structured xlsx parse failed file=${fileId}: ${(e as Error).message}`);
      }
    }

    // Step 3 — text extraction (PDF text layer / xlsx fallback / plain text).
    let text: string;
    try {
      const out = await this.extractText(bytes, file.contentType, file.filename, fileId);
      if (out === null) {
        await this.markSkipped(tenantId, fileId, `unsupported_content_type:${file.contentType}`);
        return;
      }
      text = out.text;
      // Capture Document from PDF / DOCX paths. Fall back to whatever
      // the structural-shortcut already captured for xlsx (parsedDocument
      // may be non-null even though we fell through to the LLM path).
      if (out.document) parsedDocument = out.document;
    } catch (e) {
      this.logger.error(`text extraction failed file=${fileId}: ${(e as Error).message}`);
      await this.markFailed(tenantId, fileId, `text_extraction:${(e as Error).message}`);
      return;
    }

    // Step 4 — LLM structuring (used only when structural parsing didn't apply).
    let points: ExtractedPoint[];
    try {
      const provider = await this.llm.getProviderName(tenantId);
      if (!provider) {
        // Tenant hasn't configured AI yet — store the text but leave
        // points empty. They can re-run after Settings → AI is set up.
        await this.persistResult(tenantId, fileId, text, [], parsedDocument);
        return;
      }
      if (provider === 'manual') {
        // Per-file paste-and-return doesn't make sense for the rep at
        // scale. Skip and surface in the UI as "Manual AI mode — use
        // an automated provider for document extraction."
        await this.markSkipped(tenantId, fileId, 'manual_provider_unsupported');
        return;
      }
      points = await this.runLlmExtraction(tenantId, file.engagementId, text);
    } catch (e) {
      const raw = (e as Error).message ?? 'unknown';
      this.logger.error(`llm extraction failed file=${fileId}: ${raw}`);

      // Rate-limited → don't surface as failed; queue for a delayed
      // retry. The cron sweeps every 30s and re-kicks once retry_at
      // passes. Attempts beyond MAX_RETRY_ATTEMPTS stop looping and
      // settle into `failed`.
      const isRateLimit = raw.includes('429') || raw.toLowerCase().includes('resource_exhausted');
      if (isRateLimit) {
        await this.queueForRetry(tenantId, fileId, raw);
        return;
      }

      // Map a few common upstream errors to short, human-readable
      // copy. The raw provider blob (Google's nested {error:{code,...}}
      // JSON especially) is hostile in the UI; the chip + tooltip
      // pattern reads it but the inline summary stays scannable.
      let friendly: string;
      if (raw.includes('400') && raw.toLowerCase().includes('model name')) {
        friendly = 'bad_model_name:check_settings_ai';
      } else if (raw.includes('401') || raw.includes('403')) {
        friendly = 'auth_failed:check_api_key_in_settings_ai';
      } else if (raw.includes('timeout')) {
        friendly = 'timeout:document_too_large_or_provider_slow';
      } else {
        friendly = `llm_extraction:${raw}`;
      }
      await this.markFailed(tenantId, fileId, friendly);
      return;
    }

    await this.persistResult(tenantId, fileId, text, points, parsedDocument);
  }

  /** Did this file come in as a spreadsheet? Drives the structured-
   *  parser shortcut in runExtraction. */
  private isSpreadsheet(contentType: string, filename: string): boolean {
    const ct = (contentType || '').toLowerCase();
    const lower = filename.toLowerCase();
    return (
      ct.includes('spreadsheet') ||
      ct === 'application/vnd.ms-excel' ||
      ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      lower.endsWith('.xlsx') ||
      lower.endsWith('.xls')
    );
  }

  /**
   * Map raw `(label, value)` pairs from the structural parser to the
   * shape the rest of the pipeline consumes — including a fuzzy match
   * of each label against the template's questions so auto-promotion
   * to engagement answers works the same as the LLM path.
   *
   * No LLM round-trip; uses the Jaccard token similarity from
   * spreadsheet.parser. Above-0.4 score is treated as a confident
   * match (empirically tuned — works well for security questionnaires
   * where the labels paraphrase the rate-card-bound questions).
   */
  private async matchPointsToTemplate(
    tenantId: string,
    engagementId: string,
    raw: RawPoint[],
  ): Promise<ExtractedPoint[]> {
    const questions = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { templateId: true },
      });
      // Direct-ingest engagements have no template, so there are no
      // template questions to match against — extraction proceeds with
      // unmatched points (the LLM still emits structured key/value
      // pairs; they just don't bind to a node).
      if (!eng?.templateId) return [];
      return db.templateNode.findMany({
        where: {
          templateId: eng.templateId,
          nodeType: { notIn: ['section', 'loop'] },
          parentNodeId: null,
        },
        select: { id: true, question: true },
      });
    });

    return raw.map((r) => {
      // Score this label against every template question; pick the
      // highest as long as it's confident. Falls through to null
      // (point shows in UI but doesn't auto-promote).
      let bestId: string | null = null;
      let bestScore = 0;
      for (const q of questions) {
        const s = scoreLabelMatch(r.label, q.question);
        if (s > bestScore) {
          bestScore = s;
          bestId = q.id;
        }
      }
      // 0.25 threshold tuned for security questionnaires where labels
      // share ~2-3 stop-word-stripped tokens with template questions
      // (e.g. label "Number of Web Applications" vs template "How
      // many web applications need testing?" = ~0.33). 0.4 was too
      // strict in practice — many real matches scored 0.27-0.38.
      const relatedQuestion = bestScore >= 0.25 ? bestId : null;
      return {
        key: r.key.slice(0, 100),
        value: r.value.slice(0, 1_000),
        sourceQuote: `${r.label} | ${r.value}`.slice(0, 500),
        relatedQuestion,
        sheet: r.sheetName || null,
        ...(r.appId ? { appId: r.appId } : {}),
      };
    });
  }

  /**
   * Extract LLM-ready text from a file. Returns the canonical
   * `RhudDocument` alongside the text dump so callers can persist
   * the parsed structure for admin debugging. `document` is null when
   * the format has no Document representation (plain text fallback) or
   * when the bytes were unparseable.
   */
  private async extractText(
    bytes: Buffer,
    contentType: string,
    filename: string,
    fileId: string,
  ): Promise<{ text: string; document: RhudDocument | null } | null> {
    const ct = (contentType || '').toLowerCase();
    const lower = filename.toLowerCase();

    if (ct === 'application/pdf' || lower.endsWith('.pdf')) {
      // Phase B canonical-Document path: parse PDF → RhudDocument with
      // one textBlock per page (split on form-feed), then render to a
      // structure-aware text dump for the LLM. Per-page boundaries +
      // a "# Document: filename.pdf" header give the LLM context it
      // would otherwise lose to a flat text blob.
      const { parsePdfToDocument } = await import('./pdf.parser.js');
      const doc = await parsePdfToDocument(bytes, {
        id: fileId,
        filename,
        contentType,
      });
      // null means scanned/empty — same signal as before. pdf-parse
      // silently returns "" on no-text-layer PDFs; the canonical parser
      // returns null. Surface the same user-facing error so the rep
      // gets a clear "re-export with text" message.
      if (doc === null) {
        if (bytes.length > 1024) {
          throw new Error(
            'pdf_scanned_or_empty: this PDF appears to be a scan with no text layer. ' +
              'Re-export with text or upload the original Word/Excel.',
          );
        }
        return { text: '', document: null };
      }
      return { text: documentToLlmText(doc), document: doc };
    }

    if (
      ct === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ct === 'application/msword' ||  // legacy .doc — we'll detect + reject below
      lower.endsWith('.docx') ||
      lower.endsWith('.doc')
    ) {
      // Legacy .doc (binary OLE) is rare in this segment and mammoth
      // doesn't read it. Refuse explicitly with a usable message.
      if (lower.endsWith('.doc') && !lower.endsWith('.docx')) {
        throw new Error(
          'doc_legacy_unsupported: legacy .doc files aren\'t supported. ' +
            'Save as .docx and re-upload.',
        );
      }
      // Phase B canonical-Document path: parse docx → RhudDocument with
      // text blocks split on detected headings (numbered, ALL-CAPS,
      // Title Case). The LLM extractor then sees `## 1. Application
      // Inventory` style markers it can use to anchor `appId` decisions
      // and split multi-app sections cleanly.
      const { parseDocxToDocument } = await import('./docx.parser.js');
      const doc = await parseDocxToDocument(bytes, {
        id: fileId,
        filename,
        contentType,
      });
      return { text: documentToLlmText(doc), document: doc };
    }

    if (
      ct.includes('spreadsheet') ||
      ct === 'application/vnd.ms-excel' ||
      ct === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
      lower.endsWith('.xlsx') || lower.endsWith('.xls')
    ) {
      // Spreadsheets get their own cap split fairly across sheets —
      // multi-sheet workbooks (the common case for security questionnaires)
      // were starving sheets 2..N when a single global counter let
      // Sheet 1 eat the whole budget. Per-sheet allocation guarantees
      // every sheet contributes signal even when one is a lot busier.
      //
      // 12K total ≈ 3K tokens; with a 1KB-per-sheet floor that's good
      // for ~12 sheets while leaving room for system prompt + question
      // list + output budget within Gemini's per-minute window.
      const SPREADSHEET_TOTAL_CAP = 12_000;
      const SHEET_FLOOR = 1_000; // every sheet gets at least this much
      const ExcelJS = (await import('exceljs')).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(bytes as unknown as ArrayBuffer);
      const sheetCount = Math.max(wb.worksheets.length, 1);
      // Even split, with a per-sheet floor so very-many-sheets workbooks
      // still get something useful from each. If floor*N > total cap,
      // we honour the floor (input may exceed cap; the global trim in
      // trimForPrompt handles the overflow downstream).
      const perSheetCap = Math.max(
        SHEET_FLOOR,
        Math.floor(SPREADSHEET_TOTAL_CAP / sheetCount),
      );

      const lines: string[] = [];
      const seenRows = new Set<string>();
      wb.eachSheet((sheet) => {
        lines.push(`# Sheet: ${sheet.name}`);
        let sheetChars = sheet.name.length + 10;
        // `eachRow` doesn't support early termination — `return` only
        // skips the current row's processing. We use a flag to short-
        // circuit the rest of the sheet once its budget is full.
        let sheetFull = false;
        sheet.eachRow({ includeEmpty: false }, (row) => {
          if (sheetFull) return;
          const cells: string[] = [];
          row.eachCell({ includeEmpty: false }, (cell) => {
            const v = cell.value;
            if (v == null) return;
            // Rich text + hyperlink cells expose .text; plain cells are
            // primitives. Cast through `unknown` to satisfy the union
            // shape exceljs uses for cell.value.
            const obj = v as unknown as { text?: unknown };
            const raw = typeof v === 'object' && obj.text != null
              ? String(obj.text)
              : String(v);
            // Per-cell truncation — long comment cells in
            // questionnaires are often boilerplate and dominate the
            // token budget without helping extraction.
            const trimmed = raw.length > MAX_CELL_CHARS
              ? raw.slice(0, MAX_CELL_CHARS) + '…'
              : raw;
            cells.push(trimmed);
          });
          // Skip rows that are all whitespace / punctuation noise (gives
          // questionnaires with section dividers + empty separator rows
          // far more useful content per byte).
          const joined = cells.join(' | ');
          const meaningful = joined.replace(/[\s|·\-_=]/g, '');
          if (meaningful.length < 2) return;
          // Per-row cap — a single 30-column row can otherwise eat 1KB+.
          const capped = joined.length > MAX_ROW_CHARS
            ? joined.slice(0, MAX_ROW_CHARS) + '…'
            : joined;
          // De-dupe identical rows — many questionnaires repeat header
          // rows on every page or have copy-paste boilerplate. We keep
          // sheet boundaries because identical rows in different sheets
          // are likely meaningful.
          const dedupKey = `${sheet.name}::${capped}`;
          if (seenRows.has(dedupKey)) return;
          seenRows.add(dedupKey);

          // Per-sheet budget. When this sheet is full we stop appending
          // its rows and let other sheets keep contributing.
          if (sheetChars + capped.length > perSheetCap) {
            sheetFull = true;
            lines.push(`(… ${sheet.name}: rest truncated to keep all sheets in scope)`);
            return;
          }
          sheetChars += capped.length + 1;
          lines.push(capped);
        });
        lines.push(''); // sheet separator
      });
      // xlsx LLM-fallback path doesn't have a Document available — the
      // canonical path is the structural shortcut above, which is what
      // gets persisted. This branch only runs when the structural
      // parser bailed (returned null), so we have no reliable
      // RhudDocument to capture here.
      return { text: lines.join('\n'), document: null };
    }

    if (
      ct.startsWith('text/') ||
      ct === 'application/json' ||
      ct === 'application/csv' ||
      lower.endsWith('.txt') || lower.endsWith('.md') || lower.endsWith('.csv')
    ) {
      return { text: bytes.toString('utf8'), document: null };
    }

    return null; // unsupported
  }

  /**
   * Build a structured-extraction prompt anchored on the template's
   * questions, send to the configured LLM, parse its JSON response.
   */
  private async runLlmExtraction(
    tenantId: string,
    engagementId: string,
    text: string,
  ): Promise<ExtractedPoint[]> {
    const questions = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { templateId: true },
      });
      // No template attached → no nodes to match against. See above.
      if (!eng?.templateId) return [];
      const nodes = await db.templateNode.findMany({
        where: {
          templateId: eng.templateId,
          // Section + loop containers aren't questions the client
          // answers — exclude them so the LLM doesn't try to match
          // points against headings. Loop *bodies* (parentNodeId set)
          // also excluded for now; Phase 3 will support per-iteration
          // auto-promotion.
          nodeType: { notIn: ['section', 'loop'] },
          parentNodeId: null,
        },
        select: { id: true, question: true, position: true },
        orderBy: { position: 'asc' },
        take: 60,
      });
      // Use the real node UUID as the LLM-facing key. We ask the
      // model to return that exact id in `relatedQuestion` when a
      // point matches a question — that way the auto-promotion step
      // below can look up the engagement answer slot directly without
      // a position-based mapping. Tradeoff: the prompt is a bit
      // longer (UUIDs vs `q1`) but the round-trip is bullet-proof.
      return nodes.map((n) => ({ keyId: n.id, question: n.question }));
    });

    // For documents under the single-call cap, one LLM round-trip is
    // enough. For larger docs (multi-page security questionnaires
    // routinely run 30+ pages = 100K+ chars), we chunk the text and
    // merge the points from each chunk so the LLM actually sees the
    // whole document instead of just head + tail.
    if (text.length <= MAX_TEXT_CHARS) {
      return this.runLlmExtractionOnChunk(tenantId, questions, text);
    }
    return this.runLlmExtractionChunked(tenantId, questions, text);
  }

  /**
   * Single LLM pass over `chunkText`. Wrapped so the chunked path can
   * call it once per slice without duplicating the prompt-building
   * logic.
   */
  private async runLlmExtractionOnChunk(
    tenantId: string,
    questions: Array<{ keyId: string; question: string }>,
    chunkText: string,
  ): Promise<ExtractedPoint[]> {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You extract pricing-relevant data points from client-uploaded documents for a B2B services consultancy. ' +
          'Output valid JSON only — no preamble, no markdown fences. ' +
          'Be aggressive about pulling out scale numbers (users, requests, throughput, sites), ' +
          'tech stack mentions, integrations, compliance / security requirements, deadlines, and any number that could move a price. ' +
          'When the document directly answers a template question, set `relatedQuestion` to the matching question key. ' +
          'When it carries a useful signal but no question maps, leave `relatedQuestion` null. ' +
          'Always include a short `sourceQuote` (≤200 chars) verbatim from the document so the rep can verify.',
      },
      {
        role: 'user',
        content: this.buildExtractionUserPrompt(questions, chunkText),
      },
    ];

    const result = await this.llm.chat(tenantId, messages, {
      maxTokens: 2_000,
      temperature: 0,
      timeoutMs: 60_000,
    });

    return this.parsePointsResponse(result.text);
  }

  /**
   * Chunked LLM pass: slice the text into overlapping windows, run the
   * extractor per chunk, merge the results, dedup on `key + value`.
   *
   * Order matters — earlier chunks' points come first. Dedup is exact:
   * two chunks describing the same fact are likely to emit the same
   * key+value (e.g. `web_app_count: 3` from sheet 1 page 2 AND sheet 2
   * page 5 if the doc repeats it). The first occurrence wins, the
   * second is dropped.
   *
   * MAX_CHUNKS caps the call count for very large docs — past that,
   * we trust we've already sampled enough.
   */
  private async runLlmExtractionChunked(
    tenantId: string,
    questions: Array<{ keyId: string; question: string }>,
    text: string,
  ): Promise<ExtractedPoint[]> {
    const chunks: string[] = [];
    let cursor = 0;
    while (cursor < text.length && chunks.length < MAX_CHUNKS) {
      const end = Math.min(cursor + CHUNK_TEXT_CHARS, text.length);
      chunks.push(text.slice(cursor, end));
      if (end >= text.length) break;
      cursor = end - CHUNK_OVERLAP_CHARS;
    }
    this.logger.log(
      `chunked-extraction: text=${text.length} chars → ${chunks.length} chunks of ~${CHUNK_TEXT_CHARS} (overlap ${CHUNK_OVERLAP_CHARS})`,
    );

    const seen = new Set<string>();
    const merged: ExtractedPoint[] = [];
    let chunkIdx = 0;
    for (const chunk of chunks) {
      chunkIdx++;
      try {
        const points = await this.runLlmExtractionOnChunk(tenantId, questions, chunk);
        for (const p of points) {
          const dedupKey = `${p.key}::${p.value}`;
          if (seen.has(dedupKey)) continue;
          seen.add(dedupKey);
          merged.push(p);
        }
      } catch (e) {
        // A single chunk failing shouldn't kill the whole document. Log
        // it and continue — the merged output covers the chunks that
        // did succeed.
        this.logger.warn(
          `chunked-extraction: chunk ${chunkIdx}/${chunks.length} failed: ${(e as Error).message}`,
        );
      }
    }
    if (text.length > MAX_CHUNKS * CHUNK_TEXT_CHARS) {
      this.logger.warn(
        `chunked-extraction: doc length ${text.length} exceeds MAX_CHUNKS×CHUNK budget (${MAX_CHUNKS * CHUNK_TEXT_CHARS}); trailing content not scanned`,
      );
    }
    return merged.slice(0, 60); // honour the existing 60-point cap
  }

  private buildExtractionUserPrompt(
    questions: Array<{ keyId: string; question: string }>,
    text: string,
  ): string {
    const qList = questions.length === 0
      ? '(no template questions defined)'
      : questions
          .map((q) => `- ${q.keyId}: ${q.question.replace(/\s+/g, ' ').trim().slice(0, 200)}`)
          .join('\n');

    return (
      `Template questions for context:\n${qList}\n\n` +
      `Document text:\n"""\n${text}\n"""\n\n` +
      `Return JSON exactly in this shape:\n` +
      `{\n` +
      `  "points": [\n` +
      `    {\n` +
      `      "key": "snake_case_descriptor",\n` +
      `      "value": "the extracted value as a string",\n` +
      `      "sourceQuote": "verbatim quote from the document, ≤200 chars",\n` +
      `      "relatedQuestion": "matching template question key or null"\n` +
      `    }\n` +
      `  ]\n` +
      `}\n` +
      `If the document carries no pricing-relevant information, return ` +
      `\`{ "points": [] }\`. Output ONLY the JSON.`
    );
  }

  private parsePointsResponse(raw: string): ExtractedPoint[] {
    if (!raw) return [];
    // Some providers wrap JSON in markdown fences despite instructions.
    // Strip the most common shapes before parsing.
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      // Last-ditch: find the first { ... last } in the response.
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) {
        throw new Error('llm_response_not_json');
      }
      parsed = JSON.parse(cleaned.slice(start, end + 1));
    }

    const arr = (parsed as { points?: unknown }).points;
    if (!Array.isArray(arr)) return [];

    const out: ExtractedPoint[] = [];
    for (const p of arr) {
      if (!p || typeof p !== 'object') continue;
      const pp = p as Record<string, unknown>;
      const key = typeof pp.key === 'string' ? pp.key.trim() : '';
      const value = typeof pp.value === 'string' ? pp.value : pp.value != null ? String(pp.value) : '';
      const sourceQuote = typeof pp.sourceQuote === 'string' ? pp.sourceQuote : '';
      const relatedQuestion =
        typeof pp.relatedQuestion === 'string' && pp.relatedQuestion.trim()
          ? pp.relatedQuestion.trim()
          : null;
      if (!key || !value) continue;
      out.push({
        key: key.slice(0, 100),
        value: value.slice(0, MAX_VALUE_LEN),
        sourceQuote: sourceQuote.slice(0, MAX_QUOTE_LEN),
        relatedQuestion,
      });
    }
    return out.slice(0, 60); // sane cap
  }

  /** Legacy head-tail trimmer — superseded by `runLlmExtractionChunked`
   *  which preserves the middle of the doc instead of dropping it.
   *  Retained as a private helper because nothing currently calls it
   *  but other paths (preview, debug dumps) may want a quick trim
   *  without spinning up the chunked pipeline. */
  private trimForPrompt(text: string): string {
    if (text.length <= MAX_TEXT_CHARS) return text;
    const half = Math.floor(MAX_TEXT_CHARS / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n\n[... ${text.length - MAX_TEXT_CHARS} chars elided ...]\n\n${tail}`;
  }
  // Mark the field as intentionally retained so unused-warning linters
  // don't flag it on every CI run while we figure out the right home.
  private _trimForPromptRef = this.trimForPrompt.bind(this);

  // ── Persistence helpers ──────────────────────────────────────────

  private async persistResult(
    tenantId: string,
    fileId: string,
    text: string,
    pointsRaw: ExtractedPoint[],
    parsedDocument: RhudDocument | null,
  ): Promise<void> {
    // Layer 2 — semantic categorisation. Tag each point with its
    // category before persisting so the UI can show a chip per row
    // and downstream layers can route by category. Heuristic-based
    // (fast, deterministic); the LLM Layer 3 is the slow accurate
    // pass — Layer 2's job is just to enable visual triage.
    const points: ExtractedPoint[] = pointsRaw.map((p) => ({
      ...p,
      category: categorisePoint(p),
    }));
    let engagementId: string | null = null;
    let effectiveRateCardId: string | null = null;
    let capturedFilename: string | null = null;

    // Step A — persist the extracted points + text but KEEP the
    // status as 'processing' until the post-extraction inference +
    // promotion chain has run. The client polls extraction status
    // and we don't want them to see 'ready' (and the auto-Review
    // modal to open) before the answers actually exist in the DB.
    await this.tenantDb.run(tenantId, async (db) => {
      const file = await db.engagementFile.findUnique({
        where: { id: fileId },
        select: {
          engagementId: true, filename: true,
          engagement: { select: { rateCardId: true, template: { select: { rateCardId: true } } } },
        },
      });
      await db.engagementFile.update({
        where: { id: fileId },
        data: {
          // Stay 'processing' — the inference + promote chain below
          // is part of "extraction" from the client's perspective.
          extractionStatus: 'processing',
          extractionError: null,
          extractedText: text.slice(0, MAX_STORED_TEXT),
          extractedPoints: points as unknown as object,
          // Persist the canonical RhudDocument so the admin-review UI
          // can show "exactly what we read from your sheet" before any
          // LLM step ran. JsonNull explicit when there's no Document
          // (e.g. xlsx fell through to the LLM-fallback dump that
          // doesn't capture structure). Prisma requires the explicit
          // sentinel rather than `null` for nullable Json columns.
          ...(parsedDocument
            ? { parsedDocument: parsedDocument as unknown as object }
            : { parsedDocument: PrismaJsonNull }),
        },
      });
      if (file) {
        engagementId = file.engagementId;
        effectiveRateCardId = file.engagement?.rateCardId ?? file.engagement?.template?.rateCardId ?? null;
        capturedFilename = file.filename;
      }
    });
    this.logger.log(`extraction step-A done file=${fileId} points=${points.length} (status=processing)`);

    if (engagementId) {
      // Layer 3 — service-line inference. Run NOW (once, at extraction
      // time) and cache the result on the file row. QuoteService reads
      // from this cache on every Re-predict so the LLM only fires once
      // per file, ever.
      if (effectiveRateCardId) {
        await this.runAndCacheInference(tenantId, fileId, effectiveRateCardId, points, capturedFilename);
        // After Layer-3 inference settles, promote inferred entities into
        // engagement_answers for matching template body nodes. This is
        // what makes the "client uploads xlsx → form is pre-walked"
        // experience work — multi-app docs become multi-iteration loops
        // without the client clicking "Add another" repeatedly.
        try {
          const promo = await this.promoteInferredToAnswers(tenantId, engagementId);
          if (promo.created > 0) {
            this.logger.log(
              `auto-promoted ${promo.created} inferred answer(s) across ` +
                `${promo.iterationsCreated} iteration(s) for engagement=${engagementId}`,
            );
          }
        } catch (e) {
          this.logger.warn(
            `inferred-entity → answer promotion failed engagement=${engagementId}: ${(e as Error).message}`,
          );
        }
      }

      // Auto-promote extracted points to EngagementAnswer rows so the
      // rate-card eval has something to match against. Best-effort —
      // a failed promotion shouldn't block predict; it just means
      // pricing comes back light. See `promoteAnswersFromPoints` for
      // the conflict-resolution rules (form answer wins).
      const promoted = await this.promoteAnswersFromPoints(tenantId, engagementId, points);
      if (promoted > 0) {
        this.logger.log(`auto-promoted ${promoted} answers from file=${fileId}`);
      }
      await this.settleAndMaybePredict(tenantId, engagementId);
    }

    // Step B — flip status to 'ready' AFTER inference + promotion are
    // done. The client polling treats 'ready' as the all-clear signal
    // to open the Review modal, so we don't want to set it earlier
    // (the modal would render empty answers and look broken).
    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagementFile.update({
        where: { id: fileId },
        data: {
          extractionStatus: 'ready',
          extractedAt: new Date(),
          // Successful run — wipe retry scheduling so a future
          // re-extract starts attempts fresh.
          extractionRetryAt: null,
          extractionAttempts: 0,
        },
      });
      if (engagementId) {
        await this.thread.emitWithin(db, tenantId, {
          engagementId,
          eventType: 'file_extracted',
          actorType: 'system',
          actorId: null,
          payload: {
            fileId, filename: capturedFilename, pointCount: points.length,
          },
        });
      }
    });
    this.logger.log(`extraction step-B done file=${fileId} (status=ready)`);
  }

  /**
   * Run the rate-card field mapper once at extraction time and cache
   * the result on `engagement_files.inferred_entities`. Subsequent
   * Re-predict cycles read this cache instead of re-calling the LLM.
   * Failures are logged but never throw — we still want the points
   * persisted even if Layer 3 inference can't run.
   */
  private async runAndCacheInference(
    tenantId: string,
    fileId: string,
    rateCardId: string,
    points: ExtractedPoint[],
    filename: string | null,
    force = false,
  ): Promise<void> {
    try {
      const card = await this.pricing.getById(tenantId, rateCardId);
      const mapperPoints = points.map((p) => ({
        key: p.key,
        value: p.value,
        ...(p.sheet != null ? { sheet: p.sheet } : {}),
        ...(p.appId != null ? { appId: p.appId } : {}),
      }));

      // ── Content-addressed inference cache ────────────────────────────
      // The LLM mapper is non-deterministic (a thinking model drifts even at
      // temperature 0), so re-running the SAME document used to yield a
      // different quote each time. Hash the INPUTS — the points, the rate-card
      // version, and the mapper prompt version — and reuse the cached entities
      // when nothing has changed. `force` (an explicit re-infer) bypasses it.
      const inputHash = createHash('sha256')
        .update(
          JSON.stringify({
            points: [...mapperPoints].sort((a, b) =>
              `${a.appId ?? ''}|${a.key}|${a.value}`.localeCompare(
                `${b.appId ?? ''}|${b.key}|${b.value}`,
              ),
            ),
            rateCardId,
            rateCardVersion: card.version,
            promptVersion: MAPPER_PROMPT_VERSION,
          }),
        )
        .digest('hex');

      if (!force) {
        const cached = await this.tenantDb.run(tenantId, (db) =>
          db.engagementFile.findUnique({
            where: { id: fileId },
            select: { inferenceInputHash: true, inferredEntities: true },
          }),
        );
        if (
          cached?.inferenceInputHash === inputHash &&
          Array.isArray(cached.inferredEntities) &&
          cached.inferredEntities.length > 0
        ) {
          this.logger.log(
            `inference cache HIT file=${fileId} — inputs unchanged, reusing ` +
              `${(cached.inferredEntities as unknown[]).length} cached entities ` +
              `(skipping LLM; same doc → same quote)`,
          );
          return; // entities unchanged; the caller recomputes the quote from them
        }
      }
      // Capture mapper-fallback signal so we can emit a thread event
      // *after* the cache write commits. We can't emit during the
      // mapper call because we don't have an engagementId / db handle
      // there; the callback just records what happened.
      let llmFallback: { reason: string; message: string } | null = null;
      const inferred = await this.fieldMapper.inferEntities(tenantId, mapperPoints, card, {
        ...(filename != null ? { filename } : {}),
        onLlmFallback: (reason, message) => {
          llmFallback = { reason, message };
        },
      });
      // Preserve any manually-overridden entities from a prior session.
      // Re-extraction shouldn't wipe a rep's correction — overlay
      // LLM/heuristic results only for slugs the rep didn't override.
      const merged = await this.tenantDb.run(tenantId, async (db) => {
        const prior = await db.engagementFile.findUnique({
          where: { id: fileId },
          select: { inferredEntities: true },
        });
        const priorArr = Array.isArray(prior?.inferredEntities)
          ? (prior?.inferredEntities as unknown as InferredEntity[])
          : [];
        const manual = priorArr.filter((e) => e.source === 'manual');
        const manualSlugs = new Set(manual.map((e) => e.serviceLineSlug));
        const fresh = (inferred as InferredEntity[]).filter(
          (e) => !manualSlugs.has(e.serviceLineSlug),
        );
        const all = [...manual, ...fresh];
        await db.engagementFile.update({
          where: { id: fileId },
          data: { inferredEntities: all as unknown as object, inferenceInputHash: inputHash },
        });
        return all;
      });
      void merged;
      this.logger.log(
        `inference cached file=${fileId} entities=${inferred.length} ` +
          `(high-confidence: ${inferred.filter((e: InferredEntity) => e.confidence >= 0.6).length})`,
      );

      // If the mapper LLM failed and we fell back to heuristic-only,
      // emit a thread event so the rep sees why every entity is tagged
      // as Heuristic with 70% confidence. The opportunity detail page
      // can render a "Re-run mapping" CTA that re-fires the inference
      // (without re-extracting the doc).
      if (llmFallback) {
        const fb = llmFallback as { reason: string; message: string };
        await this.tenantDb.run(tenantId, async (db) => {
          // Get engagementId from the file
          const fileRow = await db.engagementFile.findUnique({
            where: { id: fileId },
            select: { engagementId: true },
          });
          if (!fileRow) return;
          await this.thread.emitWithin(db, tenantId, {
            engagementId: fileRow.engagementId,
            eventType: 'mapper_fallback_heuristic',
            actorType: 'system',
            actorId: null,
            payload: {
              fileId,
              reason: fb.reason,
              message: fb.message.slice(0, 300),
            },
          });
        });
      }

      // Source-code-review contradiction flag — evaluated ENGAGEMENT-WIDE
      // (the LOC count and the Black-Box selection can live in different
      // sheets/files) so it fires reliably.
      const ecf = await this.tenantDb.run(tenantId, (db) =>
        db.engagementFile.findUnique({ where: { id: fileId }, select: { engagementId: true } }),
      );
      if (ecf) await this.flagSourceCodeContradiction(tenantId, ecf.engagementId);
    } catch (e) {
      this.logger.warn(`inference cache write failed file=${fileId}: ${(e as Error).message}`);
    }
  }

  /**
   * Flag the "Black Box but a source-code line count was given" contradiction.
   * White-box source-code review is correctly NOT priced on a Black-Box
   * engagement, but a client who pastes a real LOC count almost certainly
   * wants a code review — surface it for the rep instead of silently dropping
   * it. Evaluated across ALL the engagement's files (the LOC and the
   * methodology can sit in different sheets), idempotent (won't re-emit if an
   * unresolved flag already exists), and always logs its decision so it is
   * never a silent no-op again.
   */
  private async flagSourceCodeContradiction(tenantId: string, engagementId: string): Promise<void> {
    try {
      const { points, inferred, alreadyFlagged } = await this.tenantDb.run(tenantId, async (db) => {
        const files = await db.engagementFile.findMany({
          where: { engagementId },
          select: { extractedPoints: true, inferredEntities: true },
        });
        const points: ExtractedPoint[] = [];
        const inferred: InferredEntity[] = [];
        for (const f of files) {
          if (Array.isArray(f.extractedPoints)) points.push(...(f.extractedPoints as unknown as ExtractedPoint[]));
          if (Array.isArray(f.inferredEntities)) inferred.push(...(f.inferredEntities as unknown as InferredEntity[]));
        }
        const prior = await db.threadEvent.findFirst({
          where: { engagementId, eventType: 'source_code_review_skipped' },
          select: { id: true },
        });
        return { points, inferred, alreadyFlagged: prior != null };
      });

      const locPoint = points.find((p) => {
        const keyHit = /source[\s_-]?code[\s_-]?line|lines?[\s_-]?of[\s_-]?code|\bk?loc\b|\bsloc\b/i.test(p.key);
        const valHit = /source[\s_-]?code[\s_-]?line|lines?[\s_-]?of[\s_-]?code|\bk?loc\b/i.test(p.value);
        if (!keyHit && !valHit) return false;
        if (/\bn\/?a\b|not applicable|not required|none\b/i.test(p.value)) return false;
        return /\d{2,}/.test(p.value.replace(/,/g, '')); // a real count, not "0"/blank
      });
      const blackBox = points.some(
        (p) =>
          /testing[\s_-]?type|black[\s_-]?grey[\s_-]?white|white[\s_-]?box|grey[\s_-]?box|methodolog/i.test(p.key) &&
          /black[\s_-]*box/i.test(p.value),
      );
      const emittedSourceCode = inferred.some((e) => /source_code|_sca$/.test(e.serviceLineSlug));
      const shouldFlag = !!locPoint && blackBox && !emittedSourceCode;

      this.logger.log(
        `source-code contradiction check engagement=${engagementId}: ` +
          `loc=${!!locPoint} blackBox=${blackBox} emittedSourceCode=${emittedSourceCode} ` +
          `→ flag=${shouldFlag} (alreadyFlagged=${alreadyFlagged})`,
      );

      if (shouldFlag && !alreadyFlagged) {
        await this.tenantDb.run(tenantId, async (db) => {
          await this.thread.emitWithin(db, tenantId, {
            engagementId,
            eventType: 'source_code_review_skipped',
            actorType: 'system',
            actorId: null,
            payload: {
              testingType: 'black_box',
              sample: locPoint!.sourceQuote.slice(0, 300),
            },
          });
        });
      }
    } catch (e) {
      const err = e as { message?: string; code?: string; name?: string };
      this.logger.warn(
        `source-code contradiction check failed engagement=${engagementId}: ` +
          `${err?.name ?? ''} ${err?.code ?? ''} ${err?.message || String(e)}`.trim(),
      );
    }
  }

  /**
   * Map cached `inferred_entities` (Layer 3 output) into
   * `engagement_answers` rows so the gathering form starts with
   * pre-filled answers — including across multiple loop iterations.
   *
   * Grouping logic for loop iterations:
   *   - Entities tagged with `appId` (e.g. `web_app_1`, `web_app_2`)
   *     bucket together: each unique appId becomes one iteration.
   *     Iteration index is assigned by sorted appId order so the
   *     mapping is deterministic across re-runs.
   *   - Entities WITHOUT appId fall into iteration 0 (single-app
   *     legacy behaviour). Multiple entities for the same body node
   *     in this case will conflict — last write wins, but that path
   *     is the LLM's fault for not grouping.
   *
   * Existing answers are NEVER overwritten — the form's answer wins.
   * Top-level (non-loop) bindings are also handled (always iter 0).
   *
   * Returns counts for telemetry. Best-effort: any DB error on a
   * single row is logged and skipped, others continue.
   */
  async promoteInferredToAnswers(
    tenantId: string,
    engagementId: string,
  ): Promise<{ created: number; iterationsCreated: number }> {
    return this.tenantDb.run(tenantId, async (db) => {
      // Load cached inferred entities across every settled file.
      const files = await db.engagementFile.findMany({
        where: { engagementId, extractionStatus: 'ready' },
        select: { inferredEntities: true },
      });
      const allInferred: InferredEntity[] = files.flatMap((f) =>
        Array.isArray(f.inferredEntities)
          ? (f.inferredEntities as unknown as InferredEntity[])
          : [],
      );
      const passing = allInferred.filter(
        (e) => (e.confidence ?? 0) >= 0.6 && Number(e.scopeValue) > 0,
      );
      if (passing.length === 0) return { created: 0, iterationsCreated: 0 };

      // Resolve template + index body nodes by their binding slug.
      // Direct-ingest engagements have no template → no body nodes,
      // so there's nothing to project entities into. Skip cleanly.
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { templateId: true },
      });
      if (!eng?.templateId) return { created: 0, iterationsCreated: 0 };
      const nodes = await db.templateNode.findMany({
        where: { templateId: eng.templateId },
        select: { id: true, parentNodeId: true, binding: true },
      });
      // slug → first body node binding to it (multi-driver intake means
      // each slug maps to exactly one body node in well-formed templates;
      // the loop_body_slug_collision validator catches duplicates)
      const bodyNodeBySlug = new Map<string, { nodeId: string; loopId: string }>();
      const topLevelNodeBySlug = new Map<string, string>();
      for (const n of nodes) {
        const binding = n.binding as { serviceLineSlug?: string; field?: string } | null;
        const slug = binding?.serviceLineSlug;
        if (!slug || binding?.field !== 'scope_value') continue;
        if (n.parentNodeId) {
          if (!bodyNodeBySlug.has(slug)) {
            bodyNodeBySlug.set(slug, { nodeId: n.id, loopId: n.parentNodeId });
          }
        } else {
          if (!topLevelNodeBySlug.has(slug)) topLevelNodeBySlug.set(slug, n.id);
        }
      }

      // Existing answers — never overwrite.
      const existingAnswers = await db.engagementAnswer.findMany({
        where: { engagementId },
        select: { nodeId: true, iterationIndex: true },
      });
      const answeredKey = new Set(
        existingAnswers.map((a) => `${a.nodeId}:${a.iterationIndex}`),
      );

      // Pure planning step — bucketing logic lives in
      // `inferred-promote.ts` so it's testable without a DB. The DB
      // writes that follow are mechanical.
      const plan = buildPromotionPlan({
        passing,
        bodyNodeBySlug,
        topLevelNodeBySlug,
        existingAnswers: answeredKey,
      });

      if (plan.staleSlugCounts.size > 0) {
        const summary = [...plan.staleSlugCounts.entries()]
          .map(([slug, n]) => `${slug}×${n}`)
          .join(', ');
        this.logger.warn(
          `promoteInferredToAnswers: ${plan.staleSlugCounts.size} slug(s) inferred ` +
            `but missing from template engagement=${engagementId}: ${summary}. ` +
            `Add bindings to the template if these should appear as form questions.`,
        );
      }

      let created = 0;
      const iterationsCreated = plan.iterationsCreated;

      // Apply the planned writes. Loop-iteration writes come first
      // (the planner emits them in iteration order), then top-level.
      for (const w of plan.writes) {
        try {
          await db.engagementAnswer.create({
            data: {
              tenantId,
              engagementId,
              nodeId: w.nodeId,
              iterationIndex: w.iter,
              answer: w.value as unknown as object,
            },
          });
          created++;
        } catch (err) {
          this.logger.warn(
            `inferred→answer write failed engagement=${engagementId} node=${w.nodeId} iter=${w.iter}: ${(err as Error).message}`,
          );
        }
      }
      return { created, iterationsCreated };
    });
  }

  /**
   * Walk the extracted points, find ones the LLM tied to a real
   * template node, and create EngagementAnswer rows for any nodes
   * the client hasn't already answered. The form's answer always
   * wins on conflict — we only fill genuine gaps.
   *
   * Returns the count of newly-created answers (for logging).
   *
   * Limitations:
   *   - Only top-level questions (loop body iterations are Phase 3).
   *   - Always iteration 0; doesn't try to be clever about loops.
   *   - Stores the value as a JSON string. The rate-card evaluator
   *     coerces strings → numbers / valueMap lookups when it
   *     evaluates the binding, same path the form takes.
   */
  private async promoteAnswersFromPoints(
    tenantId: string,
    engagementId: string,
    points: ExtractedPoint[],
  ): Promise<number> {
    const matchable = points.filter(
      (p) => p.relatedQuestion && /^[0-9a-f-]{36}$/i.test(p.relatedQuestion),
    );
    if (matchable.length === 0) return 0;

    return this.tenantDb.run(tenantId, async (db) => {
      // Validate the relatedQuestion ids are real nodes for this
      // engagement's template (the LLM occasionally hallucinates).
      // We also restrict promotion to TOP-LEVEL nodes (no parentNodeId).
      // Loop body nodes are handled by the inferred_entities → form
      // pre-population path instead — promoting them here would
      // hard-code iteration 0 and silently lose iterations 2+
      // (P1-8 in see-that-is-self-sunny-honey.md).
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { templateId: true },
      });
      // No template → no nodes to promote into. Skip cleanly.
      if (!eng?.templateId) return 0;
      const validNodes = await db.templateNode.findMany({
        where: {
          templateId: eng.templateId,
          id: { in: matchable.map((p) => p.relatedQuestion!) },
        },
        select: { id: true, parentNodeId: true },
      });
      const topLevelIds = new Set(
        validNodes.filter((n) => n.parentNodeId == null).map((n) => n.id),
      );
      const skippedBodyIds = validNodes
        .filter((n) => n.parentNodeId != null)
        .map((n) => n.id);
      if (skippedBodyIds.length > 0) {
        this.logger.warn(
          `promoteAnswersFromPoints skipping ${skippedBodyIds.length} body node(s) ` +
            `(loop iterations are handled by inferred_entities pre-population, not auto-promote). ` +
            `nodes: ${skippedBodyIds.slice(0, 5).join(', ')}${skippedBodyIds.length > 5 ? '…' : ''}`,
        );
      }

      // Existing answers — never overwrite.
      const existingAnswers = await db.engagementAnswer.findMany({
        where: {
          engagementId,
          nodeId: { in: [...topLevelIds] },
          iterationIndex: 0,
        },
        select: { nodeId: true },
      });
      const alreadyAnswered = new Set(existingAnswers.map((a) => a.nodeId));

      let created = 0;
      for (const p of matchable) {
        const nodeId = p.relatedQuestion!;
        if (!topLevelIds.has(nodeId) || alreadyAnswered.has(nodeId)) continue;
        try {
          await db.engagementAnswer.create({
            data: {
              tenantId,
              engagementId,
              nodeId,
              iterationIndex: 0,
              answer: p.value as unknown as object,
            },
          });
          await this.thread.emitWithin(db, tenantId, {
            engagementId,
            eventType: 'node_answered',
            actorType: 'system',
            actorId: null,
            payload: {
              nodeId,
              source: 'document_extraction',
              value: p.value.slice(0, 200),
              sourceQuote: p.sourceQuote.slice(0, 200),
            },
          });
          created += 1;
          alreadyAnswered.add(nodeId); // de-dupe within a single batch
        } catch (e) {
          this.logger.warn(
            `auto-promote answer failed engagement=${engagementId} node=${nodeId}: ${(e as Error).message}`,
          );
        }
      }
      return created;
    });
  }

  private async markFailed(tenantId: string, fileId: string, error: string): Promise<void> {
    const engagementId = await this.markTerminal(tenantId, fileId, 'failed', error);
    if (engagementId) await this.settleAndMaybePredict(tenantId, engagementId);
  }

  /**
   * Mark the file for a delayed retry. Caps at MAX_RETRY_ATTEMPTS —
   * after that we settle as `failed` so the row doesn't loop forever
   * and the rep gets a clear "this needs your attention" surface.
   */
  private async queueForRetry(tenantId: string, fileId: string, rawError: string): Promise<void> {
    const file = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.findUnique({
        where: { id: fileId },
        select: { extractionAttempts: true, engagementId: true },
      }),
    );
    if (!file) return;

    const nextAttempt = file.extractionAttempts + 1;
    if (nextAttempt > MAX_RETRY_ATTEMPTS) {
      // Out of retries — surface as failed with a "you should switch
      // provider" hint so the user has a clear next step.
      await this.markFailed(
        tenantId,
        fileId,
        'rate_limited_persistent:try_a_different_ai_provider_in_settings',
      );
      return;
    }

    const delay = RETRY_DELAY_MS[Math.min(nextAttempt - 1, RETRY_DELAY_MS.length - 1)] ?? 600_000;
    const retryAt = new Date(Date.now() + delay);

    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagementFile.update({
        where: { id: fileId },
        data: {
          extractionStatus: 'retry_queued',
          extractionAttempts: nextAttempt,
          extractionRetryAt: retryAt,
          extractionError: 'rate_limited:retry_scheduled',
        },
      });
    });
    this.logger.log(
      `extraction queued-for-retry file=${fileId} attempt=${nextAttempt}/${MAX_RETRY_ATTEMPTS} ` +
        `retry_at=${retryAt.toISOString()} reason="${rawError.slice(0, 80)}"`,
    );
  }

  private async markSkipped(tenantId: string, fileId: string, reason: string): Promise<void> {
    const engagementId = await this.markTerminal(tenantId, fileId, 'skipped', reason);
    if (engagementId) await this.settleAndMaybePredict(tenantId, engagementId);
  }

  /** Shared write path for terminal-but-not-ready states (failed/skipped).
   *  Returns the engagementId so the caller can run the predict gate. */
  private async markTerminal(
    tenantId: string,
    fileId: string,
    status: 'failed' | 'skipped',
    error: string,
  ): Promise<string | null> {
    return this.tenantDb
      .run(tenantId, async (db) => {
        const file = await db.engagementFile.findUnique({
          where: { id: fileId },
          select: { engagementId: true },
        });
        await db.engagementFile.update({
          where: { id: fileId },
          data: {
            extractionStatus: status,
            extractedAt: new Date(),
            extractionError: error.slice(0, 500),
          },
        });
        return file?.engagementId ?? null;
      })
      .catch(() => null);
  }

  /**
   * Manually override one inferred-entity's pricing inputs (scope value,
   * methodology, or customerType) when the LLM/heuristic got it wrong.
   * Mutates the cached `inferredEntities` JSON on the file row in place,
   * then re-computes the deterministic quote so the price reflects the
   * change immediately.
   *
   * Confidence is forced to 1.0 on a manual override — the rep is
   * the source of truth, so the entity now passes the quote's
   * threshold filter even if the LLM was unsure.
   */
  async overrideInferredEntity(
    tenantId: string,
    fileId: string,
    serviceLineSlug: string,
    patch: { scopeValue?: number; methodology?: string | null; customerType?: 'internal' | 'external' },
  ): Promise<void> {
    const updated = await this.tenantDb.run(tenantId, async (db) => {
      const file = await db.engagementFile.findUnique({
        where: { id: fileId },
        select: { engagementId: true, inferredEntities: true },
      });
      if (!file) throw new NotFoundException('file_not_found');
      const arr = Array.isArray(file.inferredEntities)
        ? (file.inferredEntities as unknown as Array<Record<string, unknown>>)
        : [];
      const idx = arr.findIndex((e) => e?.serviceLineSlug === serviceLineSlug);
      if (idx === -1) throw new NotFoundException('inferred_entity_not_found');

      const next = { ...arr[idx] };
      if (patch.scopeValue != null && Number.isFinite(patch.scopeValue) && patch.scopeValue > 0) {
        next.scopeValue = patch.scopeValue;
      }
      if (patch.methodology !== undefined) {
        next.methodology = patch.methodology;
      }
      if (patch.customerType === 'internal' || patch.customerType === 'external') {
        next.customerType = patch.customerType;
      }
      next.confidence = 1.0;
      next.source = 'manual';
      next.reasoning = 'Manually overridden by sales rep';

      arr[idx] = next;
      await db.engagementFile.update({
        where: { id: fileId },
        data: { inferredEntities: arr as unknown as object },
      });
      return file.engagementId;
    });

    // Kick the quote re-compute so the override reflects immediately
    // without waiting for the next Re-predict click.
    try {
      await this.quotes.computeAndPersistForEngagement(tenantId, updated);
    } catch (e) {
      this.logger.warn(
        `quote re-compute after override failed engagement=${updated}: ${(e as Error).message}`,
      );
    }
  }

  /** Re-run extraction on a single file (manual button). Same shape
   *  as kickoff but verifies the file exists first so the controller
   *  can return a 404 to the UI instead of a silent no-op. */
  async forceExtract(tenantId: string, fileId: string): Promise<void> {
    const exists = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.count({ where: { id: fileId } }),
    );
    if (exists === 0) throw new NotFoundException('file_not_found');
    await this.kickoff(tenantId, fileId);
  }

  /**
   * Re-run JUST the Layer-3 mapper LLM using the file's cached
   * `extracted_points`. Used when the mapper hit a 429 / parse error
   * and fell back to heuristic-only inference — the rep can re-run
   * after the rate-limit clears without paying for re-fetching S3 +
   * re-extracting text. Skips the LLM extraction stage entirely.
   *
   * If the file isn't extracted yet, falls through to a regular
   * `forceExtract` so the rep doesn't have to know the difference.
   */
  /**
   * Read the cached canonical RhudDocument for a file. Used by the
   * admin-review UI to show "exactly what we read from your sheet"
   * before any LLM step ran — separates parsing-quality issues from
   * extraction-quality issues.
   *
   * Returns null when:
   *   - The file doesn't exist (also throws NotFoundException upstream)
   *   - The file extracted before this column existed (legacy rows)
   *   - The format had no Document path (xlsx LLM-fallback dump,
   *     plain-text formats)
   */
  async getParsedDocument(
    tenantId: string,
    fileId: string,
  ): Promise<{ filename: string; document: RhudDocument | null }> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.findUnique({
        where: { id: fileId },
        select: { filename: true, parsedDocument: true },
      }),
    );
    if (!row) throw new NotFoundException('file_not_found');
    const doc = row.parsedDocument as unknown as RhudDocument | null;
    return { filename: row.filename, document: doc ?? null };
  }

  async rerunInference(tenantId: string, fileId: string, force = false): Promise<{ rerun: 'mapper_only' | 'full_extract' }> {
    const file = await this.tenantDb.run(tenantId, async (db) =>
      db.engagementFile.findUnique({
        where: { id: fileId },
        select: {
          id: true, filename: true, extractionStatus: true,
          extractedPoints: true,
          engagement: { select: { id: true, rateCardId: true, template: { select: { rateCardId: true } } } },
        },
      }),
    );
    if (!file) throw new NotFoundException('file_not_found');

    // Need both extracted points AND a rate card binding for the
    // mapper to run. If either is missing, fall through to a full
    // re-extract — the regular pipeline will populate everything.
    const points = Array.isArray(file.extractedPoints)
      ? (file.extractedPoints as unknown as ExtractedPoint[])
      : [];
    const rateCardId = file.engagement?.rateCardId ?? file.engagement?.template?.rateCardId;
    const engagementId = file.engagement?.id;
    if (points.length === 0 || !rateCardId || !engagementId) {
      await this.kickoff(tenantId, fileId);
      return { rerun: 'full_extract' };
    }

    await this.runAndCacheInference(tenantId, fileId, rateCardId, points, file.filename, force);
    // After inference settles, re-run the answer-promotion so any new
    // entities flow into the gathering form's pre-fills.
    try {
      const promo = await this.promoteInferredToAnswers(tenantId, engagementId);
      this.logger.log(
        `rerunInference promoted ${promo.created} answer(s) across ` +
          `${promo.iterationsCreated} iteration(s) for engagement=${engagementId}`,
      );
    } catch (e) {
      this.logger.warn(
        `rerunInference: post-mapper promote failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }
    // Re-runing the mapper changes the inferred entities, so the priced
    // quote must be recomputed too — otherwise the rep re-runs mapping, sees
    // new scope, but the PRICE stays stale (the multi-app / pooled-pricing
    // bug that made June's quote not reflect the per-app pooled total).
    try {
      await this.quotes.computeAndPersistForEngagement(tenantId, engagementId);
    } catch (e) {
      this.logger.warn(
        `rerunInference: quote re-compute failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }
    return { rerun: 'mapper_only' };
  }

  /**
   * Engagement-wide re-inference. Runs the rate-card field mapper over
   * every ready file's already-extracted points using the engagement's
   * EFFECTIVE rate card (direct attachment ?? template binding) and
   * caches the result on each file. Used after a rep attaches a rate
   * card to a template-less (direct-ingest) opportunity: extraction ran
   * with no card bound, so `inferred_entities` is empty and the quote
   * comes back light until we re-map against the freshly-attached card.
   *
   * No-op (returns zero) when there's still no effective rate card or no
   * ready files with points. Best-effort per file — one failure is
   * logged and the rest continue.
   */
  async rerunInferenceForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<{ files: number; entities: number }> {
    const ctx = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { rateCardId: true, template: { select: { rateCardId: true } } },
      });
      const rateCardId = eng?.rateCardId ?? eng?.template?.rateCardId ?? null;
      const files = await db.engagementFile.findMany({
        where: { engagementId, extractionStatus: 'ready' },
        select: { id: true, filename: true, extractedPoints: true },
      });
      return { rateCardId, files };
    });

    if (!ctx.rateCardId) {
      this.logger.debug(
        `rerunInferenceForEngagement: engagement ${engagementId} has no effective rate card; skipping`,
      );
      return { files: 0, entities: 0 };
    }

    let filesProcessed = 0;
    for (const f of ctx.files) {
      const points = Array.isArray(f.extractedPoints)
        ? (f.extractedPoints as unknown as ExtractedPoint[])
        : [];
      if (points.length === 0) continue;
      try {
        await this.runAndCacheInference(tenantId, f.id, ctx.rateCardId, points, f.filename);
        filesProcessed += 1;
      } catch (e) {
        this.logger.warn(
          `rerunInferenceForEngagement: inference failed file=${f.id}: ${(e as Error).message}`,
        );
      }
    }

    // Promote inferred entities → answers for any template body nodes.
    // No-op for template-less opportunities (no nodes to bind to); the
    // quote path reads inferred_entities directly regardless.
    try {
      await this.promoteInferredToAnswers(tenantId, engagementId);
    } catch (e) {
      this.logger.warn(
        `rerunInferenceForEngagement: answer promotion failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }

    // Count high-confidence entities now cached, for the return summary.
    const entities = await this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagementFile.findMany({
        where: { engagementId, extractionStatus: 'ready' },
        select: { inferredEntities: true },
      });
      return rows.reduce((sum, r) => {
        if (!Array.isArray(r.inferredEntities)) return sum;
        const arr = r.inferredEntities as unknown as Array<{ confidence?: number }>;
        return sum + arr.filter((e) => (e.confidence ?? 0) >= 0.6).length;
      }, 0);
    });

    this.logger.log(
      `rerunInferenceForEngagement engagement=${engagementId} ` +
        `files=${filesProcessed} high-confidence-entities=${entities}`,
    );
    return { files: filesProcessed, entities };
  }

  /**
   * Called after each terminal extraction outcome. When every file on
   * the engagement is settled AND the engagement is in `submitted`
   * state with no prediction yet, we:
   *
   *   1. Re-compute the deterministic quote — auto-promoted answers
   *      that landed during extraction need to flow into the rate-
   *      card eval, otherwise the base stays at the pre-extraction
   *      value (often INR 0 when the client uploaded a doc instead
   *      of typing answers).
   *   2. Fire ML predict so the manager opens an approval card with
   *      both the deterministic base and the modifier ready.
   *
   * Idempotency: short-circuits when a prediction already exists, and
   * status check guards against firing after a manager has already
   * approved or rejected.
   */
  private async settleAndMaybePredict(tenantId: string, engagementId: string): Promise<void> {
    if (!(await this.isAllSettled(tenantId, engagementId))) return;

    const eng = await this.tenantDb.run(tenantId, async (db) =>
      db.engagement.findUnique({
        where: { id: engagementId },
        select: { status: true, predictions: { take: 1, select: { id: true } } },
      }),
    );
    if (!eng) return;
    if (eng.status !== 'submitted') return;
    if (eng.predictions.length > 0) return;

    // Step 1 — refresh the deterministic quote. Auto-promotion above
    // only writes EngagementAnswer rows; the base price needs an
    // explicit re-eval to pick them up.
    try {
      await this.quotes.computeAndPersistForEngagement(tenantId, engagementId);
    } catch (e) {
      this.logger.warn(
        `quote re-compute after extraction failed engagement=${engagementId}: ${(e as Error).message}`,
      );
      // Don't bail — predict can still run with whatever base exists.
    }

    // Step 2 — fire ML predict. Cold-start tenants get a fallback
    // prediction immediately; trained tenants get the modifier.
    this.logger.log(`extraction settled engagement=${engagementId} — kicking off ML predict`);
    void this.ml.predictForEngagement(tenantId, engagementId).catch((e) => {
      this.logger.warn(
        `predict-after-extraction failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    });
  }
}

// ── Layer 2 — semantic categorisation ────────────────────────────────

/**
 * Heuristic categoriser. Runs at extraction time and tags each point
 * with one of the seven `PointCategory` buckets. The categories are
 * mutually exclusive and ordered by priority — when a point's text
 * has signal for multiple categories the FIRST hit wins (e.g.
 * "compliance" beats "scope" if the value mentions SOC2).
 *
 * Why heuristic vs LLM: this is a hint for visual triage, not a
 * semantic ground truth. The downstream pricing decision uses
 * Layer 3 (LLM-first inference). If the categoriser misclassifies
 * something, the rep sees the wrong chip but pricing is unaffected.
 */
function categorisePoint(p: ExtractedPoint): PointCategory {
  const haystack = `${p.key} ${p.value}`.toLowerCase();

  // Compliance — highest priority because a value like "SOC2" is
  // unambiguous regardless of the key wording.
  if (/\b(soc[\s-]?2?|iso\s?27\d{3}|pci(?:[\s-]?dss)?|hipaa|gdpr|nist|fedramp)\b/i.test(haystack)) {
    return 'compliance';
  }
  if (/compliance|audit|certification|attestation/i.test(p.key)) return 'compliance';

  // Identity — names, contacts, organisation. Tested before scope
  // because a "company name" key shouldn't be misread as scope just
  // because the value contains digits.
  if (
    /\b(name|email|phone|contact|company|organi[sz]ation|designat|address)\b/i.test(p.key) ||
    /@[a-z0-9.-]+\.[a-z]{2,}/i.test(p.value)
  ) {
    return 'identity';
  }

  // Methodology — testing approach. Both key and value are checked
  // because a key called "testing_type" with value "Black Box" wins.
  if (
    /method|test(?:ing)?_type|test_method|pentest_type|approach/i.test(p.key) ||
    /\b(black|grey|gray|white)[\s_]?box|\bvapt\b|\bpenetration test/i.test(haystack)
  ) {
    return 'methodology';
  }

  // Service type — domain of the work. Checked before scope so that
  // "web_application_count" lands as service_type (the *kind* of
  // work) rather than scope (the *amount*). The user can read the
  // scope value off it either way.
  if (
    /\b(web|website|webapp|http|url|browser)\b/i.test(haystack) ||
    /\b(mobile|android|ios|apk|ipa|iphone|app store|play store)\b/i.test(haystack) ||
    /\b(api|endpoint|rest|graphql|webhook)\b/i.test(haystack) ||
    /\b(thick client|desktop|binary|executable)\b/i.test(haystack) ||
    /\b(network|firewall|router|switch|vlan|subnet)\b/i.test(haystack) ||
    /\b(database|sql server|postgres|mysql)\b/i.test(haystack)
  ) {
    return 'service_type';
  }

  // Environment — where the work happens. Cloud, on-prem, host
  // metadata, deploy stages.
  if (
    /\b(aws|azure|gcp|google cloud|cloud|on[\s-]?prem|host(?:ing|ed)?|environment|staging|production|prod\b|qa\b|development|deploy|architecture)\b/i.test(haystack)
  ) {
    return 'environment';
  }

  // Scope — numerics + count-shaped keys. Checked late so other
  // categories get first dibs. Many "scope" cells hold pure numbers
  // or values like "Yes" / "No"; we keep both shapes.
  if (
    /count|number_of|num_of|^total$|^size$|^volume$|pages?$|screens?$|apis?$|endpoints?$|users?$|sites?$/i.test(p.key) ||
    /^\d+(?:\.\d+)?$/i.test(p.value.trim())
  ) {
    return 'scope';
  }

  return 'other';
}
