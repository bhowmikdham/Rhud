/**
 * Layer 3 of the extraction-to-pricing pipeline — service-line
 * inference. Given a rate card and a list of extracted points,
 * decide which service lines the engagement actually covers and
 * with what scope value, methodology, and customer type.
 *
 * Design: rate-card-driven LLM-first, narrow heuristic fallback.
 *
 * The LLM is the authoritative decider. Its **system prompt is composed
 * from the rate card itself** — `RateCard.inferenceContext`, per-slug
 * `inferenceHint`, and `inferenceExamples` flow into the prompt verbatim.
 * The mapper carries no domain vocabulary in code, so a non-cybersec
 * tenant publishing a cleaning-services rate card or a legal-billing
 * rate card just authors hints that match their world; the mapper does
 * the rest.
 *
 * Heuristic role:
 *   - LLM succeeded with ≥1 entity AND no exception: heuristic is
 *     SUPPRESSED entirely. The LLM's `considered` array tells us which
 *     slugs it evaluated and rejected, so we don't backfill against the
 *     LLM's judgement.
 *   - LLM threw OR returned 0 entities: heuristic runs as a fallback
 *     keyword pass. This is the "model is offline / rate-limited" net.
 *
 * Caching: callers (ExtractionService) are expected to cache this
 * service's output on the file row. Re-predict reads the cache and
 * never re-calls the LLM — that's where the rate-limit pressure goes
 * from "every quote computation" to "once per file ever".
 */

import { Injectable, Logger } from '@nestjs/common';
import type {
  CustomerType,
  Methodology,
  RateCard,
  RateCardServiceLine,
  ScopedEntity,
  ScopeUnit,
} from '@rhud/shared';
import { LlmService } from '../llm/llm.service.js';
import type { ChatMessage } from '../llm/llm.types.js';
import { enrichPoints } from './point-enrichment.js';

export interface ExtractedPointInput {
  key: string;
  value: string;
  label?: string;
  sheet?: string | null;
  /** Application instance this point belongs to (wide multi-app
   *  questionnaires). When set, the LLM is told to reuse it verbatim as
   *  the entity's `appId` so every application is priced + shown
   *  separately. */
  appId?: string;
}

/** Optional context the mapper uses for deterministic heuristics —
 *  filename hints (`aws_inventory.xlsx` → bias cloud), URL counting,
 *  etc. None of this is required for LLM-only operation. */
export interface InferContext {
  filename?: string;
  /** Fired when the LLM path fails (rate limit, timeout, parse error)
   *  AND we fall back to heuristic-only inference. The caller wires
   *  this up to the thread-event pipeline so the rep sees a "mapping
   *  fell back to heuristics — re-run when ready" prompt on the
   *  opportunity detail page. Synchronous; throws are swallowed. */
  onLlmFallback?: (reason: 'rate_limited' | 'timeout' | 'parse_error' | 'no_entities' | 'other', message: string) => void;
}

/** What the LLM (or heuristic) emits per service line, with audit
 *  metadata so the rep can see *why* a line was inferred. Persisted
 *  on engagement_files.inferred_entities so re-predict can read it
 *  without another LLM round-trip. */
export interface InferredEntity {
  serviceLineSlug: string;
  scopeValue: number;
  methodology: Methodology | null;
  customerType: CustomerType;
  /** 0..1 — only entities ≥0.6 land in the priced quote. */
  confidence: number;
  /** Short human-readable rationale ("doc mentions iOS app store"). */
  reasoning: string;
  /** Verbatim source span that triggered the inference. */
  sourceQuote: string;
  /** Which path produced this — useful for telemetry + debugging.
   *  `'manual'` is set by the override endpoint; both runAndCacheInference
   *  and toScopedEntities preserve those entries verbatim. */
  source: 'llm' | 'heuristic' | 'manual';
  /** Optional grouping key the LLM emits when a single document describes
   *  MULTIPLE applications under the same service-line family. Format is
   *  `<domain>_<index>` — e.g. `web_app_1`, `web_app_2`, `ios_app_1`.
   *  Used by `promoteInferredToAnswers` to bucket entities into separate
   *  loop iterations: all entities with `appId='web_app_1'` go into
   *  iteration 0 of the Web Apps loop, `web_app_2` into iteration 1, etc.
   *  When absent (legacy / single-app docs) the promoter falls back to
   *  per-slug occurrence-index grouping. */
  appId?: string;
}

/** Confidence below this is dropped from the quote (still cached for
 *  audit). Tuned by hand: 0.6 keeps strong signals, drops
 *  speculative ones the LLM admits to. */
const CONFIDENCE_THRESHOLD = 0.6;

/** Output-token budget for the field-mapper LLM call. Must comfortably fit
 *  a THINKING model's hidden reasoning (≤24,576 tokens on Gemini 2.5-flash)
 *  PLUS the full JSON answer — otherwise the answer truncates mid-array and
 *  the whole call silently falls back to the keyword heuristic. */
const MAPPER_MAX_OUTPUT_TOKENS = 32_768;

/**
 * One slug the LLM explicitly evaluated and rejected, with a short
 * reason. Used by `inferEntities` to gate heuristic backfill: we never
 * paper over the LLM's "no" with a regex match.
 */
export interface ConsideredSlug {
  serviceLineSlug: string;
  reason: string;
}

interface LlmInferResult {
  entities: InferredEntity[];
  considered: ConsideredSlug[];
}

@Injectable()
export class RateCardFieldMapperService {
  private readonly logger = new Logger(RateCardFieldMapperService.name);

  constructor(private readonly llm: LlmService) {}

