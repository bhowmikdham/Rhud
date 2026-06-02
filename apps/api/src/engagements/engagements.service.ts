import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { hashToken, mintToken } from '../gathering/token.util.js';
import type { CreateEngagementDto } from './dto.js';
import type { EngagementSource } from '@rhud/shared';

export interface IssuedLink {
  engagementId: string;
  token: string;          // plaintext — shown ONCE in the issuance response
  url: string;            // full link to send the client
  expiresAt: string;      // ISO 8601
}

export interface EngagementSummary {
  id: string;
  /** NULL on direct-ingest opportunities until a template is attached.
   *  See docs/direct-ingest.md §3.2. */
  templateId: string | null;
  /** NULL on direct-ingest opportunities (no template → no template name).
   *  UI falls back to the engagement `name` for display. */
  templateName: string | null;
  /** Rate card attached DIRECTLY to this opportunity (independent of any
   *  template). NULL when none is directly attached — the signal the UI
   *  uses to offer "attach a rate card" on a template-less opportunity.
   *  The EFFECTIVE pricing card is rateCardId ?? the template's binding. */
  rateCardId: string | null;
  rateCardName: string | null;
  /** How this engagement entered Rhud. See @rhud/shared EngagementSource. */
  source: string;
  /** User-facing label ("Acme Q3 Security Assessment"). Null on legacy rows. */
  name: string | null;
  clientEmail: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  /** ML predicted price (cents). Null until a price_predicted event fires. */
  predictedPriceCents: number | null;
  priceLowCents: number | null;
  priceHighCents: number | null;
  /**
   * ISO 4217 code (INR / USD / EUR / GBP). Resolved from the engagement
   * quote when one exists, otherwise null. Frontend uses this to format
   * the price tag with the right symbol — without it we'd guess wrong on
   * mixed-currency tenants.
   */
  currency: string | null;
  /** Phase A — reviewer-fillable scope fields. Surfaced on detail page
   *  and on the printed proposal. Null until a reviewer touches them. */
  assumptions: string | null;
  exclusions: string | null;
  deliveryTimelineOverride: string | null;
  /** Phase B — classification + auto-assigned reviewer. Null until the
   *  classifier runs (auto on submit; manual via the chip). */
  categorySlug: string | null;
  subCategorySlug: string | null;
  classifiedBy: 'llm' | 'manual' | null;
  classifiedAt: string | null;
  assignedReviewerId: string | null;
  /** Phase C — full client metadata. All nullable; rep can fill in
   *  at issuance or any time after via PATCH /opportunities/:id/client. */
  clientName: string | null;
  clientAddress: string | null;
  contactName: string | null;
  contactPhone: string | null;
}

/**
 * Engagements live at the centre of the workflow. This service:
 *   - issues a new engagement + tokenised link in a single transaction
 *     (engagement row, token row, and the `link_issued` thread event are
 *     all atomic — no partially-issued state),
 *   - lists engagements for a sales user,
 *   - fetches a single engagement with its current state.
 *
 * The runtime tenant role enforces RLS, so even a buggy controller asking
 * for the wrong engagement_id will get a 404 rather than a leak.
 */
