/**
 * Rate-card inference ontology synthesiser.
 *
 * The Layer-3 mapper composes its prompt from the rate card's
 * `inferenceContext` + per-slug `inferenceHint`. For Prophaze we
 * authored those by hand. For ANY new rate card a tenant uploads,
 * those fields would otherwise be empty — and `synthesizeDefaultHint`
 * (in rate-card-mapper.service) produces only a generic "emit when
 * the doc evidences {displayName} with a count of {scopeUnit}" line
 * that misses the domain-specific reasoning we get from authored hints.
 *
 * This service runs ONCE per rate-card creation. It calls the LLM with
 * the structural rate-card info (name + slugs + scope_units +
 * methodologies) and asks for the inference ontology in JSON. Result
 * is persisted directly into rate_cards / rate_card_service_lines.
 *
 * Failure handling: if the LLM is unavailable or returns malformed
 * output, the rate-card creation still succeeds — the slugs just
 * land with `inferenceHint=null` and the mapper falls back to the
 * generic synthesiser at runtime. Tenants can hit the
 * `regenerateHints` admin action later when the LLM is reachable.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import type { RateCard, ScopeUnit } from '@rhud/shared';
import { LlmService } from '../llm/llm.service.js';
import type { ChatMessage } from '../llm/llm.types.js';

export interface SynthesisedOntology {
  inferenceContext: string;
  defaultMethodologyRule: string;
  inferenceExamples: string[];
  /** slug → "emit when …" hint */
  hints: Map<string, string>;
}

/** Minimal shape the synthesiser needs from a rate card — pre-persist
 *  callers (parseAndSave) pass the draft input; post-persist callers
 *  (regenerate) pass the loaded RateCard. Both shapes share these
 *  fields, so the service accepts either via this interface. */
export interface SynthesiserInput {
  name: string;
  serviceLines: ReadonlyArray<{
    slug: string;
    displayName: string;
    scopeUnit: ScopeUnit;
    /** Distinct methodologies present in this slug's tiers. Empty array
     *  for single-axis slugs (no methodology dimension). */
    methodologies: string[];
  }>;
}

@Injectable()
export class RateCardHintSynthesizerService {
  private readonly logger = new Logger(RateCardHintSynthesizerService.name);

  // LlmService is optional so the service can be constructed in test
  // contexts where the LLM module isn't wired. Real usage always has
  // it injected via the module.
  constructor(@Optional() private readonly llm?: LlmService) {}

  /**
   * Run the ontology synthesis. Returns null when the LLM is
   * unavailable or the response can't be parsed — callers should
   * persist the rate card without hints in that case and surface a
   * "regenerate hints" affordance to the admin.
   *
   * `tenantId` is forwarded to LlmService.chat so the right provider
   * config is picked up. Pass the same tenant the rate card belongs to.
   */
  async synthesize(tenantId: string, input: SynthesiserInput): Promise<SynthesisedOntology | null> {
    if (!this.llm) {
      this.logger.warn('LlmService not injected — skipping hint synthesis');
      return null;
    }
    const provider = await this.llm.getProviderName(tenantId).catch(() => null);
    if (!provider || provider === 'manual') {
      this.logger.warn(
        `Tenant ${tenantId} has no LLM provider configured — skipping hint synthesis ` +
          `for rate card "${input.name}". Slugs will fall back to synthesizeDefaultHint at mapper time.`,
      );
      return null;
    }
    if (input.serviceLines.length === 0) return null;

    try {
      const messages = this.buildMessages(input);
      const result = await this.llm.chat(tenantId, messages, {
        maxTokens: 4_000,
        temperature: 0.2,  // a touch above 0 — hints benefit from minor variation
        timeoutMs: 90_000,
      });
      return this.parseResponse(result.text, input);
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(
        `Hint synthesis failed for rate card "${input.name}": ${msg}. ` +
          `Slugs will use synthesizeDefaultHint fallback at mapper time.`,
      );
      return null;
    }
  }

  private buildMessages(input: SynthesiserInput): ChatMessage[] {
    const slugLines = input.serviceLines
      .map(
        (sl) =>
          `- slug=${sl.slug} | displayName="${sl.displayName}" | scope_unit=${sl.scopeUnit}` +
          ` | methodologies=[${sl.methodologies.join(',')}]`,
      )
      .join('\n');

    return [
      {
        role: 'system',
        content: SYNTHESIS_SYSTEM_KERNEL,
      },
      {
        role: 'user',
        content:
          `RATE CARD NAME: ${input.name}\n\n` +
          `SERVICE LINES:\n${slugLines}\n\n` +
          `Generate the inference ontology for this rate card. ` +
          `Output strict JSON matching the schema in the system prompt.`,
      },
    ];
  }

