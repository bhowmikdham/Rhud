/**
 * AI proposal-draft generator — third user-facing LLM feature, and the
 * one that closes the dead end after approval. Generates a full
 * proposal (executive summary, scope, deliverables, pricing,
 * assumptions, terms placeholder) the rep can copy into an email or
 * PDF tool.
 *
 * Auto mode: drafts in the background after approval, persists onto
 * the engagement, status flips drafting → draft_ready, email fires.
 *
 * Manual mode: returns a copy-pasteable prompt; admin pastes the AI's
 * response back into a separate endpoint that persists + flips status.
 *
 * The Gamma integration (separate ticket) will plug in here as another
 * driver alongside the LLM one — same persistence shape, same status
 * transitions, different generator.
 */

import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { GammaService } from '../gamma/gamma.service.js';
import { GammaTemplateService } from '../gamma/gamma-template.service.js';
import { OutlookService } from '../integrations/outlook/outlook.service.js';
import { LlmService } from './llm.service.js';
import type { ChatMessage } from './llm.types.js';
import type {
  FieldPreviewField,
  FieldPreviewResponse,
  GammaFieldKey,
  GammaTemplate,
  GammaTemplateManifest,
  GenerateDraftRequest,
} from '@rhud/shared';
import {
  nameFromEmail,
  renderScaffold,
  type ScaffoldContext,
} from './proposal-render.js';

const APPROVED_STATUSES = ['approved', 'drafting', 'draft_ready'];

export type ProposalDraftResult =
  | {
      mode: 'auto';
      text: string;
      provider: string;
      draftedAt: string;
    }
  | {
      /** Gamma produced a deck synchronously (rare — most calls return
       *  `gamma_pending` and the frontend polls). */
      mode: 'gamma';
      url: string;
      deckId: string;
      draftedAt: string;
    }
  | {
      /** Gamma generation kicked off; frontend should poll
       *  GET /draft for live phase + completion. */
      mode: 'gamma_pending';
      generationId: string;
    }
  | { mode: 'manual'; prompt: string };

export interface CurrentDraft {
  text: string | null;
  draftedAt: string | null;
  source: string | null;
  status: string;
  /** Populated when source === 'gamma'. */
  gammaDeckUrl: string | null;
  gammaDeckId: string | null;
  /** Live phase string from Gamma when a generation is in flight.
   *  `null` once the deck is ready (or on the LLM/manual paths). */
  gammaPhase: string | null;
  /** Seconds since the Gamma generation kicked off, for "elapsed" UI. */
  gammaElapsedSeconds: number | null;
  /** True when a PDF attachment is available for this draft (Gamma
   *  export not expired, OR text/scaffold draft renderable to PDF
   *  on demand). The UI uses this to decide whether to show the
   *  attachment chip in the Send-to-client modal. */
  proposalPdfAvailable: boolean;
  /** Approximate expiry — Gamma export URLs lapse after ~7 days.
   *  Null means we don't know (e.g. text drafts rendered on demand). */
  proposalPdfExpiresAt: string | null;
}

@Injectable()
export class ProposalDraftService {
  private readonly logger = new Logger(ProposalDraftService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly llm: LlmService,
    private readonly gamma: GammaService,
    private readonly outlook: OutlookService,
    private readonly gammaTemplates: GammaTemplateService,
  ) {}

  // ── Reads ──────────────────────────────────────────────────────────────