@Injectable()
export class EngagementsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  async issue(args: {
    tenantId: string;
    salesEmployeeId: string;
    dto: CreateEngagementDto;
    publicBaseUrl: string;
  }): Promise<IssuedLink> {
    const expiresInDays = args.dto.expiresInDays ?? 7;

    const { engagement, mint } = await this.tenantDb.run(args.tenantId, async (db) => {
      // Pull the template inside the same transaction (RLS scopes it to this tenant).
      const tmpl = await db.template.findUnique({
        where: { id: args.dto.templateId },
        select: { id: true, version: true, status: true },
      });
      if (!tmpl) throw new NotFoundException('template_not_found');
      if (tmpl.status !== 'published') {
        throw new BadRequestException('template_not_published');
      }

      const created = await db.engagement.create({
        data: {
          tenantId: args.tenantId,
          templateId: tmpl.id,
          templateVersion: tmpl.version,
          source: 'manual_form',
          salesEmployeeId: args.salesEmployeeId,
          ...(args.dto.salesManagerId ? { salesManagerId: args.dto.salesManagerId } : {}),
          clientEmail: args.dto.clientEmail,
          ...(args.dto.name ? { name: args.dto.name } : {}),
          // Phase C — optional client metadata captured at issuance.
          ...(args.dto.clientName?.trim()    ? { clientName:    args.dto.clientName.trim() }    : {}),
          ...(args.dto.clientAddress?.trim() ? { clientAddress: args.dto.clientAddress.trim() } : {}),
          ...(args.dto.contactName?.trim()   ? { contactName:   args.dto.contactName.trim() }   : {}),
          ...(args.dto.contactPhone?.trim()  ? { contactPhone:  args.dto.contactPhone.trim() }  : {}),
          status: 'issued',
        },
      });

      // Shared mint + event helper. emits `link_issued` for the first
      // token, `link_reissued` for subsequent ones — see helper docs.
      const m = await this.mintGatheringTokenWithin(db, {
        tenantId: args.tenantId,
        engagementId: created.id,
        actorId: args.salesEmployeeId,
        expiresInDays,
        // First link on a brand-new engagement — payload mirrors the
        // legacy shape so downstream consumers (notifications,
        // dashboards) still see clientEmail + expiresAt on link_issued.
        legacyLinkIssuedPayload: {
          clientEmail: args.dto.clientEmail,
          expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
        },
      });

      return { engagement: created, mint: m };
    });

    // Post-commit: fan out notifications. Fire-and-forget — failures are
    // logged inside the dispatcher and don't fail the request.
    void this.thread.dispatchAfterCommit(args.tenantId, {
      engagementId: engagement.id,
      eventType: 'link_issued',
      actorType: 'user',
      actorId: args.salesEmployeeId,
      payload: {
        clientEmail: args.dto.clientEmail,
        expiresAt: mint.expiresAt.toISOString(),
      },
    });

    return {
      engagementId: engagement.id,
      token: mint.token,
      url: `${args.publicBaseUrl.replace(/\/$/, '')}/g/${mint.token}`,
      expiresAt: mint.expiresAt.toISOString(),
    };
  }

  /**
   * Create a bare engagement from an ingested artifact (no template,
   * no gathering token). Called by IngestionService.promote() once the
   * artifact lifecycle has reached the point where an opportunity
   * should materialise — typically immediately for the in-app paste/
   * drop UI, later (after rep review) for inbound webhooks.
   *
   * The engagement starts at status='ingesting'; extraction runs over
   * its attached files and transitions to 'submitted' when every file
   * is ready (mirrors the post-link-share flow).
   *
   * See docs/direct-ingest.md §4.2.
   */
  async createFromIngest(args: {
    tenantId: string;
    salesEmployeeId: string;
    source: EngagementSource;
    clientEmail: string;
    client?: {
      clientName?: string | null;
      clientAddress?: string | null;
      contactName?: string | null;
      contactPhone?: string | null;
    };
    /** External intermediary (channel partner / distributor). Optional. */
    partner?: {
      company?: string | null;
      contact?: string | null;
      email?: string | null;
      role?: 'partner' | 'distributor' | null;
    };
    /** The "primary" IngestionArtifact id — back-pointer field on the
     *  Engagement row. NULL for opportunities created entirely by the
     *  UI without a single dominant artifact (rare in practice). */
    ingestionId?: string;
    name?: string;
  }): Promise<{ engagementId: string }> {
    const created = await this.tenantDb.run(args.tenantId, async (db) => {
      return db.engagement.create({
        data: {
          tenantId: args.tenantId,
          // templateId + templateVersion intentionally null — direct-ingest.
          source: args.source,
          salesEmployeeId: args.salesEmployeeId,
          clientEmail: args.clientEmail,
          status: 'ingesting',
          ...(args.name ? { name: args.name } : {}),
          ...(args.ingestionId ? { ingestionId: args.ingestionId } : {}),
          ...(args.client?.clientName?.trim()    ? { clientName:    args.client.clientName.trim() }    : {}),
          ...(args.client?.clientAddress?.trim() ? { clientAddress: args.client.clientAddress.trim() } : {}),
          ...(args.client?.contactName?.trim()   ? { contactName:   args.client.contactName.trim() }   : {}),
          ...(args.client?.contactPhone?.trim()  ? { contactPhone:  args.client.contactPhone.trim() }  : {}),
          ...(args.partner?.company?.trim() ? { partnerCompany: args.partner.company.trim() } : {}),
          ...(args.partner?.contact?.trim() ? { partnerContact: args.partner.contact.trim() } : {}),
          ...(args.partner?.email?.trim()   ? { partnerEmail:   args.partner.email.trim() }   : {}),
          // Default the role to 'partner' when a partner company/contact
          // is given but the rep left the role unset.
          ...(args.partner?.role
            ? { partnerRole: args.partner.role }
            : (args.partner?.company?.trim() || args.partner?.contact?.trim())
              ? { partnerRole: 'partner' }
              : {}),
        },
        select: { id: true },
      });
    });
    return { engagementId: created.id };
  }

  /**
   * Mint a gathering token against an existing engagement. Works for:
   *   - Direct-ingest opportunities (the *first* link — attaches a
   *     template at the same time, codifying the invariant from
   *     docs/direct-ingest.md §3.2: token ⇒ templateId NOT NULL).
   *   - Link-share opportunities the rep wants to re-scope or follow
   *     up on (the *re-issue* — engagement.templateId is already set).
   *
   * Emits `link_issued` when this is the first token on the engagement,
   * `link_reissued` otherwise. The event distinction lets the timeline
   * show "client invited" vs "follow-up sent" without the UI having to
   * count tokens.
   *
   * Refuses to switch templates: if engagement already has a templateId
   * different from `args.templateId`, throws `template_mismatch_with_existing`.
   * Switching templates would orphan existing answers; out of scope for v1.
   */
  async issueLinkForExisting(args: {
    tenantId: string;
    engagementId: string;
    salesEmployeeId: string;
    templateId: string;
    expiresInDays?: number;
    reason?: string;
    publicBaseUrl: string;
  }): Promise<IssuedLink> {
    const expiresInDays = args.expiresInDays ?? 7;

    const { mint, isFirst } = await this.tenantDb.run(args.tenantId, async (db) => {
      // 1. Verify the engagement exists.
      const eng = await db.engagement.findUnique({
        where: { id: args.engagementId },
        select: { id: true, templateId: true, clientEmail: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      // 2. Validate the chosen template is real + published.
      const tmpl = await db.template.findUnique({
        where: { id: args.templateId },
        select: { id: true, version: true, status: true },
      });
      if (!tmpl) throw new NotFoundException('template_not_found');
      if (tmpl.status !== 'published') {
        throw new BadRequestException('template_not_published');
      }

      // 3. Reject template switches. Re-using the same template is
      //    fine (idempotent on the field below); switching would
      //    invalidate existing answers and isn't supported in v1.
      if (eng.templateId && eng.templateId !== tmpl.id) {
        throw new BadRequestException('template_mismatch_with_existing');
      }

      // 4. Attach the template to the engagement if it didn't have
      //    one (the direct-ingest case). updateMany is a no-op when
      //    the value already matches.
      if (!eng.templateId) {
        await db.engagement.update({
          where: { id: args.engagementId },
          data: { templateId: tmpl.id, templateVersion: tmpl.version },
        });
      }

      // 5. Mint the token + emit link_issued / link_reissued.
      const m = await this.mintGatheringTokenWithin(db, {
        tenantId: args.tenantId,
        engagementId: args.engagementId,
        actorId: args.salesEmployeeId,
        expiresInDays,
        ...(args.reason ? { reason: args.reason } : {}),
        // First-token compatibility: keep the legacy link_issued
        // payload shape so existing notification templates work.
        legacyLinkIssuedPayload: {
          clientEmail: eng.clientEmail,
          expiresAt: new Date(Date.now() + expiresInDays * 86_400_000).toISOString(),
        },
      });

      return { mint: m, isFirst: m.isFirst };
    });

    // Post-commit notification — only fan out on the first-issuance
    // event; re-issues are silent per packages/shared/src/notifications.ts.
    if (isFirst) {
      void this.thread.dispatchAfterCommit(args.tenantId, {
        engagementId: args.engagementId,
        eventType: 'link_issued',
        actorType: 'user',
        actorId: args.salesEmployeeId,
        payload: {
          clientEmail: mint.clientEmail,
          expiresAt: mint.expiresAt.toISOString(),
        },
      });
    }

    return {
      engagementId: args.engagementId,
      token: mint.token,
      url: `${args.publicBaseUrl.replace(/\/$/, '')}/g/${mint.token}`,
      expiresAt: mint.expiresAt.toISOString(),
    };
  }

  /**
   * Shared core: mint a GatheringToken row + emit the matching thread
   * event inside an existing transaction. Returns the plaintext token
   * (which only exists in memory until persisted as a hash) so the
   * caller can build the URL handed to the rep.
   *
   * `isFirst` is computed by counting prior tokens — drives the
   * `link_issued` vs `link_reissued` choice.
   */
  private async mintGatheringTokenWithin(
    db: PrismaTx,
    args: {
      tenantId: string;
      engagementId: string;
      actorId: string;
      expiresInDays: number;
      reason?: string;
      /** Optional — when set, link_issued payload uses this shape for
       *  back-compat with the legacy issue() path. Ignored when the
       *  emitted event is link_reissued. */
      legacyLinkIssuedPayload?: { clientEmail: string; expiresAt: string };
    },
  ): Promise<{
    token: string;
    expiresAt: Date;
    tokenId: string;
    isFirst: boolean;
    clientEmail: string;
  }> {
    const priorCount = await db.gatheringToken.count({
      where: { engagementId: args.engagementId },
    });
    const isFirst = priorCount === 0;

    const token = mintToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + args.expiresInDays * 86_400_000);

    const created = await db.gatheringToken.create({
      data: {
        tenantId: args.tenantId,
        engagementId: args.engagementId,
        tokenHash,
        tokenPlain: token,
        expiresAt,
      },
    });

    // For link_issued (first token) keep the legacy payload shape so
    // any handlers that rely on { clientEmail, expiresAt } still work.
    // For link_reissued, emit the docs/direct-ingest.md §3.5 payload.
    const eventType: 'link_issued' | 'link_reissued' = isFirst ? 'link_issued' : 'link_reissued';
    const payload = isFirst
      ? (args.legacyLinkIssuedPayload ?? {
          // Defensive default — shouldn't be reached because the
          // public callers always pass legacyLinkIssuedPayload.
          tokenId: created.id,
          expiresAt: expiresAt.toISOString(),
        })
      : {
          tokenId: created.id,
          expiresAt: expiresAt.toISOString(),
          ...(args.reason ? { reason: args.reason } : {}),
        };

    await this.thread.emitWithin(db, args.tenantId, {
      engagementId: args.engagementId,
      eventType,
      actorType: 'user',
      actorId: args.actorId,
      payload,
    });

    return {
      token,
      expiresAt,
      tokenId: created.id,
      isFirst,
      clientEmail: args.legacyLinkIssuedPayload?.clientEmail ?? '',
    };
  }

  // Email preview (forwarded-sender resolution + scope-field extraction)
  // moved to EmailExtractorService in ../email-extractor. It now runs an
  // LLM pass (with the regex parser as fallback) and needs LlmModule,
  // which can't be imported into EngagementsModule without a cycle.

  async list(tenantId: string): Promise<EngagementSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagement.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          template: { select: { name: true } },
          rateCard: { select: { name: true } },
          // Pull just the currency from the engagement quote so the
          // list endpoint can surface the right currency symbol on
          // each row without exposing the whole quote payload.
          quote: { select: { currency: true } },
        },
      });
      return rows.map(rowToSummary);
    });
  }

  async getById(
    tenantId: string,
    id: string,
    opts: { publicBaseUrl?: string } = {},
  ): Promise<EngagementSummary & {
    thread: Awaited<ReturnType<ThreadService['listForEngagement']>>;
    /** The currently-active gathering link, if any. Null when no token
     *  exists, or when every token is revoked / expired. The rep uses
     *  this to copy the URL back into chat after leaving the wizard. */
    gatheringLink: {
      url: string;
      expiresAt: string;
      isExpired: boolean;
      isRevoked: boolean;
      accessCount: number;
    } | null;
  }> {
    const { summary, link } = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagement.findUnique({
        where: { id },
        include: {
          template: { select: { name: true } },
          rateCard: { select: { name: true } },
          quote: { select: { currency: true } },
        },
      });
      if (!row) throw new NotFoundException('engagement_not_found');
      // Pick the most recent token. We don't pre-filter by revoked/expired
      // because the UI surfaces those states (so the rep knows why a link
      // they remember sending isn't usable any more).
      const tokenRow = await db.gatheringToken.findFirst({
        where: { engagementId: id },
        orderBy: { createdAt: 'desc' },
      });
      return { summary: rowToSummary(row), link: tokenRow };
    });

    const thread = await this.thread.listForEngagement(tenantId, id);
    const baseUrl = (opts.publicBaseUrl ?? '').replace(/\/$/, '');
    const gatheringLink = link && link.tokenPlain && baseUrl
      ? {
          url: `${baseUrl}/g/${link.tokenPlain}`,
          expiresAt: link.expiresAt.toISOString(),
          isExpired: link.expiresAt.getTime() < Date.now(),
          isRevoked: link.revokedAt != null,
          accessCount: link.accessCount,
        }
      : null;
    return { ...summary, thread, gatheringLink };
  }

  /**
   * Hard delete the engagement. Postgres cascades take care of children
   * (answers, files, events, predictions, quote, gathering tokens).
   * Audit-chain links also cascade.
   *
   * Tenant-scoped via TenantDb so an attacker who knows the id can't
   * delete an opportunity in another tenant.
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const exists = await db.engagement.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('engagement_not_found');
      await db.engagement.delete({ where: { id } });
    });
  }

  /**
   * Phase A — patch the reviewer-fillable scope fields. Emits one
   * thread event per non-trivial change (assumptions / exclusions /
   * timeline) so the audit timeline shows what the reviewer touched.
   * Soft-empty: passing `null` or `""` clears the stored value.
   */
  /**
   * Phase C — patch the client-metadata fields (name / address /
   * contact name / phone). All four are optional; passing
   * `null` or empty string clears the stored value. Editable by
   * sales rep, manager, admin (any role with engagement-edit rights).
   * No thread event is emitted: this is "fill in the form" work,
   * not a workflow transition.
   */
  async updateClient(
    tenantId: string,
    engagementId: string,
    args: {
      clientName?: string | null;
      clientAddress?: string | null;
      contactName?: string | null;
      contactPhone?: string | null;
    },
  ): Promise<{
    id: string;
    clientName: string | null;
    clientAddress: string | null;
    contactName: string | null;
    contactPhone: string | null;
  }> {
    const norm = (v: string | null | undefined): string | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const t = v.trim();
      return t.length === 0 ? null : t;
    };
    const data: Record<string, string | null> = {};
    const n1 = norm(args.clientName);    if (n1 !== undefined) data.clientName    = n1;
    const n2 = norm(args.clientAddress); if (n2 !== undefined) data.clientAddress = n2;
    const n3 = norm(args.contactName);   if (n3 !== undefined) data.contactName   = n3;
    const n4 = norm(args.contactPhone);  if (n4 !== undefined) data.contactPhone  = n4;
    if (Object.keys(data).length === 0) {
      // No-op — return current state.
      return this.tenantDb.run(tenantId, async (db) => {
        const row = await db.engagement.findUnique({
          where: { id: engagementId },
          select: { id: true, clientName: true, clientAddress: true, contactName: true, contactPhone: true },
        });
        if (!row) throw new NotFoundException('engagement_not_found');
        return row;
      });
    }
    return this.tenantDb.run(tenantId, async (db) => {
      const exists = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('engagement_not_found');
      return db.engagement.update({
        where: { id: engagementId },
        data,
        select: { id: true, clientName: true, clientAddress: true, contactName: true, contactPhone: true },
      });
    });
  }

  /**
   * Attach a rate card DIRECTLY to this opportunity, independent of any
   * template. This is the template-less pricing path: a direct-ingest
   * opportunity (email / paste / voice) has no template and therefore no
   * rate card, so every stage after extraction is gated off. Attaching a
   * card here lets the opportunity be priced from its extracted +
   * inferred entities without first issuing a client scoping link.
   *
   * The card must be published and belong to this tenant (RLS enforces
   * the latter — a row from another tenant simply isn't found). Setting
   * the card does NOT itself reprice; the caller re-runs inference +
   * predict (see EngagementsController.attachRateCard).
   */
  async attachRateCard(
    tenantId: string,
    engagementId: string,
    rateCardId: string,
  ): Promise<{ id: string; rateCardId: string; rateCardName: string }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      const card = await db.rateCard.findUnique({
        where: { id: rateCardId },
        select: { id: true, name: true, status: true },
      });
      if (!card) throw new NotFoundException('rate_card_not_found');
      if (card.status !== 'published') {
        throw new BadRequestException('rate_card_not_published');
      }

      const updated = await db.engagement.update({
        where: { id: engagementId },
        data: { rateCardId: card.id },
        select: { id: true, rateCardId: true },
      });
      return { id: updated.id, rateCardId: updated.rateCardId ?? card.id, rateCardName: card.name };
    });
  }

  async updateScope(
    tenantId: string,
    engagementId: string,
    actorUserId: string,
    args: {
      assumptions?: string | null;
      exclusions?: string | null;
      deliveryTimelineOverride?: string | null;
    },
  ): Promise<{
    id: string;
    assumptions: string | null;
    exclusions: string | null;
    deliveryTimelineOverride: string | null;
  }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagement.findUnique({
        where: { id: engagementId },
        select: {
          id: true,
          assumptions: true,
          exclusions: true,
          deliveryTimelineOverride: true,
        },
      });
      if (!existing) throw new NotFoundException('engagement_not_found');

      // Normalise — treat empty / whitespace-only as null.
      const normalise = (v: string | null | undefined): string | null | undefined => {
        if (v === undefined) return undefined;
        if (v === null) return null;
        const t = v.trim();
        return t.length === 0 ? null : t;
      };
      const next = {
        assumptions: normalise(args.assumptions),
        exclusions: normalise(args.exclusions),
        deliveryTimelineOverride: normalise(args.deliveryTimelineOverride),
      };

      // Filter to actual changes — no point writing if nothing changed.
      const data: Record<string, string | null> = {};
      const changed: Array<'assumptions' | 'exclusions' | 'delivery_timeline_override'> = [];
      if (next.assumptions !== undefined && next.assumptions !== existing.assumptions) {
        data.assumptions = next.assumptions;
        changed.push('assumptions');
      }
      if (next.exclusions !== undefined && next.exclusions !== existing.exclusions) {
        data.exclusions = next.exclusions;
        changed.push('exclusions');
      }
      if (
        next.deliveryTimelineOverride !== undefined &&
        next.deliveryTimelineOverride !== existing.deliveryTimelineOverride
      ) {
        data.deliveryTimelineOverride = next.deliveryTimelineOverride;
        changed.push('delivery_timeline_override');
      }

      if (changed.length === 0) {
        // No-op: just return the current state without emitting events.
        return {
          id: existing.id,
          assumptions: existing.assumptions,
          exclusions: existing.exclusions,
          deliveryTimelineOverride: existing.deliveryTimelineOverride,
        };
      }

      const updated = await db.engagement.update({
        where: { id: engagementId },
        data,
        select: {
          id: true,
          assumptions: true,
          exclusions: true,
          deliveryTimelineOverride: true,
        },
      });

      // One thread event per changed field. The notification routing
      // for these is empty by default (informational), but the audit
      // chain records the diff.
      for (const field of changed) {
        const eventType =
          field === 'assumptions' ? 'scope_assumptions_updated'
          : field === 'exclusions' ? 'scope_exclusions_updated'
          : 'scope_assumptions_updated'; // delivery_timeline: piggyback on assumptions event for now
        const lengthBefore =
          field === 'assumptions' ? (existing.assumptions?.length ?? 0)
          : field === 'exclusions' ? (existing.exclusions?.length ?? 0)
          : (existing.deliveryTimelineOverride?.length ?? 0);
        const lengthAfter =
          field === 'assumptions' ? (updated.assumptions?.length ?? 0)
          : field === 'exclusions' ? (updated.exclusions?.length ?? 0)
          : (updated.deliveryTimelineOverride?.length ?? 0);
        if (field === 'delivery_timeline_override') {
          // We don't have a dedicated event type for timeline — skip
          // emitting (the change is observable in the engagement itself).
          continue;
        }
        await this.thread.emitWithin(db, tenantId, {
          engagementId,
          eventType,
          actorType: 'user',
          actorId: actorUserId,
          payload: { lengthBefore, lengthAfter },
        });
      }

      return updated;
    });
  }

  /**
   * Phase F — mark a delivered ('sent') opportunity won or lost. Won →
   * 'closed', lost → 'lost'; both terminal. Records an engagement_closed
   * thread event carrying the outcome so the audit trail distinguishes them.
   */
  async markOutcome(
    tenantId: string,
    engagementId: string,
    actorUserId: string,
    outcome: 'won' | 'lost',
  ): Promise<{ id: string; status: string }> {
    const result = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, status: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');
      // Only a delivered proposal can be won/lost. Idempotent guard against
      // double-clicks; final states stay final.
      if (eng.status !== 'sent') {
        throw new ConflictException(`cannot_mark_outcome_from_status:${eng.status}`);
      }
      const nextStatus = outcome === 'won' ? 'closed' : 'lost';
      const next = await db.engagement.update({
        where: { id: engagementId },
        data: { status: nextStatus, closedAt: new Date() },
        select: { id: true, status: true },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'engagement_closed',
        actorType: 'user',
        actorId: actorUserId,
        payload: { outcome },
      });
      return next;
    });

    void this.thread.dispatchAfterCommit(tenantId, {
      engagementId,
      eventType: 'engagement_closed',
      actorType: 'user',
      actorId: actorUserId,
      payload: { outcome },
    });
    return result;
  }
}

