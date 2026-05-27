import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  buildScopeSummary,
  resolveNext,
  validateAnswerShape,
  type Answer,
  type CustomerType,
  type LoopConfig,
  type LoopState,
  type Methodology,
  type RateCard,
  type ScopeSummary,
  type ScopeSummaryEntityInput,
  type TemplateNode,
  type TemplateWithNodes,
} from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { ThreadService } from '../thread/thread.service.js';
import { S3Service } from '../storage/s3.service.js';
import { MlService } from '../ml/ml.service.js';
import { ExtractionService } from '../extraction/extraction.service.js';
import { QuoteService } from '../pricing/quote.service.js';
import { OdooService } from '../integrations/odoo/odoo.service.js';
import { ClassificationService } from '../classification/classification.service.js';
import { deviceFingerprint, fingerprintsEqual, verifyToken } from './token.util.js';

export interface RequestContext {
  ip: string;
  userAgent: string;
  acceptLanguage?: string;
}

interface ResolvedToken {
  tokenId: string;
  tenantId: string;
  engagementId: string;
}

export interface GatheringLoopContext {
  loopId: string;
  label: string;          // Singular label, e.g. "Application"
  iter: number;           // 0-based iteration index
}

export interface GatheringLoopStep {
  loopId: string;
  label: string;
  iter: number;           // The iteration just finished — UI shows "Application N done"
}

export interface GatheringState {
  engagementId: string;
  templateName: string;
  status: string;
  // Full ordered list of template nodes — client uses it to build the
  // section outline + allow back / jump-to navigation. The gathering
  // token already grants access to this engagement's template, so
  // exposing the structure adds no new attack surface.
  templateNodes: TemplateNode[];
  templateRootNodeId: string | null;
  // Current node to render next, or null if there isn't one (submitted, or
  // sitting at a loop_step prompt).
  currentNode: TemplateNode | null;
  // Set when the current node is inside a loop body — the UI uses this to
  // render the "Application 1 of N" header.
  loopContext: GatheringLoopContext | null;
  // Set when the responder reached the end of a loop body and needs to
  // pick "Add another" or "Done". Mutually exclusive with currentNode.
  loopStep: GatheringLoopStep | null;
  // Top-level (non-loop) answers — { nodeId: answer }.
  answers: Record<string, Answer>;
  // Loop-body answers grouped: { loopId: [ { childNodeId: answer, ... }, ... ] }
  // Outer array index = iteration; map key = body child node id.
  loopAnswers: Record<string, Array<Record<string, Answer>>>;
  // Files already uploaded (filenames) per node.
  files: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>>;
  // Suggested answers from cached inferred entities — { nodeId: answer }.
  // Populated by matching `binding.serviceLineSlug` to extraction-cached
  // entities on engagement_files.inferred_entities. The UI shows these
  // as placeholders / pre-fill values; the responder confirms or edits
  // before submit. Only populated for nodes the responder hasn't already
  // answered (so an actual answer always overrides a suggestion).
  suggestedAnswers: Record<string, Answer>;
  /** Per-suggested-answer confidence in [0..1]. Mirrors `suggestedAnswers`
   *  keys. Lets the UI render a visible chip ("Strong", "Approximate")
   *  so the responder treats borderline inferences with appropriate care. */
  suggestionConfidence: Record<string, number>;
  /** Extraction pipeline status across all uploaded files. The Quick-fill
   *  flow polls /state during extraction and uses these counts to render
   *  a "Parsing your document…" progress indicator. */
  extraction: {
    totalFiles: number;
    readyFiles: number;
    inFlightFiles: number;
    failedFiles: number;
  };
  /**
   * Plain-English summary of what the LLM mapper extracted from uploaded
   * documents. The Review modal renders this ABOVE the form questions so
   * the client sees "we read 1 web app + 1 API + 2 roles" instead of a
   * half-empty form. Empty when no entities cleared the confidence floor
   * (≥0.6) — UI falls back to a "we couldn't read your document" message.
   *
   * Built server-side from cached `inferred_entities` + the engagement's
   * rate card; pure render of data the client already has access to.
   * See packages/shared/src/scope-summary.ts.
   */
  scopeSummary: ScopeSummary;
  /**
   * Inferred entities the client's template has no place to put. When
   * the mapper finds (e.g.) `vapt_cloud_iam=1` but the template has no
   * loop or section bound to that slug, the entity is priced server-side
   * but never auto-fills the form. We surface them here so the Review
   * UI can say "we found these but your form has no place for them".
   *
   * Each entry is the slug + its display name + the count — enough for
   * the rep to know what was missed without exposing internal structure.
   */
  unprojectedEntities: Array<{
    serviceLineSlug: string;
    displayName: string;
    scopeValue: number;
    confidence: number;
  }>;
}

// Internal cursor from findCursor(): the same union the public response
// reflects, but with the runtime types we use during the walk.
type Cursor =
  | { kind: 'node'; node: TemplateNode; loopContext: GatheringLoopContext | null }
  | { kind: 'loop_step'; loopId: string; label: string; iter: number }
  | { kind: 'end' };

/**
 * Client-facing gathering flow. No JWT — authority comes from the token in
 * the URL path. Each method:
 *   1. Resolves the token (UnscopedDb scan + argon2 verify) → tenantId.
 *   2. Records the access event + (on first use) binds the device fingerprint.
 *   3. Switches to TenantDb for the actual work.
 */