  /**
   * Top-level entry point. Returns the full set of inferred entities
   * (including low-confidence ones) so callers can persist the
   * complete audit trail. Use `toScopedEntities` to filter to the
   * confidence-passing subset for actual pricing.
   *
   * Semantics:
   *   - LLM succeeded with ≥1 entity AND no exception → heuristic is
   *     SUPPRESSED. The LLM is the authoritative decider; backfilling
   *     would re-introduce the substring-match noise the heuristic is
   *     prone to (P0 fix in majestic-whistling-whistle.md).
   *   - LLM threw OR returned 0 entities → heuristic runs as the
   *     fallback keyword pass. The LLM's `considered` array (when present
   *     in the partial response) further gates which slugs the heuristic
   *     can backfill.
   */
  async inferEntities(
    tenantId: string,
    points: ExtractedPointInput[],
    rateCard: RateCard,
    ctx: InferContext = {},
  ): Promise<InferredEntity[]> {
    if (points.length === 0 || rateCard.serviceLines.length === 0) return [];

    // Layer 2.5 — enrich the raw extracted points with derived signals
    // before the LLM sees them. URL grouping by hostname, cloud-platform
    // detection, negation-count summary. The LLM applies the rate card's
    // hints to these enriched points alongside the originals.
    const enrichedPoints = enrichPoints(points);

    // Layer 3 primary path — LLM with rate-card-composed prompt.
    let llmEntities: InferredEntity[] = [];
    let llmConsidered: ConsideredSlug[] = [];
    let llmThrew = false;
    const provider = await this.llm.getProviderName(tenantId);
    if (provider && provider !== 'manual') {
      try {
        const result = await this.llmInfer(tenantId, enrichedPoints, rateCard);
        llmEntities = result.entities;
        llmConsidered = result.considered;
        if (llmEntities.length > 0) {
          this.logger.log(
            `field-mapper LLM produced ${llmEntities.length} entities ` +
              `(${llmEntities.filter((e) => e.confidence >= CONFIDENCE_THRESHOLD).length} above threshold; ` +
              `${llmConsidered.length} explicitly considered+rejected)`,
          );
        } else {
          this.logger.warn(
            `field-mapper LLM returned zero entities; will rely on heuristics for ratecard=${rateCard.id}`,
          );
          try { ctx.onLlmFallback?.('no_entities', 'LLM returned an empty entities array'); } catch { /* swallow */ }
        }
      } catch (e) {
        llmThrew = true;
        const msg = (e as Error).message;
        // Categorise the failure so the rep can act on it. Rate-limit
        // errors are recoverable by re-running once the throttle clears;
        // parse / timeout errors usually need a smaller doc or a model
        // change. The thread-event payload carries `reason` so the UI
        // can render the right call-to-action.
        const reason =
          /\b429\b|RESOURCE_EXHAUSTED|rate.?limit|quota|too.?many.?requests/i.test(msg) ? 'rate_limited'
          : /timeout|timed.?out/i.test(msg) ? 'timeout'
          : /parse|JSON|unexpected.?token/i.test(msg) ? 'parse_error'
          : 'other';
        this.logger.warn(
          `field-mapper LLM failed (${reason}): ${msg} — falling back to heuristics. ` +
          (reason === 'rate_limited'
            ? 'Re-run extraction in a minute or two once the LLM rate-limit clears.'
            : ''),
        );
        try { ctx.onLlmFallback?.(reason as 'rate_limited' | 'timeout' | 'parse_error' | 'other', msg); } catch { /* swallow */ }
      }
    }

    // ── Heuristic gating ────────────────────────────────────────────────
    // The heuristic ONLY runs when the LLM was unavailable, threw, or
    // produced zero entities. When the LLM successfully classified the
    // doc with ≥1 entity, its judgement is final — we don't backfill
    // because every backfill we've ever shipped has produced false
    // positives via substring keyword overlap.
    const llmSucceeded = !llmThrew && llmEntities.length > 0;
    if (llmSucceeded) {
      return llmEntities;
    }

    // Fallback path: emit heuristic entities, but suppress any slug the
    // LLM explicitly considered+rejected (when we got that signal).
    // Heuristic still scans the ORIGINAL points (not enriched) — its
    // keyword gates expect raw doc shape, not derived summaries.
    const heuristicEntities = this.heuristicInfer(points, rateCard, ctx);
    const llmSlugs = new Set(llmEntities.map((e) => e.serviceLineSlug));
    const consideredRejected = new Set(llmConsidered.map((c) => c.serviceLineSlug));
    const supplemental = heuristicEntities.filter(
      (e) => !llmSlugs.has(e.serviceLineSlug) && !consideredRejected.has(e.serviceLineSlug),
    );

    if (supplemental.length > 0) {
      this.logger.log(
        `field-mapper heuristic fallback emitted ${supplemental.length} entities ` +
          `(slugs: ${supplemental.map((e) => e.serviceLineSlug).join(', ')})`,
      );
    }

    return [...llmEntities, ...supplemental];
  }

  /**
   * Convenience: filter `InferredEntity[]` to the high-confidence
   * subset and convert to `ScopedEntity[]` ready for `computeBasePrice`.
   * Callers that need the full audit trail use `inferEntities`
   * directly instead.
   */
  toScopedEntities(
    inferred: InferredEntity[],
    rateCard: RateCard,
  ): ScopedEntity[] {
    const slBySlug = new Map(rateCard.serviceLines.map((s) => [s.slug, s]));
    // Per-slug counter so multiple inferred entities targeting the same
    // slug get unique entity ids ("extracted-llm:slug:0", ":1", …).
    // Without this, downstream code that keys on entityId (line-item
    // override UI, audit trails) would collide silently when the LLM
    // emits N entries for one slug (e.g. a doc describing 3 web apps).
    const slugCounter = new Map<string, number>();
    const out: ScopedEntity[] = [];
    let droppedConfidence = 0;
    let droppedUnknownSlug = 0;
    let droppedStale = 0;
    for (const e of inferred) {
      if (e.confidence < CONFIDENCE_THRESHOLD) {
        droppedConfidence++;
        continue;
      }
      const sl = slBySlug.get(e.serviceLineSlug);
      if (!sl) {
        // Manual overrides referencing a slug that no longer exists in
        // the rate card (renamed / archived) get logged so the rep can
        // re-target. P1-7 in see-that-is-self-sunny-honey.md.
        if (e.source === 'manual') {
          droppedStale++;
          this.logger.warn(
            `manual override references stale slug "${e.serviceLineSlug}" — ` +
              `rate card no longer has this entry. Re-target or remove via the inferred-entities edit UI.`,
          );
        } else {
          droppedUnknownSlug++;
        }
        continue;
      }

      // Resolve methodology against this service line's actual tier
      // methodologies. The LLM may emit canonical `black_box` even
      // though Mobile-App-Android tiers carry `black_box_apk`; this
      // step translates so pickTier's exact-match check passes.
      //
      // When the input entity has NO methodology (older cached
      // entities, manual-override entries that didn't set one,
      // tests), fall back to the same auto-pick the LLM/heuristic
      // paths use. Without this, white-box service lines would
      // pick whatever the kernel's null-wildcard happens to return
      // — usually correct for pricing but wrong in the proposal's
      // line-item methodology label.
      const methodology = e.methodology
        ? resolveServiceLineMethodology(sl, e.methodology)
        : autoPickMethodology(sl, e.customerType);

      const dimensions: ScopedEntity['dimensions'] = {};
      dimensions[sl.scopeUnit] = e.scopeValue;

      const idx = slugCounter.get(e.serviceLineSlug) ?? 0;
      slugCounter.set(e.serviceLineSlug, idx + 1);
      out.push({
        entityId: `extracted-${e.source}:${e.serviceLineSlug}:${idx}`,
        serviceLineSlug: e.serviceLineSlug,
        dimensions,
        ...(methodology != null ? { methodology } : {}),
        customerType: e.customerType,
        ...(e.appId ? { appId: e.appId } : {}),
      });
    }
    if (droppedConfidence + droppedUnknownSlug + droppedStale > 0) {
      this.logger.debug(
        `toScopedEntities dropped ${droppedConfidence} below-threshold + ` +
          `${droppedUnknownSlug} unknown-slug + ${droppedStale} stale-manual entities`,
      );
    }
    return out;
  }

