/**
 * URL classifier — turns a `DiscoveredPage` into one of the canonical
 * `SITE_URL_CATEGORIES`. Two-tier:
 *
 *   1. Heuristic — URL path tokens, content-type, meta tags. Fast,
 *      deterministic, no LLM. Always runs and produces a draft category
 *      so the UI has something even if the LLM is unavailable.
 *   2. LLM batch refinement — sends batches of pages (URL, title,
 *      description, draft category) to the configured LlmService.
 *      Produces a category + confidence + short reasoning. On failure
 *      we keep the heuristic result and emit a `mapper_fallback_heuristic`
 *      thread event so the rep knows to re-run later.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  SITE_URL_CATEGORIES,
  type SiteUrlCategory,
  type RateCard,
} from '@rhud/shared';
import { LlmService } from '../llm/llm.service.js';
import type { ChatMessage } from '../llm/llm.types.js';
import type { DiscoveredPage } from './crawler.service.js';

export interface ClassifiedPage {
  url: string;
  title: string | null;
  description: string | null;
  httpStatus: number;
  contentType: string | null;
  category: SiteUrlCategory;
  confidence: number;
  source: 'heuristic' | 'llm';
}

export type ClassifyFallbackReason =
  | 'llm_disabled'
  | 'llm_rate_limited'
  | 'llm_parse_error'
  | 'llm_other';

export interface ClassifyOptions {
  /** Optional callback invoked once if the LLM path fails for any
   *  reason — caller emits the matching thread event. */
  onLlmFallback?: (reason: ClassifyFallbackReason, message: string) => void;
}

/** Pages per LLM batch. Smaller = more round-trips; larger = bigger
 *  prompts and more risk of a 429. 25 strikes a good balance for the
 *  per-page payload (~80-150 chars) we send. */
const BATCH_SIZE = 25;

@Injectable()
export class SiteClassifierService {
  private readonly logger = new Logger(SiteClassifierService.name);

  constructor(private readonly llm: LlmService) {}

  /** Classify every page in `pages`. Always returns one entry per input
   *  in the same order; on LLM failure, falls back to heuristic-only. */
  async classify(
    tenantId: string,
    pages: DiscoveredPage[],
    rateCard: RateCard | null,
    opts: ClassifyOptions = {},
  ): Promise<ClassifiedPage[]> {
    // Heuristic pass — always.
    const heuristic = pages.map((p) => this.heuristicOne(p));

    // Decide whether to run the LLM refinement.
    const provider = await this.llm.getProviderName(tenantId).catch(() => null);
    if (!provider || provider === 'manual') {
      opts.onLlmFallback?.('llm_disabled', 'LLM provider not configured');
      return heuristic;
    }

    // LLM refinement, batched. We OVERLAY the LLM result onto the
    // heuristic — anything the LLM doesn't return falls back.
    const byUrl = new Map(heuristic.map((c) => [c.url, c] as const));
    let fallbackOnce: { reason: ClassifyFallbackReason; message: string } | null = null;
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const slice = pages.slice(i, i + BATCH_SIZE);
      try {
        const refined = await this.llmBatch(tenantId, slice, byUrl, rateCard);
        for (const r of refined) byUrl.set(r.url, r);
      } catch (e) {
        const msg = (e as Error).message ?? 'unknown';
        const reason: ClassifyFallbackReason = msg.includes('429') || /rate_limit|resource_exhausted/i.test(msg)
          ? 'llm_rate_limited'
          : msg.includes('parse')
            ? 'llm_parse_error'
            : 'llm_other';
        if (!fallbackOnce) fallbackOnce = { reason, message: msg };
        this.logger.warn(`classify llm batch failed (i=${i}): ${msg}`);
        // Keep heuristic for this batch; continue to the next so a
        // single bad batch doesn't blow up the whole classification.
      }
    }
    if (fallbackOnce) opts.onLlmFallback?.(fallbackOnce.reason, fallbackOnce.message);

