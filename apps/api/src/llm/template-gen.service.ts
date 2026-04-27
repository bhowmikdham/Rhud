/**
 * Template-from-description — second user-facing LLM feature.
 *
 * Admin types "I run cyber assessments for fintech clients" and gets a
 * starter decision-tree template back. Same auto/manual split as quote
 * justification: API-backed providers go through llm.chat(); manual
 * provider returns the prompt for the user to ferry to ChatGPT et al.
 *
 * The LLM is asked for STRICT JSON. Manual responses are parsed
 * leniently (strips ```json fences and stray prose) so the user doesn't
 * have to clean the AI's output by hand.
 */

import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { NODE_TYPES, type NodeType } from '@rhud/shared';
import { LlmService } from './llm.service.js';
import type { ChatMessage } from './llm.types.js';

const ANSWER_TYPES: NodeType[] = ['short_text', 'long_text', 'number', 'single_select', 'multi_select', 'file_upload'];

export interface GeneratedNode {
  question: string;
  nodeType: NodeType;
  helpText?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
}

export type TemplateGenResult =
  | { mode: 'auto'; nodes: GeneratedNode[]; provider: string; model?: string | undefined }
  | { mode: 'manual'; prompt: string };

interface GenerateInput {
  description: string;
  serviceLine?: string | undefined;
}

@Injectable()
export class TemplateGenService {
  private readonly logger = new Logger(TemplateGenService.name);

  constructor(private readonly llm: LlmService) {}

  async generate(tenantId: string, input: GenerateInput): Promise<TemplateGenResult> {
    if (!input.description.trim()) {
      throw new BadRequestException('description_required');
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
        maxTokens: 2_000,
        temperature: 0.4,
        timeoutMs: 60_000,
      });
    } catch (e) {
      throw new BadGatewayException(`ai_provider_error: ${(e as Error).message}`);
    }

    const nodes = this.parseAndValidate(result.text);
    return { mode: 'auto', nodes, provider, ...(result.model && { model: result.model }) };
  }

  /** Manual mode — accept whatever the user pasted from ChatGPT/Claude
   *  and run it through the same parser. Returns a clean node list or
   *  throws BadRequestException with a friendly hint. */
  parseManual(text: string): { nodes: GeneratedNode[] } {
    return { nodes: this.parseAndValidate(text) };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private buildMessages(input: GenerateInput): ChatMessage[] {
    const system =
      'You design intake questionnaires for B2B services consultancies. ' +
      'Given a short description of what the consultancy sells, you produce a JSON array of nodes ' +
      'matching this exact shape:\n' +
      '  [{ "question": string, "nodeType": "section"|"short_text"|"long_text"|"number"|"single_select"|"multi_select"|"file_upload", ' +
      '"helpText"?: string, "required"?: boolean, "options"?: [{"value": string, "label": string}] }]\n' +
      'Rules:\n' +
      '- Output ONLY the JSON array. No prose, no markdown fences.\n' +
      '- Use "section" nodes to group related questions ("Engagement details", "Current posture", etc.).\n' +
      '- 8 to 15 nodes total. Don\'t over-question.\n' +
      '- Use "single_select" / "multi_select" for closed questions; provide options.\n' +
      '- "value" is a short snake_case slug; "label" is the display text.\n' +
      '- Use "number" for sizes/counts/budgets.\n' +
      '- Use "file_upload" sparingly (typically for a single optional doc).\n' +
      '- Mark questions required only when truly necessary to scope the work.';

    const user =
      `Consultancy description: ${input.description.trim()}\n` +
      (input.serviceLine ? `Service line tag: ${input.serviceLine.trim()}\n` : '') +
      `\nProduce the questionnaire JSON now.`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  /** Robust JSON-out-of-AI-text parser. Handles:
   *   - leading prose ("Sure, here's the JSON:")
   *   - ```json … ``` fences
   *   - trailing commentary
   *   - smart quotes (LLMs occasionally swap " for ")
   * Validates each node against the NodeType enum and drops malformed entries.
   */
  private parseAndValidate(raw: string): GeneratedNode[] {
    if (!raw || !raw.trim()) {
      throw new BadRequestException('llm_returned_empty_response');
    }

    // Strip ```json fences and ``` fences
    let text = raw.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    // Smart quotes → straight quotes (only outside any obvious string content)
    text = text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

    // Pull out the first JSON array we can find. The LLM sometimes adds
    // a leading "Here's the questionnaire:" line.
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    if (arrayStart === -1 || arrayEnd === -1 || arrayEnd < arrayStart) {
      throw new BadRequestException('llm_response_not_json_array');
    }
    const jsonPart = text.slice(arrayStart, arrayEnd + 1);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonPart);
    } catch (e) {
      this.logger.warn(`template-gen JSON parse failed: ${(e as Error).message}`);
      throw new BadRequestException('llm_response_invalid_json');
    }
    if (!Array.isArray(parsed)) throw new BadRequestException('llm_response_not_array');

    const nodes: GeneratedNode[] = [];
    for (const raw of parsed) {
      const node = this.coerceNode(raw);
      if (node) nodes.push(node);
    }
    if (nodes.length === 0) throw new BadRequestException('llm_response_no_valid_nodes');
    return nodes;
  }

  private coerceNode(raw: unknown): GeneratedNode | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const question = typeof r.question === 'string' ? r.question.trim() : '';
    if (!question) return null;

    const nodeType = typeof r.nodeType === 'string' ? r.nodeType.trim() : '';
    if (!(NODE_TYPES as readonly string[]).includes(nodeType)) return null;
    // We don't accept 'loop' from the LLM — too easy to mis-structure, and
    // loops need a body that the JSON shape can't express. Admins can add
    // loops in the visual editor.
    if (nodeType === 'loop') return null;

    const node: GeneratedNode = { question, nodeType: nodeType as NodeType };
    if (typeof r.helpText === 'string' && r.helpText.trim()) node.helpText = r.helpText.trim();
    if (typeof r.required === 'boolean') node.required = r.required;

    if ((nodeType === 'single_select' || nodeType === 'multi_select') && Array.isArray(r.options)) {
      const options: Array<{ value: string; label: string }> = [];
      for (const opt of r.options) {
        if (!opt || typeof opt !== 'object') continue;
        const o = opt as Record<string, unknown>;
        const label = typeof o.label === 'string' ? o.label.trim() : '';
        if (!label) continue;
        let value = typeof o.value === 'string' ? o.value.trim() : '';
        if (!value) value = this.slug(label);
        options.push({ value, label });
      }
      if (options.length > 0) node.options = options;
    }

    // Section nodes don't capture answers; required is meaningless.
    if (!ANSWER_TYPES.includes(nodeType as NodeType)) {
      delete node.required;
    }
    return node;
  }

  private slug(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'opt';
  }

  private flattenForClipboard(messages: ChatMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const usr = messages.find((m) => m.role === 'user')?.content ?? '';
    return `=== Instructions ===\n${sys}\n\n=== Task ===\n${usr}\n`;
  }
}