function rowToSummary(r: {
  id: string;
  // Both fields are nullable on direct-ingest opportunities (no template
  // attached) per docs/direct-ingest.md §3.2.
  templateId: string | null;
  template: { name: string } | null;
  rateCardId: string | null;
  rateCard: { name: string } | null;
  source: string;
  name: string | null;
  clientEmail: string;
  status: string;
  createdAt: Date;
  submittedAt: Date | null;
  predictedPriceCents: bigint | null;
  priceLowCents: bigint | null;
  priceHighCents: bigint | null;
  // Optional — only populated when callers `include: { quote: ... }`.
  // Single-record `getById` keeps it absent; `list` opts in.
  quote?: { currency: string } | null;
  // Phase A — these may be missing on list queries that don't select
  // them; treat undefined as null so the response shape is consistent.
  assumptions?: string | null;
  exclusions?: string | null;
  deliveryTimelineOverride?: string | null;
  // Phase B — same nullable-default treatment.
  categorySlug?: string | null;
  subCategorySlug?: string | null;
  classifiedBy?: string | null;
  classifiedAt?: Date | null;
  assignedReviewerId?: string | null;
  // Phase C — client metadata.
  clientName?: string | null;
  clientAddress?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}): EngagementSummary {
  return {
    id: r.id,
    templateId: r.templateId,
    templateName: r.template?.name ?? null,
    rateCardId: r.rateCardId,
    rateCardName: r.rateCard?.name ?? null,
    source: r.source,
    name: r.name,
    clientEmail: r.clientEmail,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
    predictedPriceCents: r.predictedPriceCents == null ? null : Number(r.predictedPriceCents),
    priceLowCents: r.priceLowCents == null ? null : Number(r.priceLowCents),
    priceHighCents: r.priceHighCents == null ? null : Number(r.priceHighCents),
    currency: r.quote?.currency ?? null,
    assumptions: r.assumptions ?? null,
    exclusions: r.exclusions ?? null,
    deliveryTimelineOverride: r.deliveryTimelineOverride ?? null,
    categorySlug: r.categorySlug ?? null,
    subCategorySlug: r.subCategorySlug ?? null,
    classifiedBy: (r.classifiedBy ?? null) as 'llm' | 'manual' | null,
    classifiedAt: r.classifiedAt ? r.classifiedAt.toISOString() : null,
    assignedReviewerId: r.assignedReviewerId ?? null,
    clientName: r.clientName ?? null,
    clientAddress: r.clientAddress ?? null,
    contactName: r.contactName ?? null,
    contactPhone: r.contactPhone ?? null,
  };
}
