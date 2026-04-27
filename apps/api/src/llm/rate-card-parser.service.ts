/**
 * LLM-based rate-card parser — alternative to the structural parser
 * for tenants whose XLSX doesn't match the CSaaS layout.
 *
 * Same auto/manual split as quote-justification + template-gen:
 *   - API-backed providers: feed the matrix + schema to the LLM, parse
 *     its JSON, save as a draft rate card.
 *   - manual: return the prompt, let the admin paste it into ChatGPT /
 *     Claude / Gemini, then POST the response back to be parsed.
 *
 * The LLM is asked for a JSON object matching CreateRateCardInput.
 * Validation is lenient on the AI's quirks (markdown fences, smart
 * quotes, leading prose) but strict on the canonical schema — anything
 * that doesn't match the ScopeUnit / CustomerType enums is dropped
 * with a warning rather than blowing up the whole save.
 */

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CUSTOMER_TYPES,
  PRICING_MODELS,
  SCOPE_UNITS,
  type CustomerType,
  type Methodology,
  type PricingModel,
  type ScopeUnit,
} from '@rhud/shared';
import {
  PricingService,
  type CreateRateCardInput,
} from '../pricing/pricing.service.js';
import { LlmService } from './llm.service.js';
import type { ChatMessage } from './llm.types.js';

export type RateCardAiParseResult =
  | {
      mode: 'auto';
      rateCardId: string;
      draftName: string;
      provider: string;
      model?: string | undefined;
      coverage: { serviceLines: number; tiers: number; openPriced: number };
      warnings: string[];
    }
  | { mode: 'manual'; prompt: string };

interface GenerateInput {
  matrix: string[][];
  name?: string | undefined;
}

@Injectable()
export class RateCardLlmParserService {
  private readonly logger = new Logger(RateCardLlmParserService.name);

  constructor(
    private readonly llm: LlmService,
    private readonly pricing: PricingService,
  ) {}

  async parse(tenantId: string, input: GenerateInput): Promise<RateCardAiParseResult> {
    if (!input.matrix || input.matrix.length === 0) {
      throw new BadRequestException('matrix_empty');
    }

    const messages = this.buildMessages(input);

    const provider = await this.llm.getProviderName(tenantId);
    if (!provider) throw new ServiceUnavailableException('ai_not_configured');

    if (provider === 'manual') {
      return { mode: 'manual', prompt: this.flattenForClipboard(messages) };
    }

    let result;
    try {
      result = await this.llm.chat(tenantId, messages, {
        // Rate cards can have many service lines × many tiers — give the
        // model room. 4k tokens of output is enough for the CSaaS sample.
        maxTokens: 4_000,
        temperature: 0.1, // strict structure, low creativity
        timeoutMs: 90_000,
      });
    } catch (e) {
      throw new BadGatewayException(`ai_provider_error: ${(e as Error).message}`);
    }

    const { draft, warnings } = this.parseAndValidate(result.text, input.name);
    const card = await this.pricing.create(tenantId, draft);

    return {
      mode: 'auto',
      rateCardId: card.id,
      draftName: draft.name,
      provider,
      ...(result.model && { model: result.model }),
      coverage: {
        serviceLines: draft.serviceLines.length,
        tiers: draft.serviceLines.reduce((n, sl) => n + sl.tiers.length, 0),
        openPriced: draft.openPricedServices?.length ?? 0,
      },
      warnings,
    };
  }

  /** Manual path — admin pastes the AI's response, we parse + save. */
  async parseManualAndSave(
    tenantId: string,
    rawText: string,
    opts: { name?: string | undefined } = {},
  ): Promise<{ rateCardId: string; draftName: string; coverage: { serviceLines: number; tiers: number; openPriced: number }; warnings: string[] }> {
    const { draft, warnings } = this.parseAndValidate(rawText, opts.name);
    const card = await this.pricing.create(tenantId, draft);
    return {
      rateCardId: card.id,
      draftName: draft.name,
      coverage: {
        serviceLines: draft.serviceLines.length,
        tiers: draft.serviceLines.reduce((n, sl) => n + sl.tiers.length, 0),
        openPriced: draft.openPricedServices?.length ?? 0,
      },
      warnings,
    };
  }

  // ── Prompt ──────────────────────────────────────────────────────────────