  // ── LLM-first inference (primary) ─────────────────────────────────

  private async llmInfer(
    tenantId: string,
    points: ExtractedPointInput[],
    rateCard: RateCard,
  ): Promise<LlmInferResult> {
    // The system prompt is the **domain-neutral kernel** — universal
    // rules every B2B inference task obeys. The rate-card-specific
    // ontology (slug list, hints, examples) lives in the user prompt
    // because it varies per call.
    const messages: ChatMessage[] = [
      { role: 'system', content: SYSTEM_KERNEL },
      { role: 'user', content: this.buildLlmPrompt(rateCard, points) },
    ];

    const result = await this.llm.chat(tenantId, messages, {
      // Generous output budget. Gemini 2.5/3.x "flash" (and most current
      // frontier models) are THINKING models: hidden reasoning tokens count
      // against max_tokens. A tight cap is consumed almost entirely by
      // reasoning and the JSON answer truncates mid-array; parseLlmEntities
      // cannot recover a truncated object, so the call silently falls back to
      // the keyword heuristic. 8k was enough for a tiny single-app doc but a
      // wide multi-application questionnaire (≈145 points → ~15 entities)
      // makes the model think harder — prod logged finish_reason=length with
      // only 327 visible output tokens. 32k leaves room for the model's full
      // dynamic thinking budget (≤24,576 on 2.5-flash) AND a large answer.
      maxTokens: MAPPER_MAX_OUTPUT_TOKENS,
      temperature: 0,
      // Field mapping is mechanical extraction, not deep reasoning. Cap
      // Gemini's thinking budget ("low") so a call uses ~a few thousand
      // tokens instead of ~32k of mostly-hidden reasoning. Gemini-only +
      // self-healing (the provider retries without it if rejected), and
      // maxTokens above stays the safety net.
      reasoningEffort: 'low',
      // 90s budget — leaves room for a single 429 retry that waits
      // ~35s across a minute boundary (Gemini's bucket reset point)
      // plus the actual LLM round-trip on the second attempt.
      timeoutMs: 90_000,
    });

    // Surface truncation explicitly. Without this, a hit output cap looks
    // identical to "the doc genuinely had nothing to map" — the failure mode
    // that hid the prod heuristic-fallback regression for weeks.
    if (result.finishReason === 'length') {
      this.logger.warn(
        `field-mapper LLM response hit the output-token cap ` +
          `(finish_reason=length, output_tokens=${result.outputTokens ?? '?'}, ` +
          `maxTokens=${MAPPER_MAX_OUTPUT_TOKENS}). JSON is likely truncated and will fail to ` +
          `parse — raise maxTokens further or pick a model with a smaller/disabled thinking budget.`,
      );
    }

    return this.parseLlmEntities(result.text, rateCard);
  }