  private parseResponse(raw: string, input: SynthesiserInput): SynthesisedOntology | null {
    if (!raw) {
      this.logger.warn('Synthesiser LLM returned empty response');
      return null;
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
          `Synthesiser response unparseable (no JSON object found): ` +
            `${(firstErr as Error).message}; raw[0..200]="${cleaned.slice(0, 200)}"`,
        );
        return null;
      }
      try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
      } catch (secondErr) {
        this.logger.warn(
          `Synthesiser response unparseable even after substring extraction: ` +
            `${(secondErr as Error).message}`,
        );
        return null;
      }
    }

    const obj = parsed as Record<string, unknown>;
    const inferenceContext = typeof obj.inferenceContext === 'string' ? obj.inferenceContext.trim() : '';
    const defaultMethodologyRule =
      typeof obj.defaultMethodologyRule === 'string' ? obj.defaultMethodologyRule.trim() : '';
    const examplesRaw = obj.inferenceExamples;
    const inferenceExamples = Array.isArray(examplesRaw)
      ? examplesRaw.filter((e): e is string => typeof e === 'string' && e.trim().length > 0).slice(0, 5)
      : [];

    const hintsRaw = obj.hints;
    const hints = new Map<string, string>();
    if (hintsRaw && typeof hintsRaw === 'object' && !Array.isArray(hintsRaw)) {
      const validSlugs = new Set(input.serviceLines.map((s) => s.slug));
      for (const [slug, hint] of Object.entries(hintsRaw as Record<string, unknown>)) {
        if (!validSlugs.has(slug)) continue;
        if (typeof hint !== 'string') continue;
        const trimmed = hint.trim();
        if (trimmed.length === 0) continue;
        hints.set(slug, trimmed.slice(0, 600));
      }
    }

    if (inferenceContext.length === 0 && hints.size === 0) {
      this.logger.warn(
        `Synthesiser returned an empty ontology (no context, no hints) for "${input.name}"`,
      );
      return null;
    }

    this.logger.log(
      `Synthesised ontology for "${input.name}": ${hints.size}/${input.serviceLines.length} slugs covered, ` +
        `${inferenceExamples.length} worked examples`,
    );
    return { inferenceContext, defaultMethodologyRule, inferenceExamples, hints };
  }
}

const SYNTHESIS_SYSTEM_KERNEL = [
  'You are an expert at writing inference rules for B2B pricing engines.',
  'A pricing engine is being onboarded for a new tenant. The tenant has',
  'a RATE CARD that lists priceable service lines. Your job is to write',
  'the natural-language inference ontology that downstream Layer-3',
  'mapper LLMs will use to decide which service lines apply when reading',
  'a client document.',
  '',
  'You are domain-agnostic. The rate card may be for cybersecurity,',
  'cleaning services, legal billing, consulting, or any other B2B vertical.',
  'INFER the domain from the rate card name and the service-line slugs +',
  'displayNames. Do not assume cybersec.',
  '',
  'OUTPUT — return strict JSON with these fields:',
  '',
  '{',
  '  "inferenceContext": "<1 paragraph (~80 words) framing the domain.',
  '    What kind of engagements does this rate card price? What does each',
  '    engagement typically cover? Are there multi-occurrence service',
  '    lines (e.g. multiple applications, multiple sites, multiple',
  '    employees) that need appId grouping?>",',
  '',
  '  "defaultMethodologyRule": "<1 paragraph (~60 words) describing how',
  '    customer types map to methodologies. Look at each service line\'s',
  '    methodologies array — if all are empty, say so. If methodologies',
  '    vary by customer type or by slug, describe the rule. Common patterns:',
  '    \'external customer → black_box, internal → grey_box; white-box opt-in\'.',
  '    If the rate card has no methodology axis at all, write \'No methodology',
  '    axis — leave methodology=null for every entity.\'>",',
  '',
  '  "inferenceExamples": [',
  '    "<1-3 short input/output examples specific to this rate card. Each',
  '    example shows what a real client document phrasing looks like and',
  '    what entities the LLM should emit. Use ACTUAL slugs from the rate',
  '    card. ~50-100 words each.>"',
  '  ],',
  '',
  '  "hints": {',
  '    "<exact slug from the rate card>": "<2-3 sentence inferenceHint',
  '      explaining (a) when to emit this slug — what textual evidence is',
  '      required, (b) when NOT to emit (negation patterns specific to this',
  '      slug like \'Not applicable\' / \'No\' / \'None\'), (c) how to count if',
  '      the scope_unit needs interpretation (comma-separated lists, URL',
  '      lists grouped by hostname, etc.). Be concrete — reference the slug\'s',
  '      displayName and likely doc phrasings.>"',
  '  }',
  '}',
  '',
  'RULES:',
  ' 1. Cover EVERY slug in the rate card under "hints". Missing slugs fall',
  '    back to a generic default at runtime — that is acceptable but worse.',
  ' 2. Hints must be self-contained — the mapper LLM will see only the hint',
  '    + the slug name + scope_unit + methodologies, not the full rate card.',
  ' 3. Use the EXACT slug strings — typos break the mapping.',
  ' 4. Do not write hints that reference internal implementation details',
  '    (e.g. database fields, cache keys). Hints are read by another LLM at',
  '    inference time and should be plain English.',
  ' 5. Output strict JSON. No preamble, no markdown fences.',
].join('\n');