  async getCurrent(tenantId: string, engagementId: string): Promise<CurrentDraft> {
    const eng = await this.tenantDb.run(tenantId, async (db) =>
      db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          id: true,
          status: true,
          proposalDraft: true,
          proposalDraftedAt: true,
          proposalDraftSource: true,
          gammaDeckUrl: true,
          gammaDeckId: true,
          gammaGenerationId: true,
          gammaGenerationStartedAt: true,
          proposalPdfUrl: true,
          proposalPdfExpiresAt: true,
        },
      }),
    );
    if (!eng) throw new NotFoundException('engagement_not_found');

    // Live Gamma poll: if there's a generation in flight, ask Gamma
    // where it's at. On completion we persist + flip status here so
    // the next poll cycle returns the final state.
    let gammaPhase: string | null = null;
    let gammaElapsedSeconds: number | null = null;
    if (
      eng.status === 'drafting' &&
      eng.gammaGenerationId &&
      eng.proposalDraftSource === 'gamma'
    ) {
      gammaElapsedSeconds = eng.gammaGenerationStartedAt
        ? Math.floor((Date.now() - eng.gammaGenerationStartedAt.getTime()) / 1000)
        : null;
      try {
        const deck = await this.gamma.pollStatus(tenantId, eng.gammaGenerationId);
        gammaPhase = deck.status ?? null;
        if (deck.status === 'completed' && deck.url) {
          await this.persistGammaDraft(
            tenantId,
            engagementId,
            {
              url: deck.url,
              deckId: deck.generationId,
              ...(deck.exportUrl ? { exportUrl: deck.exportUrl } : {}),
            },
            null, // system actor — no user clicked anything
          );
          // Re-fetch so we return the freshly-persisted row.
          return this.getCurrent(tenantId, engagementId);
        }
        if (deck.status === 'failed') {
          // Async poll path — the pre-draft status isn't recoverable here without
          // persisting it (no column for it), so we fall back to 'approved'. The
          // SYNCHRONOUS re-draft-failure paths (generate's LLM + Gamma-start) DO
          // restore the prior status; only this narrow case (Gamma accepted the
          // job, then the generation failed) can still demote a re-drafted 'sent'.
          await this.rollbackDraftStatus(tenantId, engagementId, 'approved');
          await this.clearGammaTracking(tenantId, engagementId);
          throw new BadGatewayException(`gamma_provider_error: ${deck.error ?? 'unknown'}`);
        }
      } catch (e) {
        // Polling failure isn't fatal — we just don't update the phase
        // this cycle. The next /draft poll will retry. But re-throw on
        // BadGateway (the explicit failure path above) so the UI
        // surfaces it.
        if (e instanceof BadGatewayException) throw e;
        this.logger.warn(
          `gamma poll failed engagement=${engagementId}: ${(e as Error).message}`,
        );
      }
    }

    // PDF availability:
    //   - Gamma drafts: have a stored exportUrl AND we're still inside
    //     Gamma's ~7-day window. Beyond that the URL 403s and the rep
    //     would need to regenerate.
    //   - Text/scaffold drafts: rendered on demand at download time, so
    //     "available" iff there's text. Phase 2 wires this up; for now
    //     we report `false` so the UI omits the attachment chip and the
    //     mailto goes inline.
    const pdfStillFresh =
      !!eng.proposalPdfUrl &&
      (!eng.proposalPdfExpiresAt || eng.proposalPdfExpiresAt.getTime() > Date.now());
    const proposalPdfAvailable =
      eng.proposalDraftSource === 'gamma' ? pdfStillFresh : false;

    return {
      text: eng.proposalDraft,
      draftedAt: eng.proposalDraftedAt?.toISOString() ?? null,
      source: eng.proposalDraftSource,
      status: eng.status,
      gammaDeckUrl: eng.gammaDeckUrl,
      gammaDeckId: eng.gammaDeckId,
      gammaPhase,
      gammaElapsedSeconds,
      proposalPdfAvailable,
      proposalPdfExpiresAt: eng.proposalPdfExpiresAt?.toISOString() ?? null,
    };
  }

  private async clearGammaTracking(tenantId: string, engagementId: string): Promise<void> {
    await this.tenantDb
      .run(tenantId, async (db) => {
        await db.engagement.update({
          where: { id: engagementId },
          data: { gammaGenerationId: null, gammaGenerationStartedAt: null },
        });
      })
      .catch(() => undefined);
  }

  // ── Generate (called from controller OR auto-triggered on approval) ────

  /**
   * Top-level entry point. For manual provider returns the prompt for
   * the UI to copy-paste; for any other provider runs the LLM, persists
   * the draft + flips status, returns the text. `actorId` is null when
   * this is the post-approval auto-trigger (no one clicked anything).
   */
  async generate(
    tenantId: string,
    engagementId: string,
    actorId: string | null,
    body?: GenerateDraftRequest,
  ): Promise<ProposalDraftResult> {
    const ctx = await this.loadContext(tenantId, engagementId);

    // Sanity guard: don't draft for engagements that haven't reached
    // approval. Avoids wasted LLM spend on incomplete scopes.
    if (!APPROVED_STATUSES.includes(ctx.status) && ctx.status !== 'sent') {
      throw new ConflictException(`cannot_draft_from_status:${ctx.status}`);
    }

    // Route by tenant's chosen drafter. Gamma path is its own pipeline
    // (deck generation, polling, URL persistence). Falls back to LLM.
    const driver = await this.gamma.getProposalDriver(tenantId);

    // On the Gamma path, resolve which library deck-template this opportunity
    // uses (explicit override → saved per-opportunity pick → tenant default →
    // freeform). Resolved once so the scaffold and plain branches share it;
    // null ⇒ freeform generation. Decoupled from the questionnaire template.
    const resolvedGamma =
      driver === 'gamma'
        ? await this.resolveGammaTemplate(tenantId, engagementId, body?.gammaTemplateId, true)
        : null;

    // Scaffold short-circuit: when the template carries a proposal
    // scaffold, that's the consultancy explicitly saying "use this
    // exact structure". We render the scaffold + substitute data
    // tokens, then route the result based on driver/provider:
    //   - LLM auto: persist the rendered text directly (no LLM call,
    //     deterministic, free, predictable)
    //   - Gamma:    pass the rendered text as the Gamma prompt so the
    //     deck inherits both layout (template) AND content (scaffold)
    //   - manual:   surface the rendered text as the prompt to copy
    if (ctx.proposalScaffold && ctx.proposalScaffold.trim()) {
      const renderedText = renderScaffold(ctx.proposalScaffold, this.buildScaffoldContext(ctx));

      if (driver === 'gamma') {
        return this.generateViaGamma(tenantId, engagementId, ctx, actorId, resolvedGamma, renderedText);
      }

      const provider = await this.llm.getProviderName(tenantId);
      if (!provider) throw new ServiceUnavailableException('ai_not_configured');

      if (provider === 'manual') {
        // Manual mode + scaffold: the user already controls the text.
        // The "prompt" we hand them is the rendered scaffold itself —
        // they can paste it into ChatGPT to polish, or just paste it
        // back as-is.
        return { mode: 'manual', prompt: renderedText };
      }

      // LLM mode + scaffold: skip the LLM call. Persist verbatim.
      const persisted = await this.persistDraft(tenantId, engagementId, renderedText, 'scaffold', actorId);
      return {
        mode: 'auto',
        text: persisted.text,
        provider: 'scaffold',
        draftedAt: persisted.draftedAt,
      };
    }

    if (driver === 'gamma') {
      return this.generateViaGamma(tenantId, engagementId, ctx, actorId, resolvedGamma);
    }

    const messages = this.buildMessages(ctx);

    const provider = await this.llm.getProviderName(tenantId);
    if (!provider) throw new ServiceUnavailableException('ai_not_configured');

    if (provider === 'manual') {
      // Don't transition status here — wait for the manual-paste call.
      // That way a half-finished manual flow doesn't leave the
      // engagement stuck in `drafting`.
      return { mode: 'manual', prompt: this.flattenForClipboard(messages) };
    }

    // Move to `drafting` while we wait on the LLM. Best-effort — if the
    // status transition fails (e.g. a concurrent mutation) we still try
    // to generate, then patch the final result.
    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagement.updateMany({
        // Re-draftable from draft_ready (regenerate) and sent (re-draft after
        // delivery — the generate guard already allows 'sent'); else the flip
        // matches zero rows and the draft silently never starts.
        where: { id: engagementId, status: { in: ['approved', 'draft_ready', 'sent'] } },
        data: { status: 'drafting' },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_draft_requested',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { provider },
      });
    });

    let result;
    try {
      result = await this.llm.chat(tenantId, messages, {
        // Proposals are long: give the model enough room to produce a
        // multi-section document. 3.5k tokens is comfortable for ~1.5
        // pages of typeset text, plenty for an MVP draft.
        maxTokens: 3_500,
        temperature: 0.5,
        timeoutMs: 90_000,
      });
    } catch (e) {
      // Roll back to the PRIOR status so the rep can retry instead of being stuck
      // in `drafting` (and a re-draft of a 'sent' proposal isn't demoted).
      await this.rollbackDraftStatus(tenantId, engagementId, ctx.status);
      throw new BadGatewayException(`ai_provider_error: ${(e as Error).message}`);
    }

    const text = result.text.trim();
    if (!text) {
      await this.rollbackDraftStatus(tenantId, engagementId, ctx.status);
      throw new BadGatewayException('ai_provider_error: empty_draft');
    }

    const persisted = await this.persistDraft(tenantId, engagementId, text, provider, actorId);
    return {
      mode: 'auto',
      text: persisted.text,
      provider,
      draftedAt: persisted.draftedAt,
    };
  }

  /**
   * Gamma path — flips status to 'drafting', kicks off Gamma's
   * generation, polls until ready, persists the deck URL into the
   * engagement's gamma columns and flips status to 'draft_ready'.
   *
   * No manual-mode here: Gamma either works or it doesn't. If the
   * tenant has Gamma selected as drafter but no API key (or the API
   * is down), generation throws; the caller surfaces that to the UI.
   */
  private async generateViaGamma(
    tenantId: string,
    engagementId: string,
    ctx: Awaited<ReturnType<typeof this.loadContext>>,
    actorId: string | null,
    /** The resolved library deck-template, or null for freeform. Sourced from
     *  the per-opportunity selection (resolveGammaTemplate) — NOT the
     *  questionnaire template. */
    resolved: GammaTemplate | null,
    /** When set, the rendered scaffold replaces the AI-style brief —
     *  Gamma uses this verbatim as the prompt so the deck inherits
     *  whatever structure the consultancy wrote. */
    renderedScaffold?: string,
  ): Promise<ProposalDraftResult> {
    // ATOMIC CLAIM before spending a Gamma credit. Flip the engagement to
    // 'drafting' FIRST; a concurrent double-fire (double-click, or a switch-picker
    // regenerate racing a mid-flight poll) then finds the status already
    // 'drafting' (count 0) and bails, so only ONE call reaches Gamma. Previously
    // Gamma was called before the flip and the updateMany count was ignored, so
    // two calls each spent a credit and last-writer-wins on gammaGenerationId
    // orphaned the first deck. On a Gamma error we roll the status back to where
    // it started, so we never leave a half-flipped 'drafting'.
    const claim = await this.tenantDb.run(tenantId, async (db) =>
      db.engagement.updateMany({
        where: { id: engagementId, status: { in: ['approved', 'draft_ready', 'sent'] } },
        data: { status: 'drafting' },
      }),
    );
    if (claim.count !== 1) throw new ConflictException('draft_already_in_progress');

    // Three-way pick — the Gamma File ID comes from the resolved library entry
    // (the per-opportunity selection), never the questionnaire template:
    //   - rendered scaffold → consultancy wrote the prose; pass it verbatim.
    //     Honour the resolved deck id if any so layout still inherits.
    //   - resolved deck, no scaffold → from-template substitution prompt:
    //     tells Gamma to swap placeholders in their existing deck.
    //   - neither → freeform brief: Gamma generates from scratch.
    const gammaId = resolved?.gammaTemplateId ?? null;
    let brief: { inputText: string; title: string; gammaTemplateId: string | null };
    if (renderedScaffold) {
      brief = {
        inputText: renderedScaffold,
        title: ctx.opportunityName?.trim() || `Proposal — ${ctx.serviceLine}`,
        gammaTemplateId: gammaId,
      };
    } else if (gammaId) {
      brief = this.buildGammaTemplateBrief(ctx, gammaId);
    } else {
      brief = this.buildGammaBrief(ctx);
    }
    // Spend the credit only after winning the claim; release the claim on failure.
    const started = await this.gamma.startDraftFromBrief(tenantId, brief).catch(async (e) => {
      await this.rollbackDraftStatus(tenantId, engagementId, ctx.status);
      throw e;
    });

    // Persist generation tracking (status is already 'drafting' from the claim) +
    // emit. A subsequent GET /draft poll finalises via getCurrent() once ready.
    await this.tenantDb.run(tenantId, async (db) => {
      await db.engagement.updateMany({
        where: { id: engagementId, status: 'drafting' },
        data: {
          proposalDraftSource: 'gamma',
          gammaGenerationId: started.generationId,
          gammaGenerationStartedAt: new Date(),
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_draft_requested',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { driver: 'gamma', generationId: started.generationId },
      });
    });

    return { mode: 'gamma_pending', generationId: started.generationId };
  }

  // ── Gamma template resolution + per-opportunity selection (v2) ─────────────

  /**
   * Resolve which Gamma library deck-template this opportunity's proposal
   * should clone. Order: explicit request override → the saved per-opportunity
   * pick → the tenant default → null (freeform). Cross-tenant or archived ids
   * are never trusted (they fall through), and a resolved default is written
   * back so the choice is sticky. Fully decoupled from the questionnaire
   * template — works for template-less (direct-ingest) opportunities too.
   */
  private async resolveGammaTemplate(
    tenantId: string,
    engagementId: string,
    explicitId?: string,
    /** Only the generate path persists the resolved default back onto the
     *  engagement (making the pick sticky). The field-preview GET resolves
     *  read-only — a GET must not mutate, and persisting on preview would also
     *  make an explicit later choice harder to reason about. */
    persist = false,
  ): Promise<GammaTemplate | null> {
    if (explicitId) {
      const explicit = await this.gammaTemplates.findById(tenantId, explicitId);
      if (explicit && explicit.status === 'active') return explicit;
      // Invalid / foreign / archived explicit id → fall through.
    }

    const saved = await this.tenantDb.run(tenantId, (db) =>
      db.engagement.findUnique({
        where: { id: engagementId },
        select: { selectedGammaTemplateId: true },
      }),
    );
    if (saved?.selectedGammaTemplateId) {
      const selected = await this.gammaTemplates.findById(tenantId, saved.selectedGammaTemplateId);
      if (selected && selected.status === 'active') return selected;
      // Archived/removed selection → fall through to the default (don't clobber
      // the saved id; the FK SET NULLs only on hard delete).
    }

    const fallback = await this.gammaTemplates.getDefault(tenantId);
    // Sticky write-back (generate path only), and only when no pick was saved —
    // the still-null guard in the WHERE means a concurrent explicit pick is
    // never clobbered.
    if (fallback && persist && !saved?.selectedGammaTemplateId) {
      await this.tenantDb.run(tenantId, async (db) => {
        await db.engagement.updateMany({
          where: { id: engagementId, selectedGammaTemplateId: null },
          data: { selectedGammaTemplateId: fallback.id },
        });
      });
    }
    return fallback;
  }

  /**
   * Persist the per-opportunity Gamma template selection (the workspace
   * picker). `null` clears it (→ resolve to default/freeform). Validates
   * ownership + active status so a rep can't point at another tenant's or an
   * archived template.
   */
  async setSelectedTemplate(
    tenantId: string,
    engagementId: string,
    gammaTemplateId: string | null,
  ): Promise<{ selectedGammaTemplateId: string | null }> {
    // Coerce undefined → null so a malformed body (missing field) clears the
    // selection rather than reaching Prisma with `id: undefined` (a 500).
    const next = gammaTemplateId ?? null;
    if (next !== null) {
      const tpl = await this.gammaTemplates.findById(tenantId, next);
      if (!tpl) throw new NotFoundException('gamma_template_not_found');
      if (tpl.status !== 'active') throw new BadRequestException('gamma_template_archived');
    }
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      await db.engagement.update({
        where: { id: engagementId },
        data: { selectedGammaTemplateId: next },
      });
      return { selectedGammaTemplateId: next };
    });
  }

  /**
   * Data behind the per-proposal "Proposal setup" review form: the tenant's
   * template options for the picker, which one this opportunity resolves to,
   * and the computed dynamic field values (with the resolved template's
   * manifest overlaying token/label/default-include). Read-only — no generation.
   */
  async fieldPreview(
    tenantId: string,
    engagementId: string,
    explicitGammaTemplateId?: string,
  ): Promise<FieldPreviewResponse> {
    const ctx = await this.loadContext(tenantId, engagementId);
    const sc = this.buildScaffoldContext(ctx);
    const resolved = await this.resolveGammaTemplate(tenantId, engagementId, explicitGammaTemplateId);
    const templates = (await this.gammaTemplates.list(tenantId)).map((t) => ({
      id: t.id,
      label: t.label,
      isDefault: t.isDefault,
      serviceLine: t.serviceLine,
      format: t.format,
    }));
    const manifest = resolved?.manifest ?? null;
    return {
      templates,
      resolvedTemplateId: resolved?.id ?? null,
      fields: this.buildFieldPreviewRows(sc, manifest),
      lockedSections: manifest?.lockedSections ?? [],
    };
  }

  /** Map the computed scaffold context to field-preview rows, overlaying any
   *  manifest field (token/label/default-include) the resolved template
   *  declares. */
  private buildFieldPreviewRows(
    sc: ScaffoldContext,
    manifest: GammaTemplateManifest | null,
  ): FieldPreviewField[] {
    const catalog: Array<{ key: GammaFieldKey; label: string; value: string }> = [
      { key: 'clientName', label: 'Client name', value: sc.clientName },
      { key: 'clientEmail', label: 'Client email', value: sc.clientEmail },
      { key: 'opportunityName', label: 'Opportunity', value: sc.opportunityName ?? '' },
      { key: 'serviceLine', label: 'Service line', value: sc.serviceLine },
      { key: 'tenantName', label: 'Consultancy', value: sc.tenantName },
      { key: 'investment', label: 'Investment', value: sc.priceFormatted },
      { key: 'date', label: 'Date', value: sc.dateToday },
      { key: 'lineItems', label: 'Priced line items', value: sc.lineItems },
      { key: 'scopeSummary', label: 'Confirmed scope', value: sc.scopeSummary },
    ];
    const byKey = new Map((manifest?.fields ?? []).map((f) => [f.fieldKey, f]));
    return catalog.map((c) => {
      const m = byKey.get(c.key);
      return {
        fieldKey: c.key,
        label: m?.label ?? c.label,
        token: m?.token ?? null,
        computedValue: c.value,
        include: m ? m.defaultInclude : true,
      };
    });
  }

  /** Manual-mode follow-up: admin pasted the AI's response back. */
  async acceptManual(
    tenantId: string,
    engagementId: string,
    actorId: string,
    text: string,
  ): Promise<{ text: string; draftedAt: string }> {
    const trimmed = text.trim();
    if (!trimmed) throw new BadRequestException('text_required');
    return this.persistDraft(tenantId, engagementId, trimmed, 'manual', actorId);
  }

  /** Drop the current draft so the rep can regenerate from scratch. */
  async clear(tenantId: string, engagementId: string, actorId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, status: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      // Roll status back to `approved` so a re-generate goes through
      // the normal happy path.
      const targetStatus = eng.status === 'sent' ? 'sent' : 'approved';
      await db.engagement.update({
        where: { id: engagementId },
        data: {
          proposalDraft: null,
          proposalDraftedAt: null,
          proposalDraftSource: null,
          gammaDeckUrl: null,
          gammaDeckId: null,
          gammaGenerationId: null,
          gammaGenerationStartedAt: null,
          status: targetStatus,
        },
      });
      this.logger.log(`draft cleared engagement=${engagementId} actor=${actorId}`);
    });
  }

  /**
   * Bookkeeping-only "I already sent it via my own email" path. Flips
   * status, records the audit event, AND dispatches the team-facing
   * `proposal_sent` notification (so the rest of the team knows the
   * deal moved). Does NOT email the client — `sendToClient` is the
   * path for that.
   *
   * Until this commit, dispatchAfterCommit was missing here, so the
   * thread event was recorded silently. Emails now actually fire.
   */
  async markSent(tenantId: string, engagementId: string, actorId: string): Promise<{ status: string }> {
    const result = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          id: true, status: true, proposalDraft: true, clientEmail: true,
          gammaDeckUrl: true,
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      if (!eng.proposalDraft) throw new BadRequestException('no_draft_to_send');
      if (eng.status === 'sent') return { status: 'sent' as const, payload: null };

      await db.engagement.update({
        where: { id: engagementId },
        data: { status: 'sent' },
      });
      const payload = {
        clientEmail: eng.clientEmail,
        // proposalUrl is the deck link for Gamma drafts; absent for text.
        ...(eng.gammaDeckUrl ? { proposalUrl: eng.gammaDeckUrl } : {}),
        // Tell the email template who-sent-what so it can adapt copy.
        deliveryMode: 'self_reported' as const,
      };
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_sent',
        actorType: 'user',
        actorId,
        payload,
      });
      return { status: 'sent' as const, payload };
    });

    if (result.payload) {
      void this.thread.dispatchAfterCommit(tenantId, {
        engagementId,
        eventType: 'proposal_sent',
        actorType: 'user',
        actorId,
        payload: result.payload,
      });
    }
    return { status: result.status };
  }

  /**
   * Send the proposal email from the rep's connected Outlook mailbox.
   *
   *   1. Validate state (draft exists, not already sent).
   *   2. Fetch the PDF bytes server-side from Gamma's cached export URL.
   *      Per Gamma's docs the URL is presigned and ~7 days valid.
   *   3. Hand off to OutlookService — token refresh, sendMail call,
   *      retry-on-401-once happen there.
   *   4. Flip status to 'sent' and emit the team-side notification.
   *
   * Throws:
   *   - 404 engagement_not_found / no_draft_to_send
   *   - 409 already_sent
   *   - 503 outlook_not_configured (env vars missing)
   *   - 401 outlook_reconnect_required (refresh failed)
   *   - 502 outlook_send_failed:<reason>
   */
  async sendViaOutlook(
    tenantId: string,
    engagementId: string,
    actorId: string,
    args: { subject: string; body: string },
  ): Promise<{ status: string; recipientEmail: string; sentFrom: string }> {
    if (!args.subject?.trim()) throw new BadRequestException('subject_required');
    if (!args.body?.trim()) throw new BadRequestException('body_required');

    const eng = await this.tenantDb.run(tenantId, async (db) =>
      db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          id: true, status: true, clientEmail: true,
          proposalDraft: true, proposalDraftSource: true,
          gammaDeckUrl: true, proposalPdfUrl: true, proposalPdfExpiresAt: true,
        },
      }),
    );
    if (!eng) throw new NotFoundException('engagement_not_found');
    if (!eng.proposalDraft) throw new BadRequestException('no_draft_to_send');
    if (eng.status === 'sent') throw new ConflictException('already_sent');

    // Fetch PDF bytes for the attachment. Optional — text drafts and
    // expired Gamma exports send without an attachment (the UI warns
    // about this in the modal). Failures while fetching are
    // logged-and-skipped rather than blocking the send.
    let attachment: { filename: string; contentType: string; bytes: Buffer } | undefined;
    const pdfFresh =
      eng.proposalPdfUrl &&
      (!eng.proposalPdfExpiresAt || eng.proposalPdfExpiresAt.getTime() > Date.now());
    if (pdfFresh && eng.proposalPdfUrl) {
      try {
        const pdfRes = await fetch(eng.proposalPdfUrl);
        if (pdfRes.ok) {
          const ab = await pdfRes.arrayBuffer();
          // Microsoft Graph caps inline file attachments at ~3 MB. Above
          // that you need the upload-session API. Skip silently — the
          // rep can fall back to the deck link in the body. Log so we
          // know if this becomes common.
          if (ab.byteLength <= 3 * 1024 * 1024) {
            attachment = {
              filename: 'Proposal.pdf',
              contentType: 'application/pdf',
              bytes: Buffer.from(ab),
            };
          } else {
            this.logger.warn(
              `pdf too large for inline attachment engagement=${engagementId} bytes=${ab.byteLength}`,
            );
          }
        } else {
          this.logger.warn(
            `pdf fetch ${pdfRes.status} engagement=${engagementId} url=${eng.proposalPdfUrl.slice(0, 80)}`,
          );
        }
      } catch (e) {
        this.logger.warn(`pdf fetch threw engagement=${engagementId}: ${(e as Error).message}`);
      }
    }

    // Atomically CLAIM the send BEFORE the irreversible sendMail, so two
    // concurrent calls (rep double-clicks "Send to client", or a retried request)
    // can't both email the client. The early `status === 'sent'` guard above is a
    // fast pre-check inside a separate read txn — only this conditional updateMany
    // is the real mutual-exclusion (mirrors gathering.submit's claim pattern). The
    // loser sees status already 'sent' (count 0) → 409. If the send then fails we
    // roll the status back so the rep can retry.
    const priorStatus = eng.status;
    const claim = await this.tenantDb.run(tenantId, async (db) =>
      db.engagement.updateMany({
        where: { id: engagementId, status: { not: 'sent' } },
        data: { status: 'sent' },
      }),
    );
    if (claim.count !== 1) throw new ConflictException('already_sent');

    let sentFrom: string;
    try {
      const sendRes = await this.outlook.sendMail(tenantId, actorId, {
        to: eng.clientEmail,
        subject: args.subject,
        body: args.body,
        ...(attachment && { attachment }),
      });
      sentFrom = sendRes.accountEmail;
    } catch (e) {
      // Send failed — RELEASE the claim so the rep can retry (no phantom 'sent').
      await this.tenantDb
        .run(tenantId, async (db) =>
          db.engagement.updateMany({
            where: { id: engagementId, status: 'sent' },
            data: { status: priorStatus },
          }),
        )
        .catch(() => undefined);
      // UnauthorizedException (outlook_reconnect_required) and
      // ServiceUnavailableException (outlook_not_configured) carry the
      // right HTTP semantics — propagate without wrapping. Anything
      // else becomes a 502 so the UI can show "Outlook returned X."
      const message = (e as Error).message ?? 'outlook_send_failed';
      if (
        message.includes('outlook_reconnect_required') ||
        message.includes('outlook_not_configured') ||
        message.includes('outlook_not_connected')
      ) {
        throw e;
      }
      throw new BadGatewayException(`outlook_send_failed: ${message}`);
    }

    // Flip status + emit. Same shape markSent uses, but with a
    // deliveryMode that distinguishes "rep's Outlook sent it" from
    // "rep manually emailed and clicked I've sent it."
    const payload = {
      clientEmail: eng.clientEmail,
      deliveryMode: 'outlook' as const,
      sentFrom,
      ...(eng.gammaDeckUrl ? { proposalUrl: eng.gammaDeckUrl } : {}),
    };
    // Status was already flipped to 'sent' by the atomic claim above — just emit.
    await this.tenantDb.run(tenantId, async (db) => {
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_sent',
        actorType: 'user',
        actorId,
        payload,
      });
    });
    void this.thread.dispatchAfterCommit(tenantId, {
      engagementId,
      eventType: 'proposal_sent',
      actorType: 'user',
      actorId,
      payload,
    });

    return { status: 'sent', recipientEmail: eng.clientEmail, sentFrom };
  }

  /**
   * Resolve the current proposal's PDF attachment URL.
   *
   * For Gamma drafts: returns the cached export URL if it's still
   * inside Gamma's ~7-day expiry. After expiry the rep must regenerate
   * (Gamma's API doesn't support re-export of an existing generation).
   *
   * For text/scaffold drafts: phase 1 has no on-demand PDF rendering,
   * so this returns null and the Send-to-client modal omits the
   * attachment chip + falls back to inlining the body in the mailto.
   */
  async getPdfUrl(
    tenantId: string,
    engagementId: string,
  ): Promise<{ url: string; expiresAt: string } | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          proposalDraftSource: true,
          proposalPdfUrl: true,
          proposalPdfExpiresAt: true,
        },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      if (eng.proposalDraftSource !== 'gamma' || !eng.proposalPdfUrl) return null;
      // Treat unknown expiry as fresh — better to redirect and 403
      // than silently hide an otherwise-working URL.
      if (eng.proposalPdfExpiresAt && eng.proposalPdfExpiresAt.getTime() < Date.now()) {
        return null;
      }
      return {
        url: eng.proposalPdfUrl,
        expiresAt: eng.proposalPdfExpiresAt?.toISOString() ?? '',
      };
    });
  }

  // ── Auto-trigger entry point — fire-and-forget on approval ─────────────

  /**
   * Called from prediction.controller.ts on approve (and never throws —
   * an approval shouldn't fail because drafting failed). Skips
   * silently for manual-provider tenants since they have to drive the
   * UI flow themselves.
   */
  async tryAutoGenerateAfterApproval(tenantId: string, engagementId: string, actorId: string): Promise<void> {
    try {
      const provider = await this.llm.getProviderName(tenantId);
      if (!provider || provider === 'manual') return;
      await this.generate(tenantId, engagementId, actorId);
    } catch (e) {
      this.logger.warn(
        `auto draft after approval failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async persistDraft(
    tenantId: string,
    engagementId: string,
    text: string,
    source: string,
    actorId: string | null,
  ): Promise<{ text: string; draftedAt: string }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const now = new Date();
      const updated = await db.engagement.update({
        where: { id: engagementId },
        data: {
          proposalDraft: text,
          proposalDraftedAt: now,
          proposalDraftSource: source,
          status: 'draft_ready',
        },
        select: { proposalDraft: true, proposalDraftedAt: true, clientEmail: true },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_draft_ready',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { source, characterCount: text.length },
      });
      // Best-effort email — fire-and-forget so a transport blip doesn't
      // block the persist.
      void this.thread.dispatchAfterCommit(tenantId, {
        engagementId,
        eventType: 'proposal_draft_ready',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { source, clientEmail: updated.clientEmail },
      });
      return {
        text: updated.proposalDraft ?? text,
        draftedAt: (updated.proposalDraftedAt ?? now).toISOString(),
      };
    });
  }

  private async persistGammaDraft(
    tenantId: string,
    engagementId: string,
    deck: { url: string; deckId: string; exportUrl?: string },
    actorId: string | null,
  ): Promise<{ url: string; deckId: string; draftedAt: string }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const now = new Date();
      // Gamma export URLs lapse after ~7 days per the public docs.
      // Be conservative — record 6 days from now so a rep doesn't
      // hand the client a dead link if they wait until the last
      // moment to send.
      const pdfExpiresAt = deck.exportUrl
        ? new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000)
        : null;
      const updated = await db.engagement.update({
        where: { id: engagementId },
        data: {
          // Mirror the URL into proposalDraft so anywhere that just
          // checks "is there a draft?" doesn't need Gamma-specific logic.
          // The full URL is also pinned to its own column for richer UI.
          proposalDraft: deck.url,
          proposalDraftedAt: now,
          proposalDraftSource: 'gamma',
          gammaDeckUrl: deck.url,
          gammaDeckId: deck.deckId,
          // Clear the in-flight tracking — generation is done.
          gammaGenerationId: null,
          gammaGenerationStartedAt: null,
          proposalPdfUrl: deck.exportUrl ?? null,
          proposalPdfExpiresAt: pdfExpiresAt,
          status: 'draft_ready',
        },
        select: { proposalDraftedAt: true, gammaDeckUrl: true, gammaDeckId: true, clientEmail: true },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'proposal_draft_ready',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { source: 'gamma', deckId: deck.deckId, deckUrl: deck.url },
      });
      void this.thread.dispatchAfterCommit(tenantId, {
        engagementId,
        eventType: 'proposal_draft_ready',
        actorType: actorId ? 'user' : 'system',
        actorId,
        payload: { source: 'gamma', clientEmail: updated.clientEmail, deckUrl: deck.url },
      });
      return {
        url: updated.gammaDeckUrl ?? deck.url,
        deckId: updated.gammaDeckId ?? deck.deckId,
        draftedAt: (updated.proposalDraftedAt ?? now).toISOString(),
      };
    });
  }

  /** Brief for Gamma — shorter than the LLM prompt because Gamma does
   *  its own structuring. We give it a clear topic + scope + price + a
   *  rough section list and let the deck generator do the layout. */
  /** Distil the load-context into the small bag of fields the scaffold
   *  renderer consumes. Pure — no DB / IO. */
  private buildScaffoldContext(ctx: Awaited<ReturnType<typeof this.loadContext>>): ScaffoldContext {
    const fmtMoney = (cents: number) =>
      `${ctx.currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const finalPrice = ctx.approvedPriceCents ?? ctx.baseTotalCents;

    const lineItems = (ctx.baseBreakdown ?? [])
      .map((l) => `- **${l.serviceLineName}** — ${l.scopeValue} ${l.scopeUnit} → ${fmtMoney(l.priceCents)}`)
      .join('\n');

    const scopeSummary = ctx.answers
      .slice(0, 25)
      .map((a) => `- **${a.question}** — ${this.summariseAnswer(a.value)}`)
      .join('\n');

    // Locale-stable date format — picks the language of the runtime
    // but the shape "27 Apr 2026" reads the same everywhere.
    const dateToday = new Date().toLocaleDateString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    return {
      clientEmail: ctx.clientEmail,
      clientName: nameFromEmail(ctx.clientEmail),
      opportunityName: ctx.opportunityName,
      tenantName: ctx.tenantName,
      serviceLine: ctx.serviceLine,
      templateName: ctx.templateName,
      priceFormatted: fmtMoney(finalPrice),
      currency: ctx.currency,
      dateToday,
      scopeSummary,
      lineItems,
    };
  }

  private buildGammaBrief(ctx: Awaited<ReturnType<typeof this.loadContext>>): {
    inputText: string;
    title: string;
    gammaTemplateId: string | null;
  } {
    const fmtMoney = (cents: number) =>
      `${ctx.currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const finalPrice = ctx.approvedPriceCents ?? ctx.baseTotalCents;

    const lineItems = (ctx.baseBreakdown ?? [])
      .map((l) => `- ${l.serviceLineName}: ${l.scopeValue} ${l.scopeUnit}`)
      .join('\n');
    const answers = ctx.answers
      .slice(0, 15)
      .map((a) => `- ${a.question}: ${this.summariseAnswer(a.value)}`)
      .join('\n');

    const title = ctx.opportunityName?.trim() || `Proposal — ${ctx.serviceLine}`;

    const inputText =
      `Audience: ${ctx.clientEmail}\n` +
      `Vendor: ${ctx.tenantName}\n` +
      `Service line: ${ctx.serviceLine}\n` +
      `Investment: ${fmtMoney(finalPrice)}\n\n` +
      `Build a client-ready proposal deck with these sections:\n` +
      `1. Executive summary\n` +
      `2. Scope of work\n` +
      `3. Approach & methodology\n` +
      `4. Indicative timeline (phases)\n` +
      `5. Investment\n` +
      `6. Assumptions\n` +
      `7. Next steps\n\n` +
      (lineItems ? `Confirmed scope items:\n${lineItems}\n\n` : '') +
      (answers ? `Client-confirmed scope details:\n${answers}\n\n` : '') +
      `Tone: professional, confident, concise. No filler. ` +
      `Use "you" voice toward the client. Investment slide should reference the price once.`;

    return { inputText, title, gammaTemplateId: null };
  }

  /**
   * Substitution-style prompt for Gamma's `/generations/from-template`.
   *
   * The freeform brief above tells Gamma to *build* a deck — wrong shape
   * for from-template, where the template already exists and we want
   * Gamma to *adapt* it. Per Gamma's docs the from-template prompt is
   * an instruction surface for content swap / variable replacement /
   * audience retargeting; the layout, theme, and section order all
   * come from the source deck.
   *
   * No title wrapping (`# {title}\n\n…`) here — the template carries
   * its own title; injecting one would just confuse the model.
   */
  private buildGammaTemplateBrief(
    ctx: Awaited<ReturnType<typeof this.loadContext>>,
    gammaTemplateId: string,
  ): {
    inputText: string;
    title: string;
    gammaTemplateId: string;
  } {
    const fmtMoney = (cents: number) =>
      `${ctx.currency} ${(cents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const finalPrice = ctx.approvedPriceCents ?? ctx.baseTotalCents;
    const clientName = nameFromEmail(ctx.clientEmail);
    const dateToday = new Date().toLocaleDateString(undefined, {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    const lineItems = (ctx.baseBreakdown ?? [])
      .map((l) => `- ${l.serviceLineName}: ${l.scopeValue} ${l.scopeUnit} (${fmtMoney(l.priceCents)})`)
      .join('\n');
    const scopeAnswers = ctx.answers
      .slice(0, 20)
      .map((a) => `- ${a.question}: ${this.summariseAnswer(a.value)}`)
      .join('\n');

    const title = ctx.opportunityName?.trim() || `Proposal — ${ctx.serviceLine}`;

    const inputText =
      `Adapt this proposal template for a new client. Keep the existing ` +
      `layout, theme, design, and section order. Replace placeholder text ` +
      `and example content with the values below. Do not add new sections.\n\n` +
      `CLIENT NAME: ${clientName}\n` +
      `CLIENT EMAIL: ${ctx.clientEmail}\n` +
      `OPPORTUNITY: ${title}\n` +
      `CONSULTANCY: ${ctx.tenantName}\n` +
      `SERVICE LINE: ${ctx.serviceLine}\n` +
      `INVESTMENT: ${fmtMoney(finalPrice)}\n` +
      `DATE: ${dateToday}\n\n` +
      (lineItems
        ? `PRICED LINE ITEMS (use these in any scope/pricing breakdown):\n${lineItems}\n\n`
        : '') +
      (scopeAnswers
        ? `CONFIRMED SCOPE FROM CLIENT (ground the scope/deliverables/assumptions ` +
          `sections in these — do not invent details the client didn't confirm):\n${scopeAnswers}\n\n`
        : '') +
      `Where the template references a previous client by name, swap to "${clientName}". ` +
      `Where it has a price, swap to ${fmtMoney(finalPrice)}. Where it shows a date, ` +
      `swap to ${dateToday}. Maintain the consultancy's existing tone and brand voice.`;

    return { inputText, title, gammaTemplateId };
  }

  /** Release a `drafting` claim back to the status the engagement had BEFORE the
   *  draft started. Restoring the prior status (not a hardcoded 'approved') is
   *  what stops a failed re-draft of an already-`sent` proposal from silently
   *  demoting it to 'approved'. Only flips rows still in 'drafting' (a concurrent
   *  finalise that already advanced the status is left alone). Best-effort. */
  private async rollbackDraftStatus(
    tenantId: string,
    engagementId: string,
    priorStatus: string,
  ): Promise<void> {
    await this.tenantDb
      .run(tenantId, async (db) => {
        await db.engagement.updateMany({
          where: { id: engagementId, status: 'drafting' },
          data: { status: priorStatus },
        });
      })
      .catch(() => undefined);
  }

  private async loadContext(tenantId: string, engagementId: string) {
    return this.tenantDb.run(tenantId, async (db) => {
      const engagement = await db.engagement.findUnique({
        where: { id: engagementId },
        include: { template: { select: { name: true, serviceLine: true, proposalScaffold: true } } },
      });
      if (!engagement) throw new NotFoundException('engagement_not_found');

      const quote = await db.engagementQuote.findFirst({
        where: { engagementId },
        orderBy: { computedAt: 'desc' },
      });
      if (!quote) throw new NotFoundException('quote_not_found');

      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });

      const answers = await db.engagementAnswer.findMany({
        where: { engagementId },
        orderBy: { answeredAt: 'asc' },
        take: 40,
      });
      const nodeIds = answers.map((a) => a.nodeId);
      const nodes = nodeIds.length
        ? await db.templateNode.findMany({
            where: { id: { in: nodeIds } },
            select: { id: true, question: true },
          })
        : [];
      const questionByNodeId = new Map(nodes.map((n) => [n.id, n.question]));

      // Direct-ingest opportunities (docs/direct-ingest.md §3.2) may not
      // have a template attached. In that case we fall back to engagement
      // name + classifier-set categorySlug for context, and skip the
      // scaffold path entirely. The LLM-synthesis path still works on
      // extracted points + assumptions/exclusions.
      const tmpl = engagement.template;
      return {
        status: engagement.status,
        clientEmail: engagement.clientEmail,
        opportunityName: engagement.name,
        // Falls back to the opportunity name (and ultimately a generic
        // label) so the proposal still has *something* to call this
        // engagement in headings.
        templateName: tmpl?.name ?? engagement.name ?? '(Untitled)',
        // Without a template the classifier-set category is the best
        // hint at service line. Surface that when available; otherwise
        // a generic label that won't show up in customer-visible copy.
        serviceLine: tmpl?.serviceLine ?? engagement.categorySlug ?? 'Engagement',
        proposalScaffold: tmpl?.proposalScaffold ?? null,
        tenantName: tenant?.name ?? 'Our team',
        currency: quote.currency,
        baseTotalCents: Number(quote.baseTotalCents),
        approvedPriceCents:
          engagement.approvedPriceCents != null ? Number(engagement.approvedPriceCents) : null,
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

    const lineItems = (ctx.baseBreakdown ?? [])
      .map(
        (l) =>
          `  • ${l.serviceLineName} — ${l.scopeValue} ${l.scopeUnit} → ${fmtMoney(l.priceCents)}`,
      )
      .join('\n');

    const answers = ctx.answers
      .slice(0, 25)
      .map((a) => `  • ${a.question}: ${this.summariseAnswer(a.value)}`)
      .join('\n');

    const finalPrice = ctx.approvedPriceCents ?? ctx.baseTotalCents;

    const system =
      'You write client-ready proposal drafts for a B2B services consultancy. ' +
      'Output a single Markdown document with these sections, in this order:\n\n' +
      '  # Proposal — <client name or company>\n' +
      '  ## Executive Summary       (3-4 sentences, "you" voice, problem + outcome)\n' +
      '  ## Scope of Work           (bulleted, references the confirmed scope)\n' +
      '  ## Deliverables            (bulleted, what the client receives)\n' +
      '  ## Approach & Methodology  (1 short paragraph + bullets if needed)\n' +
      '  ## Indicative Timeline     (rough phases — Discovery, Execution, Reporting)\n' +
      '  ## Investment              (the agreed price as a single line; reference the breakdown if useful)\n' +
      '  ## Assumptions             (bulleted; what would invalidate the price)\n' +
      '  ## Next Steps              (1-2 sentences inviting acceptance)\n\n' +
      'Tone: professional, confident, concise. No throat-clearing ("We are pleased to..."). ' +
      'Avoid filler and corporate jargon. Length target: 400-700 words. ' +
      'Do NOT wrap the document in code fences. Output Markdown directly.';

    const user =
      `Compose a proposal draft for the following engagement.\n\n` +
      `Consultancy: ${ctx.tenantName}\n` +
      `Client (email): ${ctx.clientEmail}\n` +
      (ctx.opportunityName ? `Opportunity name: ${ctx.opportunityName}\n` : '') +
      `Service line: ${ctx.serviceLine}\n` +
      `Template used: ${ctx.templateName}\n` +
      `Approved price: ${fmtMoney(finalPrice)}\n` +
      (lineItems ? `\nPriced line items (do NOT itemise these in the proposal — use them only to ground "Scope of Work" and "Investment"):\n${lineItems}\n` : '') +
      (answers ? `\nClient-confirmed scope (for fidelity in Scope of Work + Assumptions):\n${answers}\n` : '') +
      `\nWrite the proposal now.`;

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  private summariseAnswer(value: unknown): string {
    if (value == null) return '—';
    if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.slice(0, 8).map(String).join(', ');
    try {
      return JSON.stringify(value).slice(0, 200);
    } catch {
      return '(complex value)';
    }
  }

  private flattenForClipboard(messages: ChatMessage[]): string {
    const sys = messages.find((m) => m.role === 'system')?.content ?? '';
    const usr = messages.find((m) => m.role === 'user')?.content ?? '';
    return `=== Instructions ===\n${sys}\n\n=== Task ===\n${usr}\n`;
  }
}