    return pages.map((p) => byUrl.get(p.url) ?? this.heuristicOne(p));
  }

  // ── Heuristic ───────────────────────────────────────────────────────

  private heuristicOne(p: DiscoveredPage): ClassifiedPage {
    // Pages explicitly marked by the JS crawler as APIs or integrations
    // skip the URL/path heuristic — they were captured precisely
    // because they're known not to be regular HTML pages.
    if (p.kind === 'api') {
      return { ...this.passThrough(p), category: 'api', confidence: 0.9 };
    }
    if (p.kind === 'integration') {
      return { ...this.passThrough(p), category: 'integration', confidence: 0.95 };
    }
    const cat = heuristicCategory({
      url: p.url,
      contentType: p.contentType,
      title: p.title,
      description: p.description,
      html: p.html,
    });
    return { ...this.passThrough(p), category: cat, confidence: 0.6 };
  }

  private passThrough(p: DiscoveredPage): Omit<ClassifiedPage, 'category' | 'confidence'> {
    return {
      url: p.url,
      title: p.title,
      description: p.description,
      httpStatus: p.httpStatus,
      contentType: p.contentType,
      source: 'heuristic',
    };
  }

  // ── LLM batch ───────────────────────────────────────────────────────

  private async llmBatch(
    tenantId: string,
    batch: DiscoveredPage[],
    heuristicByUrl: Map<string, ClassifiedPage>,
    rateCard: RateCard | null,
  ): Promise<ClassifiedPage[]> {
    const items = batch.map((p, idx) => {
      const h = heuristicByUrl.get(p.url);
      return {
        idx,
        url: p.url,
        title: (p.title ?? '').slice(0, 120),
        description: (p.description ?? '').slice(0, 240),
        contentType: p.contentType ?? '',
        heuristic: h?.category ?? 'other',
      };
    });

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You classify URLs from a prospect\'s existing website into pricing-relevant categories. ' +
          'Output valid JSON only — no preamble, no markdown fences. ' +
          'Use the heuristic suggestion as a hint but override when the title/description/URL clearly indicates otherwise. ' +
          'IMPORTANT: "other" is a last-resort bucket reserved for pages that genuinely do not fit any of the named categories. ' +
          'Marketing landing pages, homepages, About / Contact / Pricing pages, and generic informational pages all belong in "cms" — not "other". ' +
          'When uncertain between two categories, prefer the more specific one (e.g. "form" over "cms" if a form is clearly the page\'s purpose).',
      },
      {
        role: 'user',
        content: this.buildUserPrompt(items, rateCard),
      },
    ];

    const result = await this.llm.chat(tenantId, messages, {
      maxTokens: 1_500,
      temperature: 0,
      timeoutMs: 45_000,
    });

    return parseLlmBatchResponse(result.text, batch, heuristicByUrl);
  }

  private buildUserPrompt(
    items: Array<{
      idx: number;
      url: string;
      title: string;
      description: string;
      contentType: string;
      heuristic: string;
    }>,
    rateCard: RateCard | null,
  ): string {
    const categories = SITE_URL_CATEGORIES.join(', ');
    const context = rateCard?.inferenceContext?.trim()
      ? `Domain context for the rate card we'll price against:\n${rateCard.inferenceContext.trim()}\n\n`
      : '';
    const list = items
      .map((it) => {
        const meta = [it.title, it.description].filter(Boolean).join(' — ').slice(0, 360);
        const ct = it.contentType ? ` [${it.contentType}]` : '';
        return `${it.idx}. ${it.url}${ct} (heuristic: ${it.heuristic})\n   meta: ${meta}`;
      })
      .join('\n');
    return (
      `${context}` +
      `Categories (use exactly these strings): ${categories}\n\n` +
      `Pages:\n${list}\n\n` +
      `Return JSON exactly in this shape:\n` +
      `{\n` +
      `  "items": [\n` +
      `    { "idx": 0, "category": "<one-of-categories>", "confidence": 0.0-1.0, "reason": "<≤80 chars>" }\n` +
      `  ]\n` +
      `}\n` +
      `Output ONLY the JSON.`
    );
  }
}

// ── Pure helpers (exported for tests) ────────────────────────────────────────

