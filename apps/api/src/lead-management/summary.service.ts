/**
 * Lead summariser — a per-engagement digest that managers and reps
 * read FIRST when they open an opportunity. Pulls everything the team
 * needs to react quickly:
 *
 *   - Lifecycle status (issued / submitted / approved / sent / ...)
 *   - Pricing snapshot (predicted / approved / Odoo expected_revenue)
 *   - Open tickets + their priority
 *   - Pending follow-ups (overdue called out)
 *   - Recent thread events (last ~30)
 *   - Linked Odoo CRM lead snapshot when present
 *
 * Then asks the configured LLM to produce a JSON object with a
 * plain-English summary, a risk assessment, a list of suggested next
 * actions, and a recommended follow-up cadence in days. We persist
 * the result so the UI can render it instantly without round-tripping
 * to the LLM on every page load.
 *
 * Falls back to a manual-mode prompt the user copies into ChatGPT /
 * Claude / etc when the tenant chose `provider='manual'`.
 */

import {
  BadGatewayException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { LlmService } from '../llm/llm.service.js';
import type { ChatMessage } from '../llm/llm.types.js';
import type {
  AcceptManualSummaryInput,
  GenerateSummaryResult,
  LeadSummaryRow,
  SummaryNextAction,
  SummaryRiskLevel,
} from '@rhud/shared';
import { SUMMARY_RISK_LEVELS } from '@rhud/shared';

/** How long a cached summary is considered "fresh" before the UI nags
 *  to regenerate. */
const FRESHNESS_WINDOW_MS = 24 * 3600 * 1000;

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly llm: LlmService,
  ) {}

  async getCurrent(tenantId: string, engagementId: string): Promise<LeadSummaryRow | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      const row = await db.engagementSummary.findUnique({
        where: { engagementId },
      });
      if (!row) return null;
      return rowToDto(row);
    });
  }

  /**
   * Generate a fresh summary. Returns:
   *   - { mode: 'auto', summary } when the configured LLM is online
   *   - { mode: 'manual', prompt } when the tenant uses provider='manual',
   *     i.e. wants to paste the response back from another tool
   */
  async generate(
    tenantId: string,
    engagementId: string,
    actorUserId: string,
  ): Promise<GenerateSummaryResult> {
    const ctx = await this.loadContext(tenantId, engagementId);
    const messages = buildPromptMessages(ctx);

    const provider = await this.llm.getProviderName(tenantId);
    if (!provider) throw new ServiceUnavailableException('ai_not_configured');

    if (provider === 'manual') {
      return {
        mode: 'manual',
        prompt: flattenForClipboard(messages),
      };
    }

    let result;
    try {
      result = await this.llm.chat(tenantId, messages, {
        maxTokens: 800,
        temperature: 0.3,
        timeoutMs: 30_000,
      });
    } catch (e) {
      throw new BadGatewayException(`ai_provider_error: ${(e as Error).message}`);
    }

    const parsed = parseSummaryFromText(result.text);
    const summary = await this.persist(tenantId, engagementId, {
      summaryText: parsed.summary,
      riskLevel: parsed.risk,
      nextActions: parsed.actions,
      recommendedFollowUpDays: parsed.followUpDays,
      generatedBy: 'llm',
      model: result.model ? `${provider}:${result.model}` : provider,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      generatedByUserId: actorUserId,
    });
    return { mode: 'auto', summary };
  }

  /** Manual-mode follow-up: the user pastes the LLM's JSON response. */
  async acceptManual(
    tenantId: string,
    engagementId: string,
    input: AcceptManualSummaryInput,
    actorUserId: string,
  ): Promise<LeadSummaryRow> {
    const parsed = parseSummaryFromText(input.text);
    return this.persist(tenantId, engagementId, {
      summaryText: parsed.summary,
      riskLevel: parsed.risk,
      nextActions: parsed.actions,
      recommendedFollowUpDays: parsed.followUpDays,
      generatedBy: 'manual',
      model: null,
      inputTokens: null,
      outputTokens: null,
      generatedByUserId: actorUserId,
    });
  }

  /** Drop the cached summary so the next read returns null. */
  async clear(tenantId: string, engagementId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagementSummary.delete({ where: { engagementId } }).catch(() => undefined);
    });
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async persist(
    tenantId: string,
    engagementId: string,
    input: {
      summaryText: string;
      riskLevel: SummaryRiskLevel;
      nextActions: SummaryNextAction[];
      recommendedFollowUpDays: number | null;
      generatedBy: 'llm' | 'manual';
      model: string | null;
      inputTokens: number | null;
      outputTokens: number | null;
      generatedByUserId: string;
    },
  ): Promise<LeadSummaryRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagementSummary.upsert({
        where: { engagementId },
        create: {
          tenantId,
          engagementId,
          summaryText: input.summaryText,
          riskLevel: input.riskLevel,
          nextActions: input.nextActions as unknown as object,
          recommendedFollowUpDays: input.recommendedFollowUpDays,
          generatedBy: input.generatedBy,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          generatedByUserId: input.generatedByUserId,
          generatedAt: new Date(),
        },
        update: {
          summaryText: input.summaryText,
          riskLevel: input.riskLevel,
          nextActions: input.nextActions as unknown as object,
          recommendedFollowUpDays: input.recommendedFollowUpDays,
          generatedBy: input.generatedBy,
          model: input.model,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          generatedByUserId: input.generatedByUserId,
          generatedAt: new Date(),
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'summary_generated',
        actorType: 'user',
        actorId: input.generatedByUserId,
        payload: {
          generatedBy: input.generatedBy,
          riskLevel: input.riskLevel,
          recommendedFollowUpDays: input.recommendedFollowUpDays,
          ...(input.model ? { model: input.model } : {}),
        },
      });
      return rowToDto(row);
    });
  }

  /** Pull everything the LLM should look at to write a sharp summary. */
  private async loadContext(tenantId: string, engagementId: string): Promise<SummaryContext> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        include: {
          template: { select: { name: true, serviceLine: true } },
          quote: true,
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      const [tickets, followUps, threadEvents, odooLink] = await Promise.all([
        db.engagementTicket.findMany({
          where: { engagementId },
          orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          take: 50,
        }),
        db.engagementFollowUp.findMany({
          where: { engagementId },
          orderBy: { scheduledFor: 'asc' },
          take: 50,
        }),
        db.threadEvent.findMany({
          where: { engagementId },
          orderBy: { createdAt: 'desc' },
          take: 30,
        }),
        db.odooEntityLink.findFirst({
          where: { tenantId, rhudEntity: 'engagement', rhudId: engagementId, odooModel: 'crm.lead' },
          select: { odooId: true, cachedRecord: true, cachedAt: true, odooWriteDate: true },
        }),
      ]);

      return {
        engagementId,
        name: eng.name,
        clientEmail: eng.clientEmail,
        status: eng.status,
        templateName: eng.template?.name ?? null,
        serviceLine: eng.template?.serviceLine ?? null,
        importedFromOdoo: eng.importedFromOdoo,
        createdAt: eng.createdAt,
        submittedAt: eng.submittedAt,
        closedAt: eng.closedAt,
        predictedPriceCents: eng.predictedPriceCents == null ? null : Number(eng.predictedPriceCents),
        approvedPriceCents: eng.approvedPriceCents == null ? null : Number(eng.approvedPriceCents),
        priceLowCents: eng.priceLowCents == null ? null : Number(eng.priceLowCents),
        priceHighCents: eng.priceHighCents == null ? null : Number(eng.priceHighCents),
        quote: eng.quote
          ? {
              currency: eng.quote.currency,
              baseTotalCents: Number(eng.quote.baseTotalCents),
              approvedPriceCents: eng.quote.approvedPriceCents == null ? null : Number(eng.quote.approvedPriceCents),
            }
          : null,
        tickets: tickets.map((t) => ({
          id: t.id,
          category: t.category,
          priority: t.priority,
          status: t.status,
          title: t.title,
          description: t.description,
          createdAt: t.createdAt.toISOString(),
          resolvedAt: t.resolvedAt?.toISOString() ?? null,
        })),
        followUps: followUps.map((f) => ({
          id: f.id,
          scheduledFor: f.scheduledFor.toISOString(),
          reason: f.reason,
          completedAt: f.completedAt?.toISOString() ?? null,
        })),
        thread: threadEvents.reverse().map((e) => ({
          eventType: e.eventType,
          actorType: e.actorType,
          createdAt: e.createdAt.toISOString(),
          payload: e.payload,
        })),
        odoo: odooLink
          ? {
              odooId: odooLink.odooId,
              cachedAt: odooLink.cachedAt?.toISOString() ?? null,
              writeDate: odooLink.odooWriteDate?.toISOString() ?? null,
              snapshot: (odooLink.cachedRecord ?? null) as Record<string, unknown> | null,
            }
          : null,
      };
    });
  }
}