  private buildMessages(input: GenerateInput): ChatMessage[] {
    const matrixForPrompt = this.matrixToText(input.matrix);

    const system =
      'You convert messy rate-card spreadsheets into a strict JSON structure for a B2B services pricing engine. ' +
      'You ONLY output JSON — no markdown fences, no commentary.\n\n' +
      'Output schema (CreateRateCardInput):\n' +
      '{\n' +
      '  "name": string,                   // a short human-readable name for this rate card\n' +
      '  "currency": string,               // ISO 4217 ("INR", "USD"). Default "INR" if unclear.\n' +
      '  "serviceLines": [{\n' +
      '    "slug": string,                 // snake_case stable id, e.g. "vapt_web_app"\n' +
      '    "displayName": string,\n' +
      `    "scopeUnit": ${JSON.stringify([...SCOPE_UNITS])},\n` +
      `    "pricingModel": ${JSON.stringify([...PRICING_MODELS])} | undefined,  // default "tier_lookup"\n` +
      '    "position": number,             // ordering hint, 0+\n' +
      '    "tiers": [{\n' +
      '      "rangeMin": number,           // inclusive\n' +
      '      "rangeMax": number | null,    // inclusive; null = open-ended\n' +
      '      "methodology": string | null, // e.g. "Grey Box", "VA", "PT"; null if not split\n' +
      `      "customerType": ${JSON.stringify([...CUSTOMER_TYPES])},\n` +
      '      "priceCents": number,         // ALWAYS in minor units (paise / cents). 50000 INR = 5000000.\n' +
      '      "displayLabel": string | null // optional row label preserved from the sheet\n' +
      '    }]\n' +
      '  }],\n' +
      '  "openPricedServices": [{          // case-by-case items with no standard price (compliance, audits, etc.)\n' +
      '    "slug": string,\n' +
      '    "displayName": string,\n' +
      '    "category": string | null\n' +
      '  }]\n' +
      '}\n\n' +
      'Rules:\n' +
      '- ALL prices are in MINOR units (paise for INR, cents for USD). Multiply spreadsheet figures by 100.\n' +
      '- Tier ranges: parse "0-30", "Up to 50", "200 & Above", "1000+" etc. into rangeMin/rangeMax.\n' +
      '- Detect methodology splits (Grey Box / Black Box, VA / PT) and emit one tier row per (range × methodology × customerType).\n' +
      '- If the same range exists for both internal and external prices, emit two tiers — one per customerType.\n' +
      '- Use scope unit "pages" for page-counted services, "screens" for UI flows, "apis" for API counts, "devices" for hosts/IPs, "loc" for lines of code, "hours" for hourly engagements, "other" if none fit.\n' +
      '- A row with a service name but no prices belongs in openPricedServices.\n' +
      '- Be strict: drop garbage rows rather than guess prices.\n' +
      '- Do not include markdown code fences in your reply.';

    const user =
      `Here is the spreadsheet as a tab-separated grid (one row per line, columns delimited by \\t).` +
      (input.name ? ` Suggested name: "${input.name}".` : '') +
      `\n\n${matrixForPrompt}\n\nProduce the JSON now.`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private matrixToText(matrix: string[][]): string {
    // Drop fully-blank rows for prompt compactness — they don't help
    // the model and they cost tokens.
    return matrix
      .map((row) => row.map((c) => (c ?? '').trim()).join('\t'))
      .filter((line) => line.replace(/\t/g, '').trim() !== '')
      .join('\n');
  }

  private flattenForClipboard(messages: ChatMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const usr = messages.find((m) => m.role === 'user')?.content ?? '';
    return `=== Instructions ===\n${sys}\n\n=== Task ===\n${usr}\n`;
  }

  // ── Parse + validate LLM JSON ──────────────────────────────────────────

  private parseAndValidate(
    raw: string,
    nameHint?: string,
  ): { draft: CreateRateCardInput; warnings: string[] } {
    if (!raw || !raw.trim()) {
      throw new BadRequestException('llm_returned_empty_response');
    }

    let text = raw.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'");

    // Pull out the outermost JSON object. The LLM sometimes prepends
    // "Here's the rate card:".
    const objStart = text.indexOf('{');
    const objEnd = text.lastIndexOf('}');
    if (objStart === -1 || objEnd === -1 || objEnd < objStart) {
      throw new BadRequestException('llm_response_not_json_object');
    }
    const jsonPart = text.slice(objStart, objEnd + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPart);
    } catch (e) {
      this.logger.warn(`rate-card LLM JSON parse failed: ${(e as Error).message}`);
      throw new BadRequestException('llm_response_invalid_json');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new BadRequestException('llm_response_not_object');
    }

    const root = parsed as Record<string, unknown>;
    const warnings: string[] = [];

    const name =
      (typeof root.name === 'string' && root.name.trim()) ||
      nameHint?.trim() ||
      'Imported rate card';
    const currency =
      typeof root.currency === 'string' && /^[A-Z]{3}$/.test(root.currency.trim())
        ? root.currency.trim()
        : 'INR';

    const rawServiceLines = Array.isArray(root.serviceLines) ? root.serviceLines : [];
    const serviceLines: CreateRateCardInput['serviceLines'] = [];
    for (let i = 0; i < rawServiceLines.length; i++) {
      const sl = this.coerceServiceLine(rawServiceLines[i], i, warnings);
      if (sl) serviceLines.push(sl);
    }

    const rawOpen = Array.isArray(root.openPricedServices) ? root.openPricedServices : [];
    const openPricedServices: NonNullable<CreateRateCardInput['openPricedServices']> = [];
    for (const op of rawOpen) {
      if (!op || typeof op !== 'object') continue;
      const o = op as Record<string, unknown>;
      const displayName = typeof o.displayName === 'string' ? o.displayName.trim() : '';
      if (!displayName) continue;
      const slug = (typeof o.slug === 'string' && o.slug.trim()) || this.slug(displayName);
      openPricedServices.push({
        slug,
        displayName,
        category: typeof o.category === 'string' ? o.category.trim() : null,
      });
    }

    if (serviceLines.length === 0 && openPricedServices.length === 0) {
      throw new BadRequestException('llm_response_no_usable_content');
    }

    const draft: CreateRateCardInput = {
      name,
      currency,
      serviceLines,
      openPricedServices,
    };
    return { draft, warnings };
  }