  /**
   * Compose the user-facing prompt from the rate card. No domain
   * vocabulary — every cybersec / cleaning / legal-billing fact comes
   * from `rateCard.inferenceContext`, `rateCard.defaultMethodologyRule`,
   * and per-slug `inferenceHint` fields. Slugs without authored hints
   * fall through to `synthesizeDefaultHint` so older rate cards keep
   * working without a one-time data fill.
   */
  private buildLlmPrompt(rateCard: RateCard, points: ExtractedPointInput[]): string {
    const blocks: string[] = [];

    // ── Domain framing (tenant-authored) ─────────────────────────────
    if (rateCard.inferenceContext?.trim()) {
      blocks.push(`DOMAIN CONTEXT:\n${rateCard.inferenceContext.trim()}`);
    }

    // ── Methodology rule (tenant-authored) ───────────────────────────
    if (rateCard.defaultMethodologyRule?.trim()) {
      blocks.push(`DEFAULT METHODOLOGY RULE:\n${rateCard.defaultMethodologyRule.trim()}`);
    }

    // ── Slug ontology — list each slug with its inferenceHint ────────
    const slugLines = rateCard.serviceLines.map((sl) => {
      const meths = [...new Set(sl.tiers.map((t) => t.methodology).filter((m): m is string => m != null))];
      const hint = (sl.inferenceHint?.trim() || synthesizeDefaultHint(sl)).replace(/\s+/g, ' ');
      const examples = (sl.inferenceExamples ?? []).filter((s) => s.trim().length > 0);
      const exampleBlock =
        examples.length > 0 ? `\n    examples: ${examples.map((e) => `"${e.replace(/"/g, '\\"')}"`).join(' | ')}` : '';
      return (
        `- slug=${sl.slug} | scope_unit=${sl.scopeUnit}` +
        (meths.length > 0 ? ` | methodologies=[${meths.join(',')}]` : ' | methodologies=[]') +
        `\n    emit when: ${hint}` +
        exampleBlock
      );
    });
    blocks.push(`SERVICE LINES:\n${slugLines.join('\n')}`);

    // ── Tenant-authored worked examples ──────────────────────────────
    const tenantExamples = (rateCard.inferenceExamples ?? []).filter((s) => s.trim().length > 0);
    if (tenantExamples.length > 0) {
      blocks.push(
        `WORKED EXAMPLES (from this rate card):\n` +
          tenantExamples.map((e, i) => `${i + 1}. ${e.trim()}`).join('\n'),
      );
    }

    // ── Extracted points — pass label too (original Q text) ──────────
    // Older callers passed only `key`/`value`; the parser now captures
    // the original question text in `label`. Including it gives the LLM
    // full semantic context instead of forcing it to back-translate
    // snake_case keys.
    const pointLines = points
      .slice(0, 200) // bumped from 100 — security questionnaires routinely run 60–120 Q/A pairs
      .map((p) => {
        const labelPart = p.label && p.label.trim() && p.label.trim() !== p.key ? ` [Q: ${p.label.trim()}]` : '';
        const sheetPart = p.sheet ? ` [sheet: ${p.sheet}]` : '';
        // Wide multi-app questionnaires pre-tag each point with the
        // application it belongs to. Surface it so the LLM groups entities
        // per application instead of merging them (see SYSTEM_KERNEL rule 2).
        const appPart = p.appId ? ` [app: ${p.appId}]` : '';
        return `- ${p.key}: ${p.value}${labelPart}${sheetPart}${appPart}`;
      })
      .join('\n');
    blocks.push(`EXTRACTED POINTS:\n${pointLines}`);

    // ── Output schema (universal) ────────────────────────────────────
    blocks.push(OUTPUT_SCHEMA_INSTRUCTIONS);

    return blocks.join('\n\n');
  }

  private parseLlmEntities(raw: string, rateCard: RateCard): LlmInferResult {
    const empty: LlmInferResult = { entities: [], considered: [] };
    if (!raw) {
      this.logger.warn('LLM returned empty response — treating as zero entities');
      return empty;
    }
    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '');

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (firstErr) {
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      if (start === -1 || end === -1) {
        this.logger.warn(
          `LLM response not parseable as JSON; no '{' or '}' found: ${(firstErr as Error).message} ` +
            `(raw[0..200]="${cleaned.slice(0, 200)}")`,
        );
        return empty;
      }
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (secondErr) {
        this.logger.warn(
          `LLM response unparseable even after substring extraction: ${(secondErr as Error).message} ` +
            `(raw[0..200]="${cleaned.slice(0, 200)}")`,
        );
        return empty;
      }
    }

    const arr = (parsed as { entities?: unknown }).entities;
    if (!Array.isArray(arr)) {
      this.logger.warn(
        `LLM response missing or invalid "entities" field; got ${typeof arr}. ` +
          `Returning zero entities.`,
      );
      return empty;
    }

    const slBySlug = new Map(rateCard.serviceLines.map((s) => [s.slug, s]));
    const out: InferredEntity[] = [];
    let droppedHallucinated = 0;
    let droppedBadScope = 0;
    let confidenceClamped = 0;
    for (const e of arr) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      const slug = typeof r.serviceLineSlug === 'string' ? r.serviceLineSlug : null;
      if (!slug) continue;
      const sl = slBySlug.get(slug);
      if (!sl) {
        droppedHallucinated++;
        continue;
      }
      const scopeValue = Number(r.scopeValue);
      if (!Number.isFinite(scopeValue) || scopeValue <= 0) {
        droppedBadScope++;
        continue;
      }
      const customerType = r.customerType === 'internal' ? 'internal' : 'external';

      // Auto-pick methodology from customer type + slug. The LLM may
      // emit something that doesn't exist in this rate card's tier
      // methodologies (e.g. canonical `black_box` when tiers carry
      // `black_box_apk`). autoPickMethodology resolves that.
      const methodology =
        isValidMethodology(r.methodology) && r.methodology !== null
          ? resolveServiceLineMethodology(sl, r.methodology)
          : autoPickMethodology(sl, customerType);

      const rawConfidence = Number(r.confidence);
      const reasoning = typeof r.reasoning === 'string' ? r.reasoning.slice(0, 300) : '';
      const sourceQuote = typeof r.sourceQuote === 'string' ? r.sourceQuote.slice(0, 300) : '';

      let confidence = 0;
      if (Number.isFinite(rawConfidence)) {
        const clamped = Math.min(1, Math.max(0, rawConfidence));
        if (clamped !== rawConfidence) {
          confidenceClamped++;
        }
        confidence = clamped;
      }

      // Optional `appId` groups multiple driver entities under the same
      // application (e.g. all `vapt_web_app_*` entities tagged
      // `appId: "web_app_1"` belong to one Web App; `web_app_2` is a
      // separate iteration). Only accept strings that look reasonable
      // — empty / non-string values are dropped.
      const appIdRaw = r.appId;
      const appId =
        typeof appIdRaw === 'string' && appIdRaw.trim().length > 0
          ? appIdRaw.trim().slice(0, 64)
          : undefined;

      out.push({
        serviceLineSlug: slug,
        scopeValue,
        methodology,
        customerType,
        confidence,
        reasoning,
        sourceQuote,
        source: 'llm',
        ...(appId ? { appId } : {}),
      });
    }
    if (droppedHallucinated > 0 || droppedBadScope > 0 || confidenceClamped > 0) {
      this.logger.warn(
        `LLM mapper sanitised: ${droppedHallucinated} hallucinated-slug + ` +
          `${droppedBadScope} non-numeric/zero-scope dropped; ` +
          `${confidenceClamped} confidence values clamped to [0,1]`,
      );
    }

    // ── Parse `considered` array — slugs the LLM evaluated and rejected.
    // Used by `inferEntities` to suppress heuristic backfill against the
    // LLM's "no". Optional: older mocks / older models won't include it,
    // and that's fine — the heuristic suppression still works on the
    // success-with-entities path.
    const considered: ConsideredSlug[] = [];
    const consideredArr = (parsed as { considered?: unknown }).considered;
    if (Array.isArray(consideredArr)) {
      for (const c of consideredArr) {
        if (!c || typeof c !== 'object') continue;
        const cr = c as Record<string, unknown>;
        const slug = typeof cr.serviceLineSlug === 'string' ? cr.serviceLineSlug : null;
        if (!slug || !slBySlug.has(slug)) continue;
        const reason = typeof cr.reason === 'string' ? cr.reason.slice(0, 200) : '';
        considered.push({ serviceLineSlug: slug, reason });
      }
    }

    return { entities: out, considered };
  }

  // ── Heuristic safety net ──────────────────────────────────────────

  private heuristicInfer(
    points: ExtractedPointInput[],
    rateCard: RateCard,
    ctx: InferContext = {},
  ): InferredEntity[] {
    const customerType = detectCustomerType(points);
    const out: InferredEntity[] = [];

    // ── Pass 1: standard "mentioned + numeric" heuristic ────────────
    for (const sl of rateCard.serviceLines) {
      // Flat-priced slugs (IDS/IPS/DLP/IAM) are binary toggles, not counts —
      // a numeric inventory field must never price them. They are emitted
      // ONLY from an affirmative flag in Pass 2 (per the rate card's own
      // "IDS: Yes/No" hints). This stops a count like "user IDs: 4200" or
      // "IP addresses: 5" from phantom-emitting a flat network line.
      if (sl.pricingModel === 'flat') continue;

      const group = matchingKeywordGroup(sl);
      if (!group || !groupMentionedIn(group, points)) continue;

      const numeric = pickScopeValue(points, sl.scopeUnit, group.aliases);
      if (numeric == null) continue;

      const methodology = autoPickMethodology(sl, customerType);

      // Skip slugs whose only methodology variants don't match the
      // detected customer type — e.g. `vapt_web_app_roles` is grey-box-
      // only, so emitting it for an external (black-box) engagement
      // produces an unmatched line item that confuses the proposal.
      // autoPickMethodology returns null when no compatible tier
      // exists; we treat that as a "skip" rather than emitting a
      // dead entity.
      if (methodology == null && sl.tiers.some((t) => t.methodology !== null)) {
        continue;
      }

      out.push({
        serviceLineSlug: sl.slug,
        scopeValue: numeric.numericValue,
        methodology,
        customerType,
        confidence: 0.7,
        reasoning: `Heuristic: keyword "${sl.slug}" matched in document, scope=${numeric.numericValue} ${sl.scopeUnit}`,
        sourceQuote: `${numeric.point.label ?? numeric.point.key}: ${numeric.point.value}`.slice(0, 300),
        source: 'heuristic',
      });
    }

    // ── Pass 2: binary triggers (IAM/IDS/IPS/DLP — "Yes/Enabled") ────
    // These slugs price flat regardless of count; we just need scope=1
    // when the doc mentions them with a positive flag.
    const binaryHits = detectBinaryFlags(points, rateCard);
    for (const hit of binaryHits) {
      if (out.some((e) => e.serviceLineSlug === hit.slug)) continue; // dedup
      const sl = rateCard.serviceLines.find((s) => s.slug === hit.slug);
      if (!sl) continue;
      const methodology = autoPickMethodology(sl, customerType);
      out.push({
        serviceLineSlug: hit.slug,
        scopeValue: 1,
        methodology,
        customerType,
        confidence: 0.75,
        reasoning: `Binary trigger: "${hit.match}" maps to ${hit.slug}`,
        sourceQuote: `${hit.point.label ?? hit.point.key}: ${hit.point.value}`.slice(0, 300),
        source: 'heuristic',
      });
    }

    // ── Pass 3: URL counting → cloud_instances ───────────────────────
    // The headline case: client supplies a list of AWS/Azure URLs.
    // Each URL becomes one cloud instance to audit. We count, never
    // duplicate (LLM may have already emitted vapt_cloud_instances).
    const urlCount = countCloudUrls(points, ctx.filename ?? null);
    if (urlCount.count > 0 && !out.some((e) => e.serviceLineSlug === 'vapt_cloud_instances')) {
      const sl = rateCard.serviceLines.find((s) => s.slug === 'vapt_cloud_instances');
      if (sl) {
        const methodology = autoPickMethodology(sl, customerType);
        out.push({
          serviceLineSlug: 'vapt_cloud_instances',
          scopeValue: urlCount.count,
          methodology,
          customerType,
          // AWS-domain URLs are stronger signals than generic https://
          confidence: urlCount.confidence,
          reasoning: `URL-count heuristic: ${urlCount.count} ${urlCount.flavor} URL(s) detected`,
          sourceQuote: urlCount.sample.slice(0, 300),
          source: 'heuristic',
        });
      }
    }

    return out;
  }
}