// ── Prompt assembly ────────────────────────────────────────────────────

interface SummaryContext {
  engagementId: string;
  name: string | null;
  clientEmail: string;
  status: string;
  templateName: string | null;
  serviceLine: string | null;
  importedFromOdoo: boolean;
  createdAt: Date;
  submittedAt: Date | null;
  closedAt: Date | null;
  predictedPriceCents: number | null;
  approvedPriceCents: number | null;
  priceLowCents: number | null;
  priceHighCents: number | null;
  quote: { currency: string; baseTotalCents: number; approvedPriceCents: number | null } | null;
  tickets: Array<{
    id: string;
    category: string;
    priority: string;
    status: string;
    title: string;
    description: string | null;
    createdAt: string;
    resolvedAt: string | null;
  }>;
  followUps: Array<{ id: string; scheduledFor: string; reason: string; completedAt: string | null }>;
  thread: Array<{ eventType: string; actorType: string; createdAt: string; payload: unknown }>;
  odoo: {
    odooId: number;
    cachedAt: string | null;
    writeDate: string | null;
    snapshot: Record<string, unknown> | null;
  } | null;
}

function buildPromptMessages(ctx: SummaryContext): ChatMessage[] {
  const system: ChatMessage = {
    role: 'system',
    content: [
      'You are an assistant for a sales team at a consulting firm.',
      'You produce concise, actionable lead-status briefings for managers and sales reps.',
      'Output a single JSON object — nothing else, no markdown fences. Schema:',
      '{',
      '  "summary": string,                 // 2-4 sentences, plain English. Lead status, what just happened, what is blocking.',
      '  "risk": "low" | "medium" | "high", // overall risk this lead stalls or is lost',
      '  "actions": [',
      '    { "title": string, "urgency": "low" | "medium" | "high", "owner": string | null }',
      '  ],',
      '  "follow_up_days": integer | null   // when the team should next touch the lead, in days from today',
      '}',
      '',
      'Risk heuristic:',
      '  - high  = open complaint, overdue follow-up, stalled > 14 days, stage regressed.',
      '  - medium = open question, follow-up due soon, predicted price unapproved > 7 days.',
      '  - low   = on track, no open tickets, recent activity.',
      '',
      'Be specific in the summary. Reference the actual client name, dollar figures, and ticket titles when present.',
      'Action titles must be short imperative phrases ("Call client to confirm scope"), not vague labels.',
      'When the engagement was imported from Odoo, weight Odoo stage_id and write_date.',
    ].join('\n'),
  };

  const userBody: Record<string, unknown> = {
    engagement: {
      name: ctx.name,
      client_email: ctx.clientEmail,
      status: ctx.status,
      template: ctx.templateName,
      service_line: ctx.serviceLine,
      imported_from_odoo: ctx.importedFromOdoo,
      created_at: ctx.createdAt.toISOString(),
      submitted_at: ctx.submittedAt?.toISOString() ?? null,
      closed_at: ctx.closedAt?.toISOString() ?? null,
    },
    pricing: {
      predicted_cents: ctx.predictedPriceCents,
      approved_cents: ctx.approvedPriceCents,
      band: { low_cents: ctx.priceLowCents, high_cents: ctx.priceHighCents },
      quote: ctx.quote,
    },
    open_tickets: ctx.tickets.filter((t) => t.status === 'open' || t.status === 'in_progress'),
    resolved_tickets_recent: ctx.tickets.filter((t) => t.status === 'resolved' || t.status === 'wont_fix').slice(0, 5),
    pending_follow_ups: ctx.followUps.filter((f) => !f.completedAt),
    recent_activity: ctx.thread,
  };
  if (ctx.odoo) {
    userBody.odoo = {
      odoo_id: ctx.odoo.odooId,
      write_date: ctx.odoo.writeDate,
      snapshot_age: ctx.odoo.cachedAt,
      record: ctx.odoo.snapshot,
    };
  }

  const today = new Date().toISOString().slice(0, 10);

  return [
    system,
    {
      role: 'user',
      content: `Today is ${today}.\n\nProduce the JSON briefing for this lead:\n\n${JSON.stringify(userBody, null, 2)}`,
    },
  ];
}