@Injectable()
export class GatheringService {
  private readonly logger = new Logger(GatheringService.name);

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly s3: S3Service,
    private readonly ml: MlService,
    private readonly quotes: QuoteService,
    private readonly extraction: ExtractionService,
    private readonly odoo: OdooService,
    private readonly classification: ClassificationService,
  ) {}

  // ── Token resolution ─────────────────────────────────────────────────────

  private async resolveToken(plaintext: string, ctx: RequestContext): Promise<ResolvedToken> {
    if (!plaintext || plaintext.length < 16) {
      throw new UnauthorizedException('invalid_token');
    }

    const candidates = await this.unscoped.findActiveGatheringTokens();

    let matched: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (await verifyToken(c.tokenHash, plaintext)) {
        matched = c;
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_token');

    const fingerprint = deviceFingerprint(ctx);

    // First-use binding, or fingerprint-mismatch detection. Done within the
    // tenant scope so RLS holds.
    let firstUse = false;
    const linkOpenedPayload = { ip: redactIp(ctx.ip), userAgent: ctx.userAgent };
    await this.tenantDb.run(matched.tenantId, async (db) => {
      if (!matched!.boundFingerprintHash) {
        firstUse = true;
        await db.gatheringToken.update({
          where: { id: matched!.id },
          data: {
            boundFingerprintHash: fingerprint,
            accessCount: { increment: 1 },
          },
        });
        await this.thread.emitWithin(db, matched!.tenantId, {
          engagementId: matched!.engagementId,
          eventType: 'link_opened',
          actorType: 'client',
          actorId: null,
          payload: linkOpenedPayload,
        });
      } else {
        if (!fingerprintsEqual(matched!.boundFingerprintHash, fingerprint)) {
          this.logger.warn(`gathering token ${matched!.id}: device fingerprint mismatch`);
          throw new UnauthorizedException('device_changed');
        }
        await db.gatheringToken.update({
          where: { id: matched!.id },
          data: { accessCount: { increment: 1 } },
        });
      }
    });

    if (firstUse) {
      void this.thread.dispatchAfterCommit(matched.tenantId, {
        engagementId: matched.engagementId,
        eventType: 'link_opened',
        actorType: 'client',
        payload: linkOpenedPayload,
      });
    }

    return {
      tokenId: matched.id,
      tenantId: matched.tenantId,
      engagementId: matched.engagementId,
    };
  }

  // ── State / cursor ───────────────────────────────────────────────────────

  async getState(plaintext: string, ctx: RequestContext): Promise<GatheringState> {
    const t = await this.resolveToken(plaintext, ctx);
    return this.tenantDb.run(t.tenantId, async (db) => {
      const engagement = await db.engagement.findUniqueOrThrow({
        where: { id: t.engagementId },
        include: {
          template: { include: { nodes: { orderBy: { position: 'asc' } } } },
          answers: true,
          files: true,
        },
      });
      // Invariant from docs/direct-ingest.md §3.2: a GatheringToken
      // cannot exist on an engagement with templateId IS NULL. If we
      // resolved a token whose engagement has no template, something
      // upstream broke the invariant — fail loud rather than crash on
      // a null deref. The rep needs to attach a template before this
      // gathering URL can be served.
      if (!engagement.template) {
        throw new NotFoundException('no_template_attached');
      }
      const tmpl: TemplateWithNodes = {
        id: engagement.template.id,
        tenantId: engagement.template.tenantId,
        serviceLine: engagement.template.serviceLine,
        name: engagement.template.name,
        version: engagement.template.version,
        status: engagement.template.status as TemplateWithNodes['status'],
        rootNodeId: engagement.template.rootNodeId,
        createdAt: engagement.template.createdAt.toISOString(),
        updatedAt: engagement.template.updatedAt.toISOString(),
        nodes: engagement.template.nodes.map((n) => toTemplateNode(n as DbNode)),
      };

      // Group answers by (nodeId → iteration → answer) for the walker, and
      // by loopId → iter → bodyChildId → answer for the public response.
      const answersByIter: AnswersByIter = new Map();
      const topLevelAnswers: Record<string, Answer> = {};
      const loopAnswers: Record<string, Array<Record<string, Answer>>> = {};
      const bodyParent = new Map(tmpl.nodes.map((n) => [n.id, n.parentNodeId ?? null]));

      for (const a of engagement.answers) {
        const inner = answersByIter.get(a.nodeId) ?? new Map<number, Answer>();
        inner.set(a.iterationIndex, a.answer as Answer);
        answersByIter.set(a.nodeId, inner);

        const parent = bodyParent.get(a.nodeId);
        if (parent) {
          const arr = loopAnswers[parent] ?? [];
          while (arr.length <= a.iterationIndex) arr.push({});
          arr[a.iterationIndex]![a.nodeId] = a.answer as Answer;
          loopAnswers[parent] = arr;
        } else {
          topLevelAnswers[a.nodeId] = a.answer as Answer;
        }
      }

      const filesMap: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>> = {};
      for (const f of engagement.files) {
        // Scoping docs (Quick-fill uploads) live at the engagement level
        // and don't belong under any specific question's files list.
        // The Quick-fill UI surfaces them separately via the extraction
        // status counters returned below.
        if (!f.nodeId) continue;
        if (!filesMap[f.nodeId]) filesMap[f.nodeId] = [];
        filesMap[f.nodeId]!.push({
          id: f.id,
          filename: f.filename,
          sizeBytes: Number(f.sizeBytes),
        });
      }

      const loopState = ((engagement.loopState as LoopState | null) ?? {}) as LoopState;
      const cursor = engagement.submittedAt
        ? ({ kind: 'end' } satisfies Cursor)
        : findCursor(tmpl, answersByIter, loopState);

      // Pre-populate body answers from cached inferred entities. We
      // pull `inferred_entities` off every engagement file, build a
      // `slug → scope` map (highest-confidence entity wins per slug),
      // then walk the template nodes looking for any `binding.serviceLineSlug`
      // we have a suggestion for. Suggestions are skipped where the
      // responder has already answered — actual answers always win.
      const fileRows = await db.engagementFile.findMany({
        where: { engagementId: t.engagementId, extractionStatus: 'ready' },
        select: { inferredEntities: true, filename: true },
      });
      // For each slug, keep the highest-confidence entity (and its
      // confidence) so the suggestion + confidence chip stay aligned.
      const bestBySlug = new Map<string, { scope: number; confidence: number }>();
      // Flat list of ALL entities for the scope-summary builder.
      // Includes everything ≥0.6 — the builder's own floor is the canonical
      // place that filters; we capture file provenance here so summary
      // items can show "from acme-questionnaire.xlsx".
      const summaryEntities: ScopeSummaryEntityInput[] = [];
      for (const row of fileRows) {
        const arr = Array.isArray(row.inferredEntities)
          ? (row.inferredEntities as Array<{
              serviceLineSlug?: string;
              scopeValue?: number;
              confidence?: number;
              methodology?: string | null;
              customerType?: 'internal' | 'external';
              appId?: string;
              sourceQuote?: string;
            }>)
          : [];
        for (const e of arr) {
          if (typeof e.serviceLineSlug !== 'string') continue;
          if (typeof e.scopeValue !== 'number' || e.scopeValue <= 0) continue;
          const conf = typeof e.confidence === 'number' ? e.confidence : 0;
          if (conf < 0.6) continue;
          const prev = bestBySlug.get(e.serviceLineSlug);
          if (prev === undefined || conf > prev.confidence) {
            bestBySlug.set(e.serviceLineSlug, { scope: e.scopeValue, confidence: conf });
          }
          summaryEntities.push({
            serviceLineSlug: e.serviceLineSlug,
            scopeValue: e.scopeValue,
            methodology: (e.methodology ?? null) as Methodology,
            customerType: (e.customerType === 'internal' ? 'internal' : 'external') as CustomerType,
            confidence: conf,
            ...(e.appId ? { appId: e.appId } : {}),
            ...(e.sourceQuote ? { sourceQuote: e.sourceQuote } : {}),
            sourceFile: row.filename,
          });
        }
      }
      const suggestedAnswers: Record<string, Answer> = {};
      const suggestionConfidence: Record<string, number> = {};
      if (bestBySlug.size > 0) {
        for (const node of tmpl.nodes) {
          const slug = node.binding?.serviceLineSlug;
          if (!slug) continue;
          const hit = bestBySlug.get(slug);
          if (!hit) continue;
          // Don't overwrite an existing answer — actual answers win.
          if (answersByIter.get(node.id)?.has(0)) continue;
          suggestedAnswers[node.id] = hit.scope;
          suggestionConfidence[node.id] = hit.confidence;
        }
      }

      // ── Scope summary + unprojected entities ────────────────────────
      // The Review UI shows clients what we read from their doc BEFORE
      // the form opens. Without this surface, a 3-entity inference
      // looks like a half-empty form (since the form only auto-fills
      // when the template's bindings line up with rate-card slugs).
      //
      // Build a minimal RateCard view (just the slugs + displayNames the
      // builder needs) by querying the template's rate-card. We don't
      // load tier rows — the summary doesn't price; it describes.
      let scopeSummary: ScopeSummary = { groups: [], totalItems: 0, isEmpty: true };
      const unprojectedEntities: GatheringState['unprojectedEntities'] = [];
      const rateCardId = engagement.template.rateCardId;
      if (rateCardId && summaryEntities.length > 0) {
        const slRows = await db.rateCardServiceLine.findMany({
          where: { rateCardId },
          select: { id: true, slug: true, displayName: true, scopeUnit: true, pricingModel: true, position: true },
        });
        // Minimal RateCard shape — buildScopeSummary only reads slug +
        // displayName off serviceLines; tiers are unused for grouping.
        const slimRateCard: RateCard = {
          id: rateCardId,
          tenantId: t.tenantId,
          name: '',
          version: 1,
          status: 'published',
          currency: 'INR',
          serviceLines: slRows.map((sl) => ({
            id: sl.id,
            slug: sl.slug,
            displayName: sl.displayName,
            scopeUnit: sl.scopeUnit as RateCard['serviceLines'][number]['scopeUnit'],
            pricingModel: sl.pricingModel as RateCard['serviceLines'][number]['pricingModel'],
            position: sl.position,
            tiers: [],
          })),
          openPricedServices: [],
        };
        scopeSummary = buildScopeSummary(summaryEntities, slimRateCard);

        // Unprojected = entities the LLM produced but the template has
        // no binding for. This is the silent-data-loss surface: pricing
        // happens server-side but the rep / client never sees it in the
        // form. Surfacing here lets the Review UI flag the gap.
        const boundSlugs = new Set(
          tmpl.nodes
            .map((n) => n.binding?.serviceLineSlug)
            .filter((s): s is string => typeof s === 'string'),
        );
        // Also include the loop's main slug so a loop without a body-node
        // binding for the slug is still considered "projected".
        for (const n of tmpl.nodes) {
          if (n.nodeType === 'loop' && n.loopConfig?.serviceLineSlug) {
            boundSlugs.add(n.loopConfig.serviceLineSlug);
          }
        }
        const slBySlug = new Map(slRows.map((sl) => [sl.slug, sl.displayName]));
        for (const e of summaryEntities) {
          if (boundSlugs.has(e.serviceLineSlug)) continue;
          unprojectedEntities.push({
            serviceLineSlug: e.serviceLineSlug,
            displayName: slBySlug.get(e.serviceLineSlug) ?? e.serviceLineSlug,
            scopeValue: e.scopeValue,
            confidence: e.confidence,
          });
        }
      }

      // Extraction status counters across all uploaded files.
      // Used by the gathering page to show "Parsing your document…"
      // progress and trigger a /state re-poll until everything settles.
      const extractionGroups = await db.engagementFile.groupBy({
        by: ['extractionStatus'],
        where: { engagementId: t.engagementId },
        _count: { _all: true },
      });
      const extractionStatusCounts = {
        totalFiles: 0,
        readyFiles: 0,
        inFlightFiles: 0,
        failedFiles: 0,
      };
      for (const g of extractionGroups) {
        const n = (g._count?._all as number) ?? 0;
        extractionStatusCounts.totalFiles += n;
        if (g.extractionStatus === 'ready') extractionStatusCounts.readyFiles += n;
        else if (g.extractionStatus === 'failed') extractionStatusCounts.failedFiles += n;
        else extractionStatusCounts.inFlightFiles += n;
      }

      return {
        engagementId: engagement.id,
        templateName: tmpl.name,
        status: engagement.status,
        templateNodes: tmpl.nodes,
        templateRootNodeId: tmpl.rootNodeId,
        currentNode: cursor.kind === 'node' ? cursor.node : null,
        loopContext: cursor.kind === 'node' ? cursor.loopContext : null,
        loopStep: cursor.kind === 'loop_step'
          ? { loopId: cursor.loopId, label: cursor.label, iter: cursor.iter }
          : null,
        answers: topLevelAnswers,
        loopAnswers,
        files: filesMap,
        suggestedAnswers,
        suggestionConfidence,
        extraction: extractionStatusCounts,
        scopeSummary,
        unprojectedEntities,
      };
    });
  }

  // ── Submit one answer ─────────────────────────────────────────────────────

  async submitAnswer(
    plaintext: string,
    ctx: RequestContext,
    args: { nodeId: string; answer: Answer },
  ): Promise<{
    next:
      | { kind: 'node'; node: TemplateNode; loopContext: GatheringLoopContext | null }
      | { kind: 'loop_step'; loopId: string; label: string; iter: number }
      | { kind: 'end' };
  }> {
    const t = await this.resolveToken(plaintext, ctx);

    const result = await this.tenantDb.run(t.tenantId, async (db) => {
      const dbNode = await db.templateNode.findUnique({ where: { id: args.nodeId } });
      if (!dbNode) throw new NotFoundException('node_not_found');
      const node = toTemplateNode(dbNode as DbNode);

      // Iteration index for body nodes comes from the loop's cursor;
      // top-level answers always live at iter 0. We update loopState
      // alongside the answer so resume + walking stays consistent.
      const engagementRow = await db.engagement.findUniqueOrThrow({
        where: { id: t.engagementId },
        select: { loopState: true },
      });
      const loopState = ((engagementRow.loopState as LoopState | null) ?? {}) as LoopState;
      const iter = node.parentNodeId
        ? (loopState[node.parentNodeId]?.iter ?? 0)
        : 0;

      const isSkip = args.answer === null || args.answer === '';
      const isOptional = node.required === false;
      const persistedAnswer: Answer =
        node.nodeType === 'section' || node.nodeType === 'loop' || (isOptional && isSkip)
          ? ''
          : args.answer;

      if (!(node.nodeType === 'section' || node.nodeType === 'loop' || (isOptional && isSkip))) {
        const shape = validateAnswerShape(node.nodeType, persistedAnswer);
        if (!shape.ok) {
          throw new BadRequestException({ code: 'invalid_answer_shape', reason: shape.reason });
        }
      }

      await db.engagementAnswer.upsert({
        where: {
          engagementId_nodeId_iterationIndex: {
            engagementId: t.engagementId,
            nodeId: args.nodeId,
            iterationIndex: iter,
          },
        },
        update: { answer: persistedAnswer as unknown as object },
        create: {
          tenantId: t.tenantId,
          engagementId: t.engagementId,
          nodeId: args.nodeId,
          iterationIndex: iter,
          answer: persistedAnswer as unknown as object,
        },
      });

      // First answer of any kind transitions issued → in_progress. Mark the
      // loop as 'iterating' the first time a body node lands in iter 0;
      // gives findCursor a predictable state to walk on resume.
      await db.engagement.updateMany({
        where: { id: t.engagementId, status: 'issued' },
        data: { status: 'in_progress' },
      });
      if (node.parentNodeId && !loopState[node.parentNodeId]) {
        const updated = { ...loopState, [node.parentNodeId]: { iter: 0, status: 'iterating' as const } };
        await db.engagement.update({
          where: { id: t.engagementId },
          data: { loopState: updated as unknown as object },
        });
      }

      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'node_answered',
        actorType: 'client',
        payload: { nodeId: args.nodeId, ...(node.parentNodeId ? { iter } : {}) },
      });

      // Quick syntax check on the immediate transition — we still want a
      // hard error on invalid trees rather than silently eating them.
      const sanity = resolveNext(node, persistedAnswer);
      if (sanity.kind === 'invalid') {
        throw new BadRequestException({ code: 'tree_resolution_failed', reason: sanity.reason });
      }

      // Re-walk from root with the new answer included so loop entry,
      // body-end → loop_step, and post-loop transitions all collapse into
      // a single "what should the responder see next?" computation.
      return this.computeNextCursorAfterMutation(db, t.engagementId);
    });

    // Suppressed by default in the route map (too noisy), but dispatch
    // anyway so per-tenant overrides can opt in.
    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'node_answered',
      actorType: 'client',
      payload: { nodeId: args.nodeId },
    });

    return result;
  }

  /**
   * After a write inside a tenant scope, recompute "what's next" by walking
   * the full template with the latest answers + loopState. Keeps loop logic
   * (entry, body-end, post-loop) centralised in findCursor.
   */
  private async computeNextCursorAfterMutation(
    db: Parameters<Parameters<TenantDb['run']>[1]>[0],
    engagementId: string,
  ): Promise<{
    next:
      | { kind: 'node'; node: TemplateNode; loopContext: GatheringLoopContext | null }
      | { kind: 'loop_step'; loopId: string; label: string; iter: number }
      | { kind: 'end' };
  }> {
    const engagement = await db.engagement.findUniqueOrThrow({
      where: { id: engagementId },
      include: {
        template: { include: { nodes: { orderBy: { position: 'asc' } } } },
        answers: true,
      },
    });
    // Same invariant guard as resolveToken — see docs/direct-ingest.md §3.2.
    // findCurrentNode is called only after token resolution succeeds, so
    // this is belt-and-braces: if we somehow get here on a template-less
    // engagement, fail loud rather than null-deref.
    if (!engagement.template) {
      throw new NotFoundException('no_template_attached');
    }
    const tmpl: TemplateWithNodes = {
      id: engagement.template.id,
      tenantId: engagement.template.tenantId,
      serviceLine: engagement.template.serviceLine,
      name: engagement.template.name,
      version: engagement.template.version,
      status: engagement.template.status as TemplateWithNodes['status'],
      rootNodeId: engagement.template.rootNodeId,
      createdAt: engagement.template.createdAt.toISOString(),
      updatedAt: engagement.template.updatedAt.toISOString(),
      nodes: engagement.template.nodes.map((n) => toTemplateNode(n as DbNode)),
    };

    const answersByIter: AnswersByIter = new Map();
    for (const a of engagement.answers) {
      const inner = answersByIter.get(a.nodeId) ?? new Map<number, Answer>();
      inner.set(a.iterationIndex, a.answer as Answer);
      answersByIter.set(a.nodeId, inner);
    }
    const loopState = ((engagement.loopState as LoopState | null) ?? {}) as LoopState;

    const cursor = findCursor(tmpl, answersByIter, loopState);
    if (cursor.kind === 'end') return { next: { kind: 'end' as const } };
    if (cursor.kind === 'loop_step') {
      return {
        next: {
          kind: 'loop_step' as const,
          loopId: cursor.loopId,
          label: cursor.label,
          iter: cursor.iter,
        },
      };
    }
    return { next: { kind: 'node' as const, node: cursor.node, loopContext: cursor.loopContext } };
  }

  private async resolveLoopLabel(
    db: Parameters<Parameters<TenantDb['run']>[1]>[0],
    loopId: string,
  ): Promise<string> {
    const row = await db.templateNode.findUnique({ where: { id: loopId } });
    if (!row) return 'Item';
    return loopLabel(toTemplateNode(row as DbNode));
  }

  // ── Loop step (continue / done) ───────────────────────────────────────────

  /**
   * Called from the client at the end of a loop iteration. `continue` bumps
   * the iter and returns the body's first node; `done` marks the loop as
   * finished and walks past it via the loop node's nextRules.
   */
  async submitLoopStep(
    plaintext: string,
    ctx: RequestContext,
    args: { loopId: string; action: 'continue' | 'done' },
  ): Promise<{
    next:
      | { kind: 'node'; node: TemplateNode; loopContext: GatheringLoopContext | null }
      | { kind: 'loop_step'; loopId: string; label: string; iter: number }
      | { kind: 'end' };
  }> {
    const t = await this.resolveToken(plaintext, ctx);

    return this.tenantDb.run(t.tenantId, async (db) => {
      const loopRow = await db.templateNode.findUnique({ where: { id: args.loopId } });
      if (!loopRow) throw new NotFoundException('loop_not_found');
      if (loopRow.nodeType !== 'loop') throw new BadRequestException('not_a_loop_node');
      const loop = toTemplateNode(loopRow as DbNode);

      const engagementRow = await db.engagement.findUniqueOrThrow({
        where: { id: t.engagementId },
        select: { loopState: true },
      });
      const loopState = ((engagementRow.loopState as LoopState | null) ?? {}) as LoopState;
      const cursor = loopState[args.loopId] ?? { iter: 0, status: 'iterating' as const };

      const updated =
        args.action === 'continue'
          ? { ...loopState, [args.loopId]: { iter: cursor.iter + 1, status: 'iterating' as const } }
          : { ...loopState, [args.loopId]: { iter: cursor.iter, status: 'done' as const } };
      await db.engagement.update({
        where: { id: t.engagementId },
        data: { loopState: updated as unknown as object },
      });

      // Reuse the central walker so 'continue' lands on body[0] of the new
      // iteration and 'done' walks past the loop, both with the correct
      // loopContext on whatever they land on.
      void loop;
      return this.computeNextCursorAfterMutation(db, t.engagementId);
    });
  }

  /**
   * Remove a single loop iteration. Deletes every engagement_answer
   * for that loop's body nodes at iteration N, then shifts down
   * iteration indices > N so the iteration sequence stays dense.
   * Updates loopState's cursor accordingly.
   *
   * Used when extraction auto-creates an iteration the responder
   * doesn't actually want, OR when they manually added one and
   * realised it shouldn't be there. Confirmation lives client-side
   * (window.confirm) — irreversible by design.
   */
  async removeLoopIteration(
    plaintext: string,
    ctx: RequestContext,
    args: { loopId: string; iterIndex: number },
  ): Promise<{ ok: true }> {
    const t = await this.resolveToken(plaintext, ctx);
    if (args.iterIndex < 0) {
      throw new BadRequestException('iter_index_must_be_non_negative');
    }
    return this.tenantDb.run(t.tenantId, async (db) => {
      const loopRow = await db.templateNode.findUnique({ where: { id: args.loopId } });
      if (!loopRow) throw new NotFoundException('loop_not_found');
      if (loopRow.nodeType !== 'loop') throw new BadRequestException('not_a_loop_node');

      const bodyNodes = await db.templateNode.findMany({
        where: { parentNodeId: args.loopId },
        select: { id: true },
      });
      const bodyIds = bodyNodes.map((n) => n.id);
      if (bodyIds.length === 0) return { ok: true as const };

      // 1. Delete answers for the iteration being removed.
      await db.engagementAnswer.deleteMany({
        where: {
          engagementId: t.engagementId,
          nodeId: { in: bodyIds },
          iterationIndex: args.iterIndex,
        },
      });

      // 2. Shift any remaining iterations down by 1 so the index
      //    sequence stays gap-free.
      await db.engagementAnswer.updateMany({
        where: {
          engagementId: t.engagementId,
          nodeId: { in: bodyIds },
          iterationIndex: { gt: args.iterIndex },
        },
        data: {
          iterationIndex: { decrement: 1 },
        },
      });

      // 3. Update loopState — if cursor.iter > removed, decrement;
      //    if equal, keep at the same index so the responder lands
      //    on what's now the new iteration N (the previous N+1).
      const engagementRow = await db.engagement.findUniqueOrThrow({
        where: { id: t.engagementId },
        select: { loopState: true },
      });
      const loopState = ((engagementRow.loopState as LoopState | null) ?? {}) as LoopState;
      const cursor = loopState[args.loopId];
      if (cursor && cursor.iter > args.iterIndex) {
        const updated: LoopState = {
          ...loopState,
          [args.loopId]: { ...cursor, iter: cursor.iter - 1 },
        };
        await db.engagement.update({
          where: { id: t.engagementId },
          data: { loopState: updated as unknown as object },
        });
      }

      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'loop_iteration_removed',
        actorType: 'client',
        payload: { loopId: args.loopId, iterIndex: args.iterIndex },
      });

      return { ok: true as const };
    });
  }

  // ── Files: signed PUT URL ─────────────────────────────────────────────────

  async createSignedUploadUrl(
    plaintext: string,
    ctx: RequestContext,
    args: { nodeId: string; filename: string; contentType: string; sizeBytes: number },
  ): Promise<{ uploadUrl: string; fileId: string; key: string; expiresAt: string }> {
    const t = await this.resolveToken(plaintext, ctx);

    if (args.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException('file_too_large');
    }

    const fileId = randomUUID();
    const key = S3Service.keyForEngagementFile({
      tenantId: t.tenantId,
      engagementId: t.engagementId,
      fileId,
      filename: args.filename,
    });

    const { url, expiresAt } = await this.s3.presignPut({ key, contentType: args.contentType });

    // Pre-record the file row so the client only needs to PUT.
    // The browser confirms with `confirmUpload` once S3 returns 200.
    const fileUploadedPayload = {
      nodeId: args.nodeId,
      filename: args.filename,
      sizeBytes: args.sizeBytes,
    };
    await this.tenantDb.run(t.tenantId, async (db) => {
      await db.engagementFile.create({
        data: {
          id: fileId,
          tenantId: t.tenantId,
          engagementId: t.engagementId,
          nodeId: args.nodeId,
          s3Key: key,
          filename: args.filename,
          sizeBytes: BigInt(args.sizeBytes),
          contentType: args.contentType,
        },
      });
      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'file_uploaded',
        actorType: 'client',
        payload: fileUploadedPayload,
      });
    });

    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'file_uploaded',
      actorType: 'client',
      payload: fileUploadedPayload,
    });

    // Speculative kick-off — when the client PUTs to S3 and then keeps
    // answering questions, we use the gap to start text extraction so
    // by the time they hit Submit, most documents are already
    // structured. The kickoff is fire-and-forget; if S3 doesn't have
    // the bytes yet (rare race) the row will end in `failed` and the
    // submit-time pass below re-runs it. Both paths ultimately land
    // the file in a terminal state before predict runs.
    setTimeout(() => {
      void this.extraction.kickoff(t.tenantId, fileId).catch(() => undefined);
    }, 1500);

    return { uploadUrl: url, fileId, key, expiresAt };
  }

  /**
   * Quick-fill flow: the client uploads a scoping document at the very
   * start of the form, before answering any specific question. The file
   * is recorded with `kind='scoping_doc'` and `node_id=null` so the
   * gathering UI can keep these files separate from per-question
   * attachments. Extraction kicks off the same way, and the auto-promote
   * step downstream pre-creates loop iterations from the inferred
   * entities so the form starts pre-walked.
   */
  async createScopingDocUploadUrl(
    plaintext: string,
    ctx: RequestContext,
    args: { filename: string; contentType: string; sizeBytes: number },
  ): Promise<{ uploadUrl: string; fileId: string; key: string; expiresAt: string }> {
    const t = await this.resolveToken(plaintext, ctx);

    if (args.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException('file_too_large');
    }

    const fileId = randomUUID();
    const key = S3Service.keyForEngagementFile({
      tenantId: t.tenantId,
      engagementId: t.engagementId,
      fileId,
      filename: args.filename,
    });
    const { url, expiresAt } = await this.s3.presignPut({ key, contentType: args.contentType });

    const fileUploadedPayload = {
      kind: 'scoping_doc',
      filename: args.filename,
      sizeBytes: args.sizeBytes,
    };
    await this.tenantDb.run(t.tenantId, async (db) => {
      await db.engagementFile.create({
        data: {
          id: fileId,
          tenantId: t.tenantId,
          engagementId: t.engagementId,
          // node_id stays null — scoping docs don't belong to a question.
          kind: 'scoping_doc',
          s3Key: key,
          filename: args.filename,
          sizeBytes: BigInt(args.sizeBytes),
          contentType: args.contentType,
        },
      });
      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'file_uploaded',
        actorType: 'client',
        payload: fileUploadedPayload,
      });
    });

    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'file_uploaded',
      actorType: 'client',
      payload: fileUploadedPayload,
    });

    setTimeout(() => {
      void this.extraction.kickoff(t.tenantId, fileId).catch(() => undefined);
    }, 1500);

    return { uploadUrl: url, fileId, key, expiresAt };
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async submit(plaintext: string, ctx: RequestContext): Promise<{ status: string }> {
    const t = await this.resolveToken(plaintext, ctx);
    const result = await this.tenantDb.run(t.tenantId, async (db) => {
      await db.engagement.update({
        where: { id: t.engagementId },
        data: { status: 'submitted', submittedAt: new Date() },
      });
      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'scope_submitted',
        actorType: 'client',
      });
      // Revoke the token so it can't be reused after submission.
      await db.gatheringToken.update({
        where: { id: t.tokenId },
        data: { revokedAt: new Date() },
      });
      return { status: 'submitted' };
    });

    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'scope_submitted',
      actorType: 'client',
    });

    // Stage 1 + Stage 2: compute the deterministic base price and
    // persist the line-item ledger. Awaited so the manager opens an
    // approval card with the breakdown ready, not "pending".
    try {
      await this.quotes.computeAndPersistForEngagement(t.tenantId, t.engagementId);
    } catch (err) {
      this.logger.warn(
        `quote compute failed for ${t.engagementId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Stage 3 — document extraction gating. The user explicitly wants
    // every uploaded document processed BEFORE the price predict
    // fires, so the model + manager see the full signal set. Two
    // paths converge:
    //
    //   a) Files were already speculatively-kicked off during upload
    //      (see createSignedUploadUrl). Most should be `ready` by
    //      submit time. We re-kick failed/pending stragglers below
    //      to resume any that lost the upload race.
    //
    //   b) When every file lands in a terminal state, ExtractionService
    //      itself fires `predictForEngagement` (see settleAndMaybePredict
    //      in extraction.service). That keeps the gating logic in one
    //      place and avoids racing two predictors.
    //
    // If there are no files at all OR all files are already settled
    // (the common case for scope forms with zero attachments), fire
    // predict immediately — there's nothing to wait for.
    const enqueued = await this.extraction.kickoffForEngagement(t.tenantId, t.engagementId);
    const settled = await this.extraction.isAllSettled(t.tenantId, t.engagementId);
    if (enqueued === 0 && settled) {
      void this.ml.predictForEngagement(t.tenantId, t.engagementId);
    }
    // Otherwise: ExtractionService.settleAndMaybePredict triggers it
    // once the last file finishes.

    // Odoo auto-sync (no-op when disabled / not configured). The
    // service silently swallows errors so a flaky Odoo doesn't fail
    // a submission.
    void this.odoo.maybeAutoSync(t.tenantId, t.engagementId, 'submitted');

    // Phase B: auto-classify + auto-route. Silent failure (LLM down,
    // tenant on manual mode, no matching rule) leaves the engagement
    // unclassified — the UI surfaces a manual "Classify" button.
    void this.classification.classifyOnSubmit(t.tenantId, t.engagementId);

    return result;
  }
}

/**
 * Walk the template using existing answers + loop state and return the next
 * thing to render: a regular node, a loop body node (with iteration context),
 * a "Add another?" prompt, or template-end.
 *
 * Loop semantics:
 *   • A `loop` node has body children (parentNodeId === loop.id). Body
 *     children are walked exactly like a sub-tree, but answers persist with
 *     `iteration_index` matching the loop's current iter.
 *   • Body nodes' nextRules use 'END' to mean "end of body" (not template).
 *     When we hit body-end, we surface a `loop_step` so the UI can prompt
 *     continue/done.
 *   • loopState[loopId] = { iter, status }: persisted on the engagement so
 *     resume picks up at the right iteration.
 */
function findCursor(
  tmpl: TemplateWithNodes,
  answers: AnswersByIter,
  loopState: LoopState,
): Cursor {
  if (!tmpl.rootNodeId) return { kind: 'end' };
  const byId = new Map(tmpl.nodes.map((n) => [n.id, n]));
  const bodyByLoop = groupBodiesByLoop(tmpl.nodes);

  let cursor: string | null = tmpl.rootNodeId;
  const visited = new Set<string>();

  while (cursor) {
    if (visited.has(cursor)) return { kind: 'end' }; // cycle guard
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) return { kind: 'end' };

    if (node.nodeType === 'loop') {
      const state = loopState[node.id];
      if (!state || state.status === 'iterating') {
        const body = bodyByLoop.get(node.id) ?? [];
        if (body.length === 0) {
          // Empty loop body — treat like a section, fire `always` rule.
          const r = resolveNext(node, '');
          if (r.kind === 'end') return { kind: 'end' };
          if (r.kind === 'invalid') return { kind: 'node', node, loopContext: null };
          cursor = r.nodeId;
          continue;
        }
        const iter = state?.iter ?? 0;
        const inner = walkBody(body, byId, answers, iter);
        if (inner.kind === 'unanswered') {
          return {
            kind: 'node',
            node: inner.node,
            loopContext: { loopId: node.id, label: loopLabel(node), iter },
          };
        }
        if (inner.kind === 'body_end') {
          return { kind: 'loop_step', loopId: node.id, label: loopLabel(node), iter };
        }
        // inner.kind === 'invalid' — the body resolution dead-ended. Bail
        // out by treating the loop as done; the runtime can still reach
        // template end and the admin will see this in validation.
        const r = resolveNext(node, '');
        if (r.kind === 'end' || r.kind === 'invalid') return { kind: 'end' };
        cursor = r.nodeId;
        continue;
      }
      // status === 'done' — advance past the loop via its `always` rule.
      const r = resolveNext(node, '');
      if (r.kind === 'end') return { kind: 'end' };
      if (r.kind === 'invalid') return { kind: 'node', node, loopContext: null };
      cursor = r.nodeId;
      continue;
    }

    // Top-level (non-loop) nodes use iter=0.
    const ans = answerAt(answers, node.id, 0);
    if (ans === undefined) return { kind: 'node', node, loopContext: null };
    const r = resolveNext(node, ans);
    if (r.kind === 'end') return { kind: 'end' };
    if (r.kind === 'invalid') return { kind: 'node', node, loopContext: null };
    cursor = r.nodeId;
  }
  return { kind: 'end' };
}

type AnswersByIter = Map<string, Map<number, Answer>>;

function answerAt(answers: AnswersByIter, nodeId: string, iter: number): Answer | undefined {
  return answers.get(nodeId)?.get(iter);
}

function groupBodiesByLoop(nodes: TemplateNode[]): Map<string, TemplateNode[]> {
  const out = new Map<string, TemplateNode[]>();
  for (const n of nodes) {
    if (!n.parentNodeId) continue;
    const list = out.get(n.parentNodeId) ?? [];
    list.push(n);
    out.set(n.parentNodeId, list);
  }
  // Sort by position so body entry == lowest-position child.
  for (const [k, list] of out) {
    list.sort((a, b) => a.position - b.position);
    out.set(k, list);
  }
  return out;
}

function loopLabel(node: TemplateNode): string {
  const cfg = node.loopConfig ?? null;
  if (cfg && typeof cfg.label === 'string' && cfg.label.trim()) return cfg.label.trim();
  // Fallback: derive from the question text (often "Applications", "APIs").
  // Strip trailing 's' for a reasonable singular guess; it's only UI copy.
  const fallback = node.question.replace(/\?$/, '').trim() || 'Item';
  return fallback;
}

type BodyWalkResult =
  | { kind: 'unanswered'; node: TemplateNode }
  | { kind: 'body_end' }
  | { kind: 'invalid' };

function walkBody(
  body: TemplateNode[],
  byId: Map<string, TemplateNode>,
  answers: AnswersByIter,
  iter: number,
): BodyWalkResult {
  if (body.length === 0) return { kind: 'body_end' };
  const bodyIds = new Set(body.map((b) => b.id));

  let cursor: string | null = body[0]!.id;
  const visited = new Set<string>();
  while (cursor) {
    if (visited.has(cursor)) return { kind: 'invalid' };
    visited.add(cursor);
    if (!bodyIds.has(cursor)) {
      // Body node pointed outside the body — treat as body end.
      return { kind: 'body_end' };
    }
    const node = byId.get(cursor);
    if (!node) return { kind: 'invalid' };

    const ans = answerAt(answers, node.id, iter);
    if (ans === undefined) return { kind: 'unanswered', node };

    const r = resolveNext(node, ans);
    if (r.kind === 'end') return { kind: 'body_end' };
    if (r.kind === 'invalid') return { kind: 'invalid' };
    cursor = r.nodeId;
  }
  return { kind: 'body_end' };
}

interface DbNode {
  id: string;
  templateId: string;
  tenantId: string;
  question: string;
  helpText: string | null;
  placeholder: string | null;
  required: boolean;
  nodeType: string;
  options: unknown;
  allowFiles: boolean;
  nextRules: unknown;
  position: number;
  parentNodeId: string | null;
  loopConfig: unknown;
}

/** DB row → public TemplateNode. Centralised so every endpoint returns the same shape. */
function toTemplateNode(n: DbNode): TemplateNode {
  return {
    id: n.id,
    templateId: n.templateId,
    tenantId: n.tenantId,
    question: n.question,
    helpText: n.helpText,
    placeholder: n.placeholder,
    required: n.required,
    nodeType: n.nodeType as TemplateNode['nodeType'],
    options: (n.options as TemplateNode['options']) ?? null,
    allowFiles: n.allowFiles,
    nextRules: (n.nextRules as TemplateNode['nextRules']) ?? [],
    position: n.position,
    parentNodeId: n.parentNodeId ?? null,
    loopConfig: (n.loopConfig as LoopConfig | null) ?? null,
  };
}

/** Mask the last octet of an IPv4 (or last group of IPv6) for thread payloads. */
function redactIp(ip: string): string {
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.x`;
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, -1).join(':')}:x`;
  }
  return ip;
}