// ── Domain-neutral system kernel + output schema ────────────────────
//
// The kernel describes universal B2B inference rules that hold whether
// the rate card is for cybersec, cleaning, legal billing, or anything
// else. Slug ontology + methodology rules + worked examples come from
// the rate card itself (composed in buildLlmPrompt) so this kernel
// never needs to know what domain it's running in.

const SYSTEM_KERNEL = [
  'You are a careful B2B pricing analyst. Given a rate card and extracted',
  'data points from a client document, decide which rate-card service lines',
  'this engagement actually requires.',
  '',
  'UNIVERSAL EVIDENCE RULES — apply these regardless of domain:',
  '',
  ' 1. Service lines are DRIVER-LEVEL. Each slug represents one priceable',
  '    dimension. Emit one entity per driver per application — DO NOT',
  '    collapse drivers into a single line.',
  '',
  ' 2. Multi-occurrence grouping via appId. When the document describes',
  '    multiple instances of the same domain (e.g. two web apps, three',
  '    iOS apps, four sites), give each instance a unique appId and tag',
  '    every driver entity for that instance with the same appId. Format:',
  '    {domain}_{n} — e.g. web_app_1, web_app_2, ios_app_1, site_1.',
  '    Single-occurrence service lines (network, cloud-as-a-whole, IAM)',
  '    leave appId null.',
  '    IMPORTANT: when a point is pre-tagged "[app: X]", that point already',
  '    belongs to a known application instance — reuse X VERBATIM as the',
  '    appId for every entity you derive from it. Never merge points that',
  '    carry different [app: ...] tags into one entity.',
  '',
  ' 3. Evidence priority — the doc IS your only source of truth:',
  '    a. Stated count for the driver           → use it, confidence ≥0.8',
  '       e.g. "29 dynamic pages" → scope=29',
  '    b. URL / asset / item list               → derive count, confidence 0.7',
  '       Distinct hostnames are SEPARATE parent items (each gets its own',
  '       appId); distinct paths on the same hostname are children of that',
  '       item (count toward that item\'s page/screen driver).',
  '    c. Comma-separated answer ("Admin, Read-only") → count items (=2)',
  '    d. Qualitative "Yes" / "Present" / "Enabled" with no count → scope=1,',
  '       confidence 0.5',
  '    e. Negation ("No", "None", "Not applicable", "N/A", "Not in scope")',
  '       → DO NOT EMIT. List the slug in `considered` with reason="negated".',
  '    f. No mention at all → DO NOT EMIT. List in `considered` with',
  '       reason="not_mentioned" only if the slug is plausibly relevant',
  '       given the doc\'s domain; otherwise omit silently.',
  '',
  ' 4. The rate card carries domain framing in DOMAIN CONTEXT and slug-',
  '    specific guidance under each slug\'s "emit when" hint. READ THE',
  '    HINTS — they tell you exactly when each slug applies.',
  '',
  ' 5. Methodology rule for this rate card is in DEFAULT METHODOLOGY RULE.',
  '    Apply it per entity. For service lines whose methodologies array',
  '    is empty (no methodology axis) set methodology to null.',
  '',
  ' 6. Confidence calibration: ≥0.8 only when (a) stated count or (b)',
  '    derived from an unambiguous URL/asset list. 0.5–0.7 for borderline,',
  '    qualitative-only, or partial evidence. <0.5 for guesses (drop).',
  '',
  ' 7. For every emitted entity include reasoning (one sentence) and',
  '    sourceQuote (verbatim ≤200 chars from the doc that justifies it).',
  '',
  ' 8. Output strict JSON. No preamble, no markdown fences.',
].join('\n');

const OUTPUT_SCHEMA_INSTRUCTIONS = [
  'OUTPUT — return JSON exactly:',
  '{',
  '  "entities": [',
  '    {',
  '      "serviceLineSlug": "<slug from SERVICE LINES above>",',
  '      "scopeValue": <integer count matching the slug\'s scope_unit>,',
  '      "methodology": "<one of the slug\'s methodologies, or null>",',
  '      "customerType": "internal" | "external",',
  '      "appId": "<domain>_<n>" | null,',
  '      "confidence": <0.0..1.0>,',
  '      "reasoning": "<one sentence>",',
  '      "sourceQuote": "<verbatim ≤200 chars>"',
  '    }',
  '  ],',
  '  "considered": [',
  '    { "serviceLineSlug": "<slug>", "reason": "<short reason>" }',
  '  ]',
  '}',
  '',
  'The `considered` array names slugs you evaluated and chose NOT to emit',
  '(reason: "negated", "not_mentioned", "needs_more_evidence", etc.). The',
  'mapper uses this to suppress fallback heuristics for slugs you already',
  'judged. If the doc supports nothing, return { "entities": [], "considered": [] }.',
  '',
  'Output ONLY the JSON.',
].join('\n');

/**
 * Default-hint synthesiser used when a rate card slug has no authored
 * `inferenceHint`. Older rate cards (and freshly-imported ones from the
 * CSV parser) will have this empty; we synthesise something safe from
 * `displayName` + `scopeUnit` + methodology metadata so the LLM gets a
 * minimum viable instruction. Tenants override this by populating
 * `inferenceHint` on the rate card.
 */
