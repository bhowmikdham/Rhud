/**
 * Quote justification — first user-facing LLM feature.
 *
 * Given an engagement with a computed quote, produce a short business
 * rationale + draft sales email the rep can paste into a real email
 * client. Routing:
 *   - tenant has no llm_config              → 503 "ai_not_configured"
 *   - tenant has provider=manual            → return composed prompt;
 *                                              UI takes the user through
 *                                              the copy-paste flow
 *   - any other provider                    → call llm.chat() and return
 *                                              the generated text
 */

import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { LlmService } from './llm.service.js';
import type { ChatMessage } from './llm.types.js';

export type JustificationResult =
  | { mode: 'auto'; text: string; provider: string; model?: string | undefined }
  | { mode: 'manual'; prompt: string };

@Injectable()
export class JustificationService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly llm: LlmService,
  ) {}

  async generate(tenantId: string, engagementId: string): Promise<JustificationResult> {
    const ctx = await this.loadContext(tenantId, engagementId);
    const messages = this.buildMessages(ctx);

    const provider = await this.llm.getProviderName(tenantId);
    if (!provider) throw new ServiceUnavailableException('ai_not_configured');

    if (provider === 'manual') {
      return {
        mode: 'manual',
        prompt: this.flattenForClipboard(messages),
      };
    }

    let result;
    try {
      result = await this.llm.chat(tenantId, messages, {
        maxTokens: 600,
        temperature: 0.4,
        timeoutMs: 30_000,
      });
    } catch (e) {
      // Surface upstream provider failures (401, 404 model not found,
      // network/timeout, missing key) as a 502 with the underlying
      // message — far more useful than the generic 500 the client used
      // to see.
      throw new BadGatewayException(`ai_provider_error: ${(e as Error).message}`);
    }
    return {
      mode: 'auto',
      text: result.text,
      provider,
      ...(result.model && { model: result.model }),
    };
  }

  /** Manual-mode admin pastes the AI's response back; we just echo it
   *  back through a thin endpoint so the frontend has a place to land. */
  acceptManual(text: string): { text: string } {
    return { text: text.trim() };
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async loadContext(tenantId: string, engagementId: string) {
    return this.tenantDb.run(tenantId, async (db) => {
      const engagement = await db.engagement.findUnique({
        where: { id: engagementId },
        include: { template: { select: { name: true, serviceLine: true } } },
      });
      if (!engagement) throw new NotFoundException('engagement_not_found');

      const quote = await db.engagementQuote.findFirst({
        where: { engagementId },
        orderBy: { computedAt: 'desc' },
      });
      if (!quote) throw new NotFoundException('quote_not_found');

      // Pull the most-recent answers — the prompt benefits from knowing
      // the actual scope, not just the price.
      const answers = await db.engagementAnswer.findMany({
        where: { engagementId },
        orderBy: { answeredAt: 'asc' },
        take: 25,
      });
      const nodeIds = answers.map((a) => a.nodeId);
      const nodes = nodeIds.length
        ? await db.templateNode.findMany({
            where: { id: { in: nodeIds } },
            select: { id: true, question: true },
          })
        : [];
      const questionByNodeId = new Map(nodes.map((n) => [n.id, n.question]));

      return {
        clientEmail: engagement.clientEmail,
        opportunityName: engagement.name,
        templateName: engagement.template.name,
        serviceLine: engagement.template.serviceLine,
        currency: quote.currency,
        baseTotalCents: Number(quote.baseTotalCents),
        approvedPriceCents:
          quote.approvedPriceCents != null ? Number(quote.approvedPriceCents) : null,
        baseBreakdown: quote.baseBreakdown as unknown as Array<{
          serviceLineName: string;
          scopeUnit: string;
          scopeValue: number;
          priceCents: number;
        }>,
        answers: answers.map((a) => ({
          question: questionByNodeId.get(a.nodeId) ?? '(unknown)',
          value: a.answer,
        })),
      };
    });
  }

  private buildMessages(ctx: Awaited<ReturnType<typeof this.loadContext>>): ChatMessage[] {
    const fmtMoney = (cents: number) =>
      `${ctx.currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    const lines = (ctx.baseBreakdown ?? [])
      .map(
        (l) =>
          `  • ${l.serviceLineName}: ${l.scopeValue} ${l.scopeUnit} → ${fmtMoney(l.priceCents)}`,
      )
      .join('\n');

    const answers = ctx.answers
      .slice(0, 12)
      .map((a) => `  • ${a.question}: ${this.summariseAnswer(a.value)}`)
      .join('\n');

    const finalPrice = ctx.approvedPriceCents ?? ctx.baseTotalCents;

    const system =
      'You write concise, business-grade quote justifications for a B2B services consultancy. ' +
      'Keep your output professional and confident, never apologetic. No bullet points unless asked. ' +
      'Output two clearly labelled sections: "Justification" (2-4 sentences explaining what drove the price) ' +
      'and "Draft email" (a short email the rep can send to the client, using "you" voice).';

    const user =
      `Compose a justification + draft email for the following quote.\n\n` +
      `Client: ${ctx.clientEmail}\n` +
      (ctx.opportunityName ? `Opportunity: ${ctx.opportunityName}\n` : '') +
      `Service line: ${ctx.serviceLine}\n` +
      `Template used: ${ctx.templateName}\n` +
      `Final price: ${fmtMoney(finalPrice)}\n` +
      (lines ? `\nPriced line items:\n${lines}\n` : '') +
      (answers ? `\nClient-confirmed scope:\n${answers}\n` : '') +
      `\nTone: clear, confident, no fluff. Don't quote the price more than once in the email.`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private summariseAnswer(value: unknown): string {
    if (value == null) return '—';
    if (typeof value === 'string') return value.length > 140 ? value.slice(0, 140) + '…' : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.slice(0, 5).map(String).join(', ');
    try {
      return JSON.stringify(value).slice(0, 140);
    } catch {
      return '(complex value)';
    }
  }

  /** Flatten system + user messages into a single block the user can
   *  paste into ChatGPT/Claude/Gemini in one go. */
  private flattenForClipboard(messages: ChatMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const usr = messages.find((m) => m.role === 'user')?.content ?? '';
    return (
      `=== Instructions ===\n${sys}\n\n=== Task ===\n${usr}\n`
    );
  }
}