  private coerceServiceLine(
    raw: unknown,
    idx: number,
    warnings: string[],
  ): CreateRateCardInput['serviceLines'][number] | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const displayName = typeof r.displayName === 'string' ? r.displayName.trim() : '';
    if (!displayName) {
      warnings.push(`Service line at index ${idx}: missing displayName, dropped.`);
      return null;
    }
    const slug = (typeof r.slug === 'string' && r.slug.trim()) || this.slug(displayName);

    const scopeUnitRaw = typeof r.scopeUnit === 'string' ? r.scopeUnit.trim() : '';
    const scopeUnit: ScopeUnit = (SCOPE_UNITS as readonly string[]).includes(scopeUnitRaw)
      ? (scopeUnitRaw as ScopeUnit)
      : 'other';
    if (scopeUnit === 'other' && scopeUnitRaw !== 'other' && scopeUnitRaw !== '') {
      warnings.push(`Service line "${displayName}": unknown scopeUnit "${scopeUnitRaw}", defaulted to "other".`);
    }

    const pricingModelRaw = typeof r.pricingModel === 'string' ? r.pricingModel.trim() : '';
    const pricingModel: PricingModel = (PRICING_MODELS as readonly string[]).includes(pricingModelRaw)
      ? (pricingModelRaw as PricingModel)
      : 'tier_lookup';

    const position = typeof r.position === 'number' ? r.position : idx;

    const rawTiers = Array.isArray(r.tiers) ? r.tiers : [];
    const tiers: NonNullable<CreateRateCardInput['serviceLines'][number]['tiers']> = [];
    for (let j = 0; j < rawTiers.length; j++) {
      const tier = this.coerceTier(rawTiers[j], displayName, j, warnings);
      if (tier) tiers.push(tier);
    }

    if (tiers.length === 0) {
      warnings.push(`Service line "${displayName}": no valid tiers, dropped.`);
      return null;
    }

    return {
      slug,
      displayName,
      scopeUnit,
      pricingModel,
      position,
      tiers,
    };
  }

  private coerceTier(
    raw: unknown,
    serviceLineName: string,
    idx: number,
    warnings: string[],
  ): NonNullable<CreateRateCardInput['serviceLines'][number]['tiers']>[number] | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const rangeMin = this.coerceInt(r.rangeMin);
    if (rangeMin == null) {
      warnings.push(`"${serviceLineName}" tier ${idx}: missing/invalid rangeMin, dropped.`);
      return null;
    }
    const rangeMax = r.rangeMax === null ? null : this.coerceInt(r.rangeMax);
    if (rangeMax !== null && rangeMax == null) {
      warnings.push(`"${serviceLineName}" tier ${idx}: invalid rangeMax, dropped.`);
      return null;
    }

    const customerTypeRaw = typeof r.customerType === 'string' ? r.customerType.trim() : '';
    if (!(CUSTOMER_TYPES as readonly string[]).includes(customerTypeRaw)) {
      warnings.push(`"${serviceLineName}" tier ${idx}: invalid customerType "${customerTypeRaw}", dropped.`);
      return null;
    }
    const customerType = customerTypeRaw as CustomerType;

    const priceCents = this.coerceInt(r.priceCents);
    if (priceCents == null || priceCents < 0) {
      warnings.push(`"${serviceLineName}" tier ${idx}: missing/invalid priceCents, dropped.`);
      return null;
    }

    const methodologyRaw = r.methodology;
    const methodology: Methodology =
      typeof methodologyRaw === 'string' && methodologyRaw.trim().length > 0
        ? methodologyRaw.trim()
        : null;

    const displayLabelRaw = r.displayLabel;
    const displayLabel: string | null =
      typeof displayLabelRaw === 'string' && displayLabelRaw.trim().length > 0
        ? displayLabelRaw.trim()
        : null;

    return {
      rangeMin,
      rangeMax: rangeMax ?? null,
      methodology,
      customerType,
      priceCents,
      displayLabel,
    };
  }

  private coerceInt(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') {
      const n = Number(v.replace(/[, _]/g, ''));
      if (Number.isFinite(n)) return Math.trunc(n);
    }
    return null;
  }

  private slug(s: string): string {
    return (
      s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 60) || 'item'
    );
  }
}