export function synthesizeDefaultHint(sl: RateCardServiceLine): string {
  const scopeNoun = SCOPE_UNIT_NOUN[sl.scopeUnit];
  const meths = [...new Set(sl.tiers.map((t) => t.methodology).filter((m): m is string => m != null))];
  const methClause =
    meths.length === 0
      ? ''
      : meths.length === 1 && meths[0] === 'white_box'
        ? ' This is a white-box-only line — only emit when the doc explicitly requests this kind of review.'
        : ` This line supports methodologies: ${meths.join(', ')}.`;
  return `Emit when the document evidences "${sl.displayName}" with a count of ${scopeNoun}.${methClause}`;
}

const SCOPE_UNIT_NOUN: Record<ScopeUnit, string> = {
  pages: 'pages',
  screens: 'screens',
  apis: 'APIs / endpoints',
  loc: 'lines of code',
  devices: 'devices / instances',
  hours: 'hours',
  other: 'units',
};

// ── Helpers (heuristic + methodology resolution) ────────────────────

// Keyword gate vocabulary. Two tiers:
//   • Driver-specific tokens (input fields, dynamic pages, firewalls, …)
//     attach their own narrow alias list. Used by the granular Prophaze
//     slugs to keep the gate strict.
//   • Domain tokens (web, mobile, api, network, …) cover legacy slugs
//     like `vapt_web_app` that don't carry a driver suffix.
//
// `matchingKeywordGroup` prefers a driver-specific group over a domain
// group whenever both could match (see DOMAIN_TOKENS), so a slug is gated
// on its own driver keyword rather than its broad domain.
const SERVICE_LINE_KEYWORDS: Array<{ token: string; aliases: string[] }> = [
  // Driver-specific (preferred for Prophaze-style granular slugs).
  { token: 'input_fields',     aliases: ['input field', 'form field', 'form input'] },
  { token: 'input fields',     aliases: ['input field', 'form field', 'form input'] },
  { token: 'dynamic_pages',    aliases: ['dynamic page', 'browser page', 'spa page', 'single page'] },
  { token: 'dynamic pages',    aliases: ['dynamic page', 'browser page', 'spa page', 'single page'] },
  { token: 'static_pages',     aliases: ['static page', 'marketing page', 'html page'] },
  { token: 'static pages',     aliases: ['static page', 'marketing page', 'html page'] },
  { token: 'login_modules',    aliases: ['login module', 'auth module', 'sso', 'authentication module'] },
  { token: 'login modules',    aliases: ['login module', 'auth module', 'sso', 'authentication module'] },
  { token: 'roles',            aliases: ['role', 'user role', 'rbac'] },
  { token: 'endpoints',        aliases: ['endpoint', 'api endpoint', 'rest endpoint'] },
  { token: 'screens',          aliases: ['screen', 'mobile screen'] },
  { token: 'static_analysis',  aliases: ['static analysis', 'sast'] },
  { token: 'static analysis',  aliases: ['static analysis', 'sast'] },
  { token: 'classes',          aliases: ['class', 'java class', 'objc class', 'swift class'] },
  { token: 'firewalls',        aliases: ['firewall'] },
  { token: 'routers',          aliases: ['router'] },
  { token: 'switches',         aliases: ['switch ', ' switch', 'network switch'] },
  { token: 'antivirus',        aliases: ['antivirus', ' av '] },
  { token: 'ids',              aliases: ['ids', 'intrusion detection'] },
  { token: 'ips',              aliases: ['ips', 'intrusion prevention'] },
  { token: 'dlp',              aliases: ['dlp', 'data loss prevention'] },
  { token: 'instances',        aliases: ['instance', 'ec2', 'vm', 'virtual machine'] },
  { token: 'databases',        aliases: ['database', ' db ', 'rds', 'sql server', 'postgres', 'mysql'] },
  { token: 'iam',              aliases: ['iam', 'identity and access', 'identity & access'] },
  { token: 'source_code',      aliases: ['source code', 'code review', 'sast', 'lines of code'] },
  { token: 'source code',      aliases: ['source code', 'code review', 'sast', 'lines of code'] },
  { token: 'sca',              aliases: ['sca', 'source component', 'component analysis'] },

  // Domain (broader fallback for non-granular slugs).
  { token: 'web',     aliases: ['web ', 'website', 'webapp', 'browser', 'http', 'url'] },
  { token: 'mobile',  aliases: ['mobile', 'android', 'ios', 'apk', 'ipa', 'iphone', 'app store', 'play store'] },
  { token: 'android', aliases: ['android', 'apk', 'play store'] },
  { token: 'ios',     aliases: ['ios', 'ipa', 'iphone', 'app store'] },
  { token: 'api',     aliases: ['api', 'endpoint', 'rest', 'graphql', 'webhook'] },
  { token: 'thick',   aliases: ['thick client', 'desktop', 'windows app', 'mac app', 'binary', 'executable'] },
  { token: 'network', aliases: ['network', 'firewall', 'router', 'switch', 'subnet', 'vlan'] },
  { token: 'cloud',   aliases: ['cloud', 'aws', 'azure', 'gcp', 'instance', 'database'] },
];

// Pre-sorted longest-first so longest-match wins.
const SERVICE_LINE_KEYWORDS_BY_LENGTH = [...SERVICE_LINE_KEYWORDS].sort(
  (a, b) => b.token.length - a.token.length,
);

// The broad DOMAIN tokens (the "Domain" section above). Their aliases are
// deliberately wide — e.g. `network` aliases include "firewall"/"router" —
// so they're only safe as a fallback for legacy single-axis slugs that
// carry no driver-specific token. A driver-level slug (e.g. IDS/IPS/DLP)
// must NEVER be gated by a domain token: see the precedence rule in
// matchingKeywordGroup.
const DOMAIN_TOKENS = new Set<string>([
  'web', 'mobile', 'android', 'ios', 'api', 'thick', 'network', 'cloud',
]);

interface KeywordGroup {
  token: string;
  aliases: string[];
}

// Short aliases that are common substrings of unrelated words. They are
// matched as WHOLE tokens (non-letter boundaries) instead of substrings, so
// "user_ids"/"tooltips"/"miami"/"scada"/"average" don't phantom-trigger a
// flat-priced network/cloud line. Mirrors the boundary discipline already
// used by BINARY_TRIGGERS. P0 follow-up to the driver-precedence fix below:
// promoting these short driver tokens to win the gate also exposed their
// bare-substring aliases, so we tighten the alias match in lock-step.
const AMBIGUOUS_ALIASES = new Set<string>([
  'ids', 'ips', 'dlp', 'iam', 'sca', 'av', 'db', 'sso', 'rds',
]);

/** True when `alias` appears in `haystack` (caller passes it lowercased).
 *  Ambiguous short aliases match as whole tokens with an optional plural
 *  's' — so "SCAs"/"SSOs"/"DBs"/"AVs" (legitimate acronym plurals) still
 *  match, while "scada"/"scan"/"miami"/"average" (the alias embedded in a
 *  longer word) still don't. */