/** Heuristic classification — URL path tokens + content-type + meta. */
export function heuristicCategory(input: {
  url: string;
  contentType: string | null;
  title: string | null;
  description: string | null;
  html: string;
}): SiteUrlCategory {
  const path = safePath(input.url).toLowerCase();
  const host = safeHost(input.url).toLowerCase();
  const ct = (input.contentType ?? '').toLowerCase();
  const filename = path.split('/').filter(Boolean).pop() ?? '';

  // API host pattern: api.example.com, *.supabase.co, *.firebaseio.com, etc.
  if (/^api\./.test(host) || /\.(supabase|firebaseio|firebasedatabase|hasura|xano)\./.test(host)) {
    return 'api';
  }
  // API path pattern: anchored to the start so /docs/api stays a doc.
  if (/^\/(api|rest|graphql|v[1-9])(\/|$)/.test(path)) {
    return 'api';
  }
  // JSON content-type with no HTML wrapper → almost certainly an API.
  if (ct.includes('application/json') && !input.html) {
    return 'api';
  }

  // Attachment via content-type or extension.
  if (
    /\.(pdf|docx?|xlsx?|pptx?|csv|zip|tar|gz|7z|rtf)$/.test(filename) ||
    /(application\/pdf|application\/msword|application\/vnd\.openxml|application\/zip)/.test(ct)
  ) {
    return 'attachment';
  }

  // Media via extension or content-type.
  if (
    /\.(png|jpe?g|gif|webp|svg|mp4|mov|avi|webm|mp3|wav|ogg|m4a)$/.test(filename) ||
    /^(image|video|audio)\//.test(ct)
  ) {
    return 'media';
  }

  // Path-token rules — first match wins.
  for (const [cat, patterns] of HEURISTIC_PATTERNS) {
    if (patterns.some((re) => re.test(path))) return cat;
  }

  // Form detection (HTML-only): fall back to body inspection if URL was
  // ambiguous. Cheap regex match, no DOM parser needed.
  if (input.html && /<form\b/i.test(input.html)) {
    return 'form';
  }

  // Title hints — last-ditch text match.
  const text = `${input.title ?? ''} ${input.description ?? ''}`.toLowerCase();
  if (/\b(blog|news|article|post)\b/.test(text)) return 'blog';
  if (/\b(product|sku|catalog)\b/.test(text)) return 'product';
  if (/\b(shop|cart|checkout)\b/.test(text)) return 'ecommerce';

  return 'cms'; // generic page is the safest default for HTML
}

/** Path-token → category, evaluated top-down. Earlier rules win.
 *
 *  Members is checked BEFORE form because /signup, /signin, /register
 *  are auth-flow pages — for VAPT scoping they're members-area scope
 *  (auth attack surface) rather than the contact-form sense. /contact
 *  + /lead + /survey are still genuine forms and stay in `form`.
 */
const HEURISTIC_PATTERNS: Array<[SiteUrlCategory, RegExp[]]> = [
  ['ecommerce',      [/\/(shop|store|cart|checkout|basket|order(s)?|payment)(\/|$)/]],
  ['product',        [/\/(product(s)?|catalog(ue)?|item(s)?|sku)(\/|$)/]],
  ['blog',           [/\/(blog|news|articles?|posts?|stories|insights?)(\/|$)/]],
  ['knowledge_base', [/\/(kb|knowledge|docs?|documentation|help|support|faq)(\/|$)/]],
  ['members',        [/\/(members?|portal|account|profile|dashboard|auth|login|signin|sign-in|signup|sign-up|register)(\/|\?|$)/]],
  ['form',           [/\/(contact|lead|subscribe|survey|feedback)(\/|$)/]],
  ['module',         [/\/(crm|inventory|accounting|hr|erp|module|app)(\/|$)/]],
  ['cms',            [/\/(about|company|team|services?|pricing|legal|privacy|terms|page(s)?)(\/|$)/]],
];

function safePath(url: string): string {
  try {
    return new URL(url).pathname || '/';
  } catch {
    return '/';
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/** Parse the LLM batch response. Tolerant — strips markdown fences,
 *  finds the JSON island, validates each entry. Returns one
 *  ClassifiedPage per matched idx; missing entries are silently dropped
 *  so the caller's heuristic fallback fills them in. */
export function parseLlmBatchResponse(
  raw: string,
  batch: DiscoveredPage[],
  heuristicByUrl: Map<string, ClassifiedPage>,
): ClassifiedPage[] {
  if (!raw) return [];
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('llm_response_not_json');
    }
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const validCats = new Set<string>(SITE_URL_CATEGORIES);
  const out: ClassifiedPage[] = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const item = it as Record<string, unknown>;
    const idx = Number(item.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= batch.length) continue;
    const category = typeof item.category === 'string' ? item.category : '';
    if (!validCats.has(category)) continue;
    const confidenceRaw = Number(item.confidence);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw))
      : 0.7;
    const page = batch[idx]!;
    const heuristic = heuristicByUrl.get(page.url);
    out.push({
      url: page.url,
      title: page.title,
      description: page.description,
      httpStatus: page.httpStatus,
      contentType: page.contentType,
      category: category as SiteUrlCategory,
      confidence,
      source: 'llm',
      // If the LLM AGREES with the heuristic, bump confidence; this
      // helps downstream quote logic that gates on confidence.
      ...(heuristic && heuristic.category === category
        ? { confidence: Math.max(confidence, 0.85) }
        : {}),
    });
  }
  return out;
}