function flattenForClipboard(messages: ChatMessage[]): string {
  return messages.map((m) => `# ${m.role.toUpperCase()}\n\n${m.content}`).join('\n\n---\n\n');
}

// ── LLM response parsing ──────────────────────────────────────────────

interface ParsedSummary {
  summary: string;
  risk: SummaryRiskLevel;
  actions: SummaryNextAction[];
  followUpDays: number | null;
}

function parseSummaryFromText(raw: string): ParsedSummary {
  const text = (raw ?? '').trim();
  // Try strict JSON first.
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Try to extract a JSON object from a wrapper (markdown fence, prose).
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch { /* leave null */ }
    }
  }
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const summary = typeof obj.summary === 'string' && obj.summary.trim()
      ? obj.summary.trim()
      : text.slice(0, 800);
    const risk: SummaryRiskLevel =
      typeof obj.risk === 'string' && (SUMMARY_RISK_LEVELS as readonly string[]).includes(obj.risk)
        ? (obj.risk as SummaryRiskLevel)
        : 'low';
    const actions: SummaryNextAction[] = Array.isArray(obj.actions)
      ? obj.actions.flatMap((a) => {
          if (!a || typeof a !== 'object') return [];
          const aobj = a as Record<string, unknown>;
          if (typeof aobj.title !== 'string' || !aobj.title.trim()) return [];
          const urg = typeof aobj.urgency === 'string' && (['low','medium','high'] as const).includes(aobj.urgency as 'low')
            ? (aobj.urgency as 'low' | 'medium' | 'high')
            : 'medium';
          return [{
            title: aobj.title.trim(),
            urgency: urg,
            owner: typeof aobj.owner === 'string' && aobj.owner.trim() ? aobj.owner.trim() : null,
          }];
        })
      : [];
    const followUpDays =
      typeof obj.follow_up_days === 'number' && Number.isFinite(obj.follow_up_days) && obj.follow_up_days > 0
        ? Math.min(Math.round(obj.follow_up_days), 90)
        : null;
    return { summary, risk, actions, followUpDays };
  }
  // Total parse failure → use the raw text as summary, default risk + no actions.
  return {
    summary: text.slice(0, 800),
    risk: 'low',
    actions: [],
    followUpDays: null,
  };
}

function rowToDto(r: {
  engagementId: string;
  summaryText: string;
  riskLevel: string;
  nextActions: unknown;
  recommendedFollowUpDays: number | null;
  generatedBy: string;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedByUserId: string | null;
  generatedAt: Date;
}): LeadSummaryRow {
  const actions: SummaryNextAction[] = Array.isArray(r.nextActions)
    ? (r.nextActions as SummaryNextAction[])
    : [];
  return {
    engagementId: r.engagementId,
    summaryText: r.summaryText,
    riskLevel: r.riskLevel as SummaryRiskLevel,
    nextActions: actions,
    recommendedFollowUpDays: r.recommendedFollowUpDays,
    generatedBy: r.generatedBy as 'llm' | 'manual',
    model: r.model,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    generatedByUserId: r.generatedByUserId,
    generatedAt: r.generatedAt.toISOString(),
    fresh: Date.now() - r.generatedAt.getTime() < FRESHNESS_WINDOW_MS,
  };
}