function aliasMatches(alias: string, haystack: string): boolean {
  const a = alias.trim();
  if (AMBIGUOUS_ALIASES.has(a)) {
    return new RegExp(`(?:^|[^a-z])${a}s?(?:[^a-z]|$)`, 'i').test(haystack);
  }
  return haystack.includes(alias);
}

/**
 * The keyword group that NAMES this service line. Driver-specific tokens
 * take precedence over the broad DOMAIN tokens REGARDLESS of length.
 *
 * The old rule was "longest token wins", which mis-fired for the short
 * driver tokens `ids`/`ips`/`dlp` (3 chars): they lost the tie-break to the
 * broad `network` domain token (7 chars), whose aliases include
 * "firewall"/"router". A doc that merely listed a firewall then
 * phantom-matched IDS/IPS/DLP, each priced flat (10k/10k/50k) — inflating the
 * quote by 70k. So: prefer the most-specific DRIVER token that names this
 * slug; only fall back to a domain token when the slug has no driver token.
 *
 * Shared by `isServiceLineMentioned` (does the doc name this slug at all?)
 * and `pickScopeValue` (which point carries this slug's count?) so both
 * reason from the SAME evidence — a slug's scope can only come from a point
 * that names that slug's own driver, never a sibling's count.
 */
function matchingKeywordGroup(sl: RateCardServiceLine): KeywordGroup | null {
  const slText = `${sl.slug} ${sl.displayName}`.toLowerCase();
  return (
    SERVICE_LINE_KEYWORDS_BY_LENGTH.find(
      (g) => !DOMAIN_TOKENS.has(g.token) && slText.includes(g.token),
    ) ??
    SERVICE_LINE_KEYWORDS_BY_LENGTH.find(
      (g) => DOMAIN_TOKENS.has(g.token) && slText.includes(g.token),
    ) ??
    null
  );
}

/** True when any of the group's aliases is named by some extracted point. */
function groupMentionedIn(group: KeywordGroup, points: ExtractedPointInput[]): boolean {
  for (const p of points) {
    const haystack = `${p.key} ${p.label ?? ''} ${p.value}`.toLowerCase();
    if (group.aliases.some((alias) => aliasMatches(alias, haystack))) return true;
  }
  return false;
}

function resolveServiceLineMethodology(
  sl: RateCardServiceLine,
  base: Methodology | null,
): Methodology | null {
  if (base == null) return null;
  const tierMethods = new Set(
    sl.tiers.map((t) => t.methodology).filter((m): m is string => m != null),
  );
  if (tierMethods.size === 0) return null;
  if (tierMethods.has(base)) return base;
  const matches = [...tierMethods]
    .filter((m) => m === base || m.startsWith(`${base}_`))
    .sort((a, b) => a.length - b.length);
  if (matches[0]) return matches[0];
  return null;
}

const SCOPE_PATTERNS: Record<ScopeUnit, RegExp[]> = {
  pages: [/page/i, /web_app|web app/i, /url/i],
  screens: [/screen/i, /mobile_screen/i],
  apis: [/api(?:s|_count|_endpoint)?/i, /endpoint/i],
  loc: [/lines?_of_code|loc|sloc/i, /code_lines?/i],
  devices: [
    /device/i,
    /server/i,
    /host/i,
    /asset/i,
    /firewall/i,
    /router/i,
    /switch/i,
    /antivirus/i,
    /ids|ips|dlp/i,
    /instance/i,
    /database/i,
  ],
  hours: [/hour/i, /effort/i, /duration/i],
  other: [
    /^count$|number_of/i,
    /input.*field|form.*field/i,
    /role/i,
    /login.*module|auth.*module|sso/i,
    /class\b/i,
    /iam/i,
  ],
};

interface DetectedNumeric {
  point: ExtractedPointInput;
  numericValue: number;
}

function pickScopeValue(
  points: ExtractedPointInput[],
  scopeUnit: ScopeUnit,
  driverAliases: string[],
): DetectedNumeric | null {
  const patterns = SCOPE_PATTERNS[scopeUnit];

  let best: DetectedNumeric | null = null;
  let bestScore = -1;

  for (const p of points) {
    const num = parseNumber(p.value);
    if (num == null || num <= 0) continue;

    const haystack = `${p.key} ${p.label ?? ''}`;

    // The scope MUST come from a point that names THIS slug's own driver
    // (the same keyword group that proved the slug was mentioned) — never a
    // sibling device's count. The old code scored any point matching the
    // broad scopeUnit pattern set (shared by every device slug) plus a weak
    // token-overlap that leaked the domain word "network", so "1 firewall" +
    // "500 endpoint devices on network" priced 500 firewalls (₹2.5M). The
    // earlier mention-gate fix governs WHICH slugs appear; this governs the
    // count they carry. The driver name may live in the answer VALUE
    // ("What network devices? → 2 firewalls"), so check key+label+value —
    // matching groupMentionedIn — not just key+label.
    const driverHay = `${p.key} ${p.label ?? ''} ${p.value}`.toLowerCase();
    if (!driverAliases.some((alias) => aliasMatches(alias, driverHay))) {
      continue;
    }

    // Among the driver-naming points, prefer the one that also matches the
    // scopeUnit pattern (e.g. /firewall/ for devices); a driver-naming point
    // with no pattern hit (score 0) is still eligible over nothing.
    const score = patterns.filter((re) => re.test(haystack)).length * 10;
    if (score > bestScore) {
      bestScore = score;
      best = { point: p, numericValue: num };
    }
  }
  return best;
}

function detectCustomerType(points: ExtractedPointInput[]): CustomerType {
  const re = /customer_type|access_type|client_type|internal|external|public/i;
  for (const p of points) {
    if (!re.test(`${p.key} ${p.label ?? ''}`)) continue;
    const v = p.value.toLowerCase();
    if (v.includes('internal')) return 'internal';
    if (v.includes('public') || v.includes('external')) return 'external';
  }
  return 'external';
}

