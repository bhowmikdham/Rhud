/**
 * LLM-driven engagement classification + manual override.
 *
 * Flow:
 *   • on submit → ClassificationService.classifyEngagement() runs
 *     (fire-and-forget from GatheringService.submit). LLM picks the
 *     best-matching (categorySlug, subCategorySlug) from the taxonomy
 *     the tenant can see.
 *   • a reviewer can override via ClassificationService.classifyManual().
 *   • either path emits engagement_classified or engagement_reclassified
 *     and chains into RoutingService.applyForEngagement so the matched
 *     reviewer is auto-assigned.
 *
 * Failure modes:
 *   • LLM unavailable / parse error → engagement is left unclassified;
 *     the UI surfaces a "Classify" button.
 *   • Tenant uses 'manual' provider → we don't run the auto path
 *     (would 502); manual classification still works.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { LlmService } from '../llm/llm.service.js';
import type { ChatMessage } from '../llm/llm.types.js';
import type {
  ClassificationResult,
  ClassificationSource,
  ManualClassifyInput,
  OpportunityCategoryRow,
} from '@rhud/shared';
import { CategoriesService } from './categories.service.js';
import { RoutingService } from './routing.service.js';

@Injectable()
export class ClassificationService {
  private readonly logger = new Logger(ClassificationService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly llm: LlmService,
    private readonly categories: CategoriesService,
    private readonly routing: RoutingService,
  ) {}

  /** Best-effort auto-classification. Called from the gathering submit
   *  pipeline; silently no-ops on failure so a submission isn't held
   *  up by an LLM hiccup. */
  async classifyOnSubmit(tenantId: string, engagementId: string): Promise<void> {
    try {
      await this.classifyEngagement(tenantId, engagementId, null);
    } catch (e) {
      this.logger.warn(
        `auto-classify failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * Run the LLM classifier against an engagement's scope. Persists the
   * result onto the engagement + emits a thread event + chains into
   * routing. Manual-mode tenants short-circuit (no LLM available).
   */
  async classifyEngagement(
    tenantId: string,
    engagementId: string,
    actorUserId: string | null,
  ): Promise<ClassificationResult> {
    const provider = await this.llm.getProviderName(tenantId);
    if (!provider || provider === 'manual') {
      // No LLM available — caller must use the manual path.
      const current = await this.getCurrent(tenantId, engagementId);
      return current;
    }

    const ctx = await this.loadContext(tenantId, engagementId);
    const allCats = await this.categories.list(tenantId);
    const messages = buildPrompt(ctx, allCats);

    let result;
    try {
      result = await this.llm.chat(tenantId, messages, {
        maxTokens: 100,
        temperature: 0.0,
        timeoutMs: 20_000,
      });
    } catch (e) {
      this.logger.warn(`LLM classify call failed: ${(e as Error).message}`);
      return this.getCurrent(tenantId, engagementId);
    }

    const parsed = parseClassification(result.text, allCats);
    if (!parsed.categorySlug) {
      this.logger.warn(`LLM classify returned unrecognised category: ${result.text.slice(0, 200)}`);
      return this.getCurrent(tenantId, engagementId);
    }

    const model = result.model ? `${provider}:${result.model}` : provider;
    return this.persistAndRoute(tenantId, engagementId, {
      categorySlug: parsed.categorySlug,
      subCategorySlug: parsed.subCategorySlug,
      source: 'llm',
      model,
      actorUserId,
    });
  }

  /** Manual classification by a reviewer — bypasses the LLM. */
  async classifyManual(
    tenantId: string,
    engagementId: string,
    input: ManualClassifyInput,
    actorUserId: string,
  ): Promise<ClassificationResult> {
    if (!input.categorySlug?.trim()) {
      throw new BadRequestException('category_required');
    }
    const exists = await this.categories.exists(tenantId, input.categorySlug);
    if (!exists) throw new BadRequestException('unknown_category');
    if (input.subCategorySlug) {
      const subExists = await this.categories.exists(tenantId, input.subCategorySlug);
      if (!subExists) throw new BadRequestException('unknown_sub_category');
    }
    return this.persistAndRoute(tenantId, engagementId, {
      categorySlug: input.categorySlug,
      subCategorySlug: input.subCategorySlug ?? null,
      source: 'manual',
      model: null,
      actorUserId,
    });
  }

  /** Read current classification without invoking the LLM. */
  async getCurrent(tenantId: string, engagementId: string): Promise<ClassificationResult> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          categorySlug: true,
          subCategorySlug: true,
          classifiedBy: true,
          classifiedAt: true,
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      return {
        categorySlug: eng.categorySlug,
        subCategorySlug: eng.subCategorySlug,
        classifiedBy: eng.classifiedBy as ClassificationSource | null,
        classifiedAt: eng.classifiedAt?.toISOString() ?? null,
      };
    });
  }

  // ── Internals ─────────────────────────────────────────────────────

  private async persistAndRoute(
    tenantId: string,
    engagementId: string,
    args: {
      categorySlug: string;
      subCategorySlug: string | null;
      source: ClassificationSource;
      model: string | null;
      actorUserId: string | null;
    },
  ): Promise<ClassificationResult> {
    const result = await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          categorySlug: true,
          subCategorySlug: true,
        },
      });
      if (!existing) throw new NotFoundException('engagement_not_found');

      const previousCategorySlug = existing.categorySlug;
      const previousSubCategorySlug = existing.subCategorySlug;
      const isReclassification = previousCategorySlug != null
        && previousCategorySlug !== args.categorySlug;

      const updated = await db.engagement.update({
        where: { id: engagementId },
        data: {
          categorySlug: args.categorySlug,
          subCategorySlug: args.subCategorySlug,
          classifiedBy: args.source,
          classifiedAt: new Date(),
        },
        select: {
          categorySlug: true,
          subCategorySlug: true,
          classifiedBy: true,
          classifiedAt: true,
        },
      });

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: isReclassification ? 'engagement_reclassified' : 'engagement_classified',
        actorType: args.source === 'llm' ? 'system' : 'user',
        actorId: args.actorUserId,
        payload: {
          categorySlug: args.categorySlug,
          subCategorySlug: args.subCategorySlug,
          source: args.source,
          ...(args.model ? { model: args.model } : {}),
          ...(isReclassification ? {
            previousCategorySlug,
            previousSubCategorySlug,
          } : {}),
        },
      });

      return {
        categorySlug: updated.categorySlug,
        subCategorySlug: updated.subCategorySlug,
        classifiedBy: updated.classifiedBy as ClassificationSource | null,
        classifiedAt: updated.classifiedAt?.toISOString() ?? null,
      };
    });

    // Apply routing rules — fire-and-forget, doesn't block the response.
    // Routing failures are logged inside the service.
    void this.routing.applyForEngagement(tenantId, engagementId);

    return result;
  }

  /** Pull the scope context the LLM uses to classify. Mirrors the
   *  loadContext pattern in proposal-draft / summary services. */
  private async loadContext(tenantId: string, engagementId: string): Promise<{
    name: string | null;
    serviceLine: string | null;
    scopeAnswers: Array<{ question: string; answer: unknown }>;
    extractedPoints: string[];
    siteCategories: string[];
  }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        include: {
          template: { select: { name: true, serviceLine: true } },
          answers: {
            include: { /* no node — we'll join via template_nodes table separately */ },
            take: 40,
          },
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      // Join template nodes lazily to surface question text alongside
      // answers. Skip nodes that don't exist (deleted templates).
      const answerNodeIds = eng.answers.map((a) => a.nodeId);
      const nodes = answerNodeIds.length
        ? await db.templateNode.findMany({
            where: { id: { in: answerNodeIds } },
            select: { id: true, question: true },
          })
        : [];
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const scopeAnswers = eng.answers.map((a) => ({
        question: nodeById.get(a.nodeId)?.question ?? '(unknown question)',
        answer: a.answer,
      }));

      return {
        name: eng.name,
        serviceLine: eng.template?.serviceLine ?? null,
        scopeAnswers,
        extractedPoints: [],
        siteCategories: [],
      };
    });
  }
}

// ── Prompt assembly ──────────────────────────────────────────────────

function buildPrompt(
  ctx: {
    name: string | null;
    serviceLine: string | null;
    scopeAnswers: Array<{ question: string; answer: unknown }>;
  },
  categories: OpportunityCategoryRow[],
): ChatMessage[] {
  // Flatten the taxonomy into a compact text block the LLM can match
  // against. We list slugs explicitly so the model has zero room to
  // hallucinate alternative spellings.
  const topLevel = categories.filter((c) => c.parentSlug == null);
  const childrenByParent = new Map<string, OpportunityCategoryRow[]>();
  for (const c of categories) {
    if (!c.parentSlug) continue;
    const arr = childrenByParent.get(c.parentSlug) ?? [];
    arr.push(c);
    childrenByParent.set(c.parentSlug, arr);
  }

  const taxonomyLines: string[] = [];
  for (const t of topLevel) {
    taxonomyLines.push(`- ${t.slug}  (${t.name})`);
    const kids = childrenByParent.get(t.slug) ?? [];
    for (const k of kids) {
      taxonomyLines.push(`    - ${k.slug}  (${k.name})`);
    }
  }

  const system: ChatMessage = {
    role: 'system',
    content: [
      'You are a cybersecurity sales classifier.',
      'Given an opportunity scope, choose the single best-matching',
      'category from the taxonomy below, and optionally a subcategory',
      "from the matching parent's children.",
      '',
      'Output exactly one JSON object — no markdown, no commentary:',
      '{ "categorySlug": "<slug>", "subCategorySlug": "<slug>" | null }',
      '',
      'TAXONOMY (use slugs verbatim):',
      ...taxonomyLines,
      '',
      'Rules:',
      '  - categorySlug MUST be a top-level slug (no parent).',
      '  - subCategorySlug, if set, MUST be a child of the chosen category.',
      '  - When the scope is ambiguous, prefer the most specific category',
      '    that clearly applies. When nothing fits, use "other_cybersecurity".',
    ].join('\n'),
  };

  const userBody = {
    opportunity_name: ctx.name,
    service_line: ctx.serviceLine,
    scope_answers: ctx.scopeAnswers.map((a) => ({
      question: a.question,
      answer: a.answer,
    })),
  };

  return [
    system,
    {
      role: 'user',
      content: `Classify this opportunity:\n\n${JSON.stringify(userBody, null, 2)}`,
    },
  ];
}

function parseClassification(
  raw: string,
  validCats: OpportunityCategoryRow[],
): { categorySlug: string | null; subCategorySlug: string | null } {
  const validTop = new Set(validCats.filter((c) => c.parentSlug == null).map((c) => c.slug));
  const subByParent = new Map<string, Set<string>>();
  for (const c of validCats) {
    if (!c.parentSlug) continue;
    const s = subByParent.get(c.parentSlug) ?? new Set<string>();
    s.add(c.slug);
    subByParent.set(c.parentSlug, s);
  }

  const text = raw.trim();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Try to extract a JSON object from a wrapper.
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { json = JSON.parse(m[0]); } catch { /* ignore */ }
    }
  }
  if (!json || typeof json !== 'object') {
    return { categorySlug: null, subCategorySlug: null };
  }
  const obj = json as Record<string, unknown>;
  const cat = typeof obj.categorySlug === 'string' ? obj.categorySlug.trim() : null;
  const sub = typeof obj.subCategorySlug === 'string' ? obj.subCategorySlug.trim() : null;

  if (!cat || !validTop.has(cat)) {
    return { categorySlug: null, subCategorySlug: null };
  }
  if (sub) {
    const allowedSubs = subByParent.get(cat);
    if (!allowedSubs || !allowedSubs.has(sub)) {
      // Reject mis-parented subcategory — keep the top-level pick.
      return { categorySlug: cat, subCategorySlug: null };
    }
  }
  return { categorySlug: cat, subCategorySlug: sub ?? null };
}