// ── Binary trigger detection (IAM / IDS / IPS / DLP — "Yes/Enabled") ──
// These slugs price flat per-engagement regardless of count; the rate
// card stores rangeMin=1 so scopeValue=1 unlocks the tier. The LLM is
// hit-and-miss with these because the surrounding text is qualitative
// ("we have IAM enabled") rather than quantitative — the heuristic
// catches them deterministically.
//
// Word-boundary semantics: JavaScript's `\b` treats underscores as word
// chars, so `\bids\b` matches "ids" inside "ids_count" but also inside
// "kids" (because k-i-d → no `\b` between k and i, but between d and s
// it's fine; actually `\bids\b` does NOT match "kids" because there's no
// word boundary before 'i' in "kids"). The real risk is "ids" inside
// "credentials" — `credentialsfoo` doesn't trip `\bids\b` either, but
// the contiguous "id" inside "credentials" combined with patterns like
// `[\W_]ids[\W_]` would be safer. We tighten with explicit non-letter
// boundaries on each side, plus a minimum-length sanity check on the
// positive-value match (P1-9 in see-that-is-self-sunny-honey.md).
//
// positiveValues deliberately EXCLUDES the bare numeric "1": these are
// yes/no toggles, and "1" is ambiguous with a count. "Number of public
// IPs: 1" was firing a phantom IPS line (₹10k) because "IPs" trips the
// /ips/ boundary and "1" read as "yes". Affirmatives are word flags
// (yes/true/enabled/present/deployed); a count of 1 is not one of them.
const BINARY_TRIGGERS: Array<{
  slug: string;
  patterns: RegExp[];
  positiveValues: RegExp;
}> = [
  {
    slug: 'vapt_cloud_iam',
    patterns: [/(?:^|[^a-z])iam(?:[^a-z]|$)/i, /identity.*access/i],
    positiveValues: /^(yes|true|enabled|y|present)$/i,
  },
  {
    slug: 'vapt_network_ids',
    patterns: [/(?:^|[^a-z])ids(?:[^a-z]|$)/i, /intrusion.*detection/i],
    positiveValues: /^(yes|true|enabled|y|present|deployed)$/i,
  },
  {
    slug: 'vapt_network_ips',
    patterns: [/(?:^|[^a-z])ips(?:[^a-z]|$)/i, /intrusion.*prevention/i],
    positiveValues: /^(yes|true|enabled|y|present|deployed)$/i,
  },
  {
    slug: 'vapt_network_dlp',
    patterns: [/(?:^|[^a-z])dlp(?:[^a-z]|$)/i, /data.*loss.*prevention/i],
    positiveValues: /^(yes|true|enabled|y|present|deployed)$/i,
  },
];

interface BinaryHit {
  slug: string;
  match: string;
  point: ExtractedPointInput;
}

export function detectBinaryFlags(
  points: ExtractedPointInput[],
  rateCard: RateCard,
): BinaryHit[] {
  const validSlugs = new Set(rateCard.serviceLines.map((s) => s.slug));
  const hits: BinaryHit[] = [];
  for (const trigger of BINARY_TRIGGERS) {
    if (!validSlugs.has(trigger.slug)) continue;
    for (const p of points) {
      const haystack = `${p.key} ${p.label ?? ''}`;
      if (!trigger.patterns.some((re) => re.test(haystack))) continue;
      const valTrim = p.value.trim();
      if (trigger.positiveValues.test(valTrim)) {
        hits.push({ slug: trigger.slug, match: valTrim, point: p });
        break;
      }
    }
  }
  return hits;
}

// ── URL counting → cloud_instances ────────────────────────────────────
// The user's headline case: client provides a list of cloud URLs.
// Each line of an URL list becomes one cloud instance to audit. AWS /
// Azure / GCP domain hits boost confidence; generic https:// only
// triggers when filename hints lean cloud.
const CLOUD_DOMAIN_RE = /\.(amazonaws|azure|aws|cloudfront|googleapis|cloud\.goog|gcp|s3)\b/i;
const ANY_URL_RE = /\bhttps?:\/\/[^\s,;]+/gi;
const CLOUD_FILENAME_RE = /aws|azure|gcp|cloud|inventory|deployment/i;

interface UrlCountResult {
  count: number;
  confidence: number;
  flavor: string;
  sample: string;
}

// Bounded so a 100-page doc with thousands of URLs in cells doesn't
// stall the mapper. The first MAX_URL_HITS we see is more than enough
// to make a count-based decision (`vapt_cloud_instances` prices the
// same after ~50 instances anyway thanks to the cap tier). P1-10 in
// see-that-is-self-sunny-honey.md.
const MAX_URL_HITS = 500;

export function countCloudUrls(
  points: ExtractedPointInput[],
  filename: string | null,
): UrlCountResult {
  let cloudHits: string[] = [];
  let genericHits: string[] = [];
  outer: for (const p of points) {
    const urls = (p.value ?? '').match(ANY_URL_RE) ?? [];
    for (const u of urls) {
      if (CLOUD_DOMAIN_RE.test(u)) cloudHits.push(u);
      else genericHits.push(u);
      if (cloudHits.length + genericHits.length >= MAX_URL_HITS) break outer;
    }
  }
  // Prefer cloud-domain hits — they're the strong signal.
  if (cloudHits.length > 0) {
    return {
      count: cloudHits.length,
      confidence: 0.85,
      flavor: 'cloud-domain',
      sample: cloudHits.slice(0, 3).join('; '),
    };
  }
  // Fall back to generic URLs only if filename hints lean cloud.
  if (genericHits.length >= 2 && filename && CLOUD_FILENAME_RE.test(filename)) {
    return {
      count: genericHits.length,
      confidence: 0.7,
      flavor: `generic (filename hint: ${filename})`,
      sample: genericHits.slice(0, 3).join('; '),
    };
  }
  return { count: 0, confidence: 0, flavor: 'none', sample: '' };
}

function parseNumber(value: string): number | null {
  if (!value) return null;
  const m = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function isValidMethodology(v: unknown): v is Methodology {
  return (
    v === 'grey_box' ||
    v === 'black_box' ||
    v === 'white_box' ||
    v === 'va' ||
    v === 'pt'
  );
}

/**
 * Customer-type → methodology auto-pick (Private/Enterprise sector).
 *   external → black_box, internal → grey_box.
 *
 * White-box detection is **rate-card-driven**: a service line that
 * carries `white_box` in its tier methodologies is treated as opt-in
 * white-box regardless of customer type. This replaces the earlier
 * hard-coded suffix whitelist (`_source_code_backend`, `_source_code_frontend`,
 * `_sca`) which silently mis-classified any future white-box slug a
 * tenant added — P1-6 in majestic-whistling-whistle.md.
 *
 * The desired methodology then runs through `resolveServiceLineMethodology`
 * to translate canonical → variant (`black_box` → `black_box_apk` etc.)
 * for service lines that carry methodology variants.
 */
function isWhiteBoxOnlyServiceLine(sl: RateCardServiceLine): boolean {
  // A service line is "white-box only" when EVERY tier's methodology
  // is `white_box`. Service lines with multiple methodologies (web app
  // BB/GB) shouldn't be auto-promoted to white-box just because they
  // happen to have a white-box variant in some tiers — those need
  // explicit opt-in from the LLM/responder.
  if (sl.tiers.length === 0) return false;
  return sl.tiers.every((t) => t.methodology === 'white_box');
}

function autoPickMethodology(
  sl: RateCardServiceLine,
  customerType: CustomerType,
): Methodology | null {
  const desired: Methodology = isWhiteBoxOnlyServiceLine(sl)
    ? 'white_box'
    : customerType === 'external'
      ? 'black_box'
      : 'grey_box';
  return resolveServiceLineMethodology(sl, desired);
}
