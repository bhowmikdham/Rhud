import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { hashToken, mintToken } from '../gathering/token.util.js';
import type { CreateEngagementDto, CreateOpportunityFromEmailDto } from './dto.js';

export interface IssuedLink {
  engagementId: string;
  token: string;          // plaintext — shown ONCE in the issuance response
  url: string;            // full link to send the client
  expiresAt: string;      // ISO 8601
}

export interface EngagementSummary {
  id: string;
  templateId: string;
  templateName: string;
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
    const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);

    const token = mintToken();
    const tokenHash = await hashToken(token);

    const linkIssuedPayload = {
      clientEmail: args.dto.clientEmail,
      expiresAt: expiresAt.toISOString(),
    };

    const engagement = await this.tenantDb.run(args.tenantId, async (db) => {
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

      await db.gatheringToken.create({
        data: {
          tenantId: args.tenantId,
          engagementId: created.id,
          tokenHash,
          // Stored so the rep can look the URL up later from the
          // opportunity detail page. Trade-off documented in the
          // 20260607000000_gathering_token_plain migration.
          tokenPlain: token,
          expiresAt,
        },
      });

      await this.thread.emitWithin(db, args.tenantId, {
        engagementId: created.id,
        eventType: 'link_issued',
        actorType: 'user',
        actorId: args.salesEmployeeId,
        payload: linkIssuedPayload,
      });

      return created;
    });

    // Post-commit: fan out notifications. Fire-and-forget — failures are
    // logged inside the dispatcher and don't fail the request.
    void this.thread.dispatchAfterCommit(args.tenantId, {
      engagementId: engagement.id,
      eventType: 'link_issued',
      actorType: 'user',
      actorId: args.salesEmployeeId,
      payload: linkIssuedPayload,
    });

    return {
      engagementId: engagement.id,
      token,
      url: `${args.publicBaseUrl.replace(/\/$/, '')}/g/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Create an engagement from an inbound email (Outlook add-in flow).
   *
   * Two responsibilities on top of {@link issue}:
   *   1. **Idempotency.** We look up `(tenantId, messageId)` first; if the
   *      same email has already been processed, return the existing
   *      engagement instead of creating a duplicate. This protects against
   *      double-clicks, retries, and the user opening the add-in twice on
   *      the same message.
   *   2. **Provenance.** We persist `sourceMessageId` on the row and emit
   *      an `engagement_created_from_email` thread event so the audit
   *      timeline shows which inbound email kicked off the opportunity.
   *
   * Field mapping (email → engagement):
   *   - subject       → name (truncated to 200 chars, the column's limit)
   *   - fromEmail     → clientEmail
   *   - fromName      → contactName
   *   - clientNameOverride (or fromName) → clientName
   */
  async issueFromEmail(args: {
    tenantId: string;
    salesEmployeeId: string;
    dto: CreateOpportunityFromEmailDto;
    publicBaseUrl: string;
  }): Promise<IssuedLink> {
    // Idempotency check — separate tx is fine, RLS scopes it to this tenant.
    const existing = await this.tenantDb.run(args.tenantId, async (db) => {
      return db.engagement.findFirst({
        where: { sourceMessageId: args.dto.messageId },
        select: { id: true },
      });
    });
    if (existing) {
      // Pull the existing token so the add-in still gets a usable URL.
      // The `getById` path returns `gatheringLink: { url, ... }`; we
      // unwrap to the IssuedLink shape the add-in expects.
      const detail = await this.getById(args.tenantId, existing.id, {
        publicBaseUrl: args.publicBaseUrl,
      });
      if (!detail.gatheringLink) {
        // Defensive: an engagement always has a token unless something
        // hand-deleted it. Treat as a server error rather than silently
        // re-issuing — the operator wants to know.
        throw new BadRequestException('existing_engagement_missing_token');
      }
      return {
        engagementId: existing.id,
        // The plaintext token isn't separately exposed by getById; parse
        // it back out of the URL. This avoids changing getById's return
        // shape just for this code path.
        token: detail.gatheringLink.url.split('/g/').pop() ?? '',
        url: detail.gatheringLink.url,
        expiresAt: detail.gatheringLink.expiresAt,
      };
    }

    // Map email → CreateEngagementDto. Subject becomes the human-readable
    // name (it's almost always more descriptive than auto-generated ones).
    const mappedDto: CreateEngagementDto = {
      templateId: args.dto.templateId,
      clientEmail: args.dto.fromEmail,
      name: args.dto.subject.slice(0, 200),
      // Spread optionals only if set — strict exactOptionalPropertyTypes.
      ...((args.dto.clientNameOverride ?? args.dto.fromName)
        ? { clientName: args.dto.clientNameOverride ?? args.dto.fromName }
        : {}),
      ...(args.dto.fromName ? { contactName: args.dto.fromName } : {}),
    };

    // Delegate to the standard issue path — gets us the template
    // validation, gathering token, link_issued event, notification
    // fan-out, all for free.
    const issued = await this.issue({
      tenantId: args.tenantId,
      salesEmployeeId: args.salesEmployeeId,
      dto: mappedDto,
      publicBaseUrl: args.publicBaseUrl,
    });

    // Backfill the source_message_id (issue() doesn't take it) and emit
    // the provenance thread event. Both happen in the same tx so the
    // engagement is never in a half-attributed state.
    await this.tenantDb.run(args.tenantId, async (db) => {
      await db.engagement.update({
        where: { id: issued.engagementId },
        data: { sourceMessageId: args.dto.messageId },
      });
      await this.thread.emitWithin(db, args.tenantId, {
        engagementId: issued.engagementId,
        eventType: 'engagement_created_from_email',
        actorType: 'user',
        actorId: args.salesEmployeeId,
        payload: {
          source: args.dto.source ?? 'outlook',
          messageId: args.dto.messageId,
          fromEmail: args.dto.fromEmail,
          ...(args.dto.fromName ? { fromName: args.dto.fromName } : {}),
          subject: args.dto.subject,
          // 500-char snippet keeps the timeline readable; the rep can
          // always go back to the original email in their inbox for the
          // full body.
          bodySnippet: args.dto.bodyText.slice(0, 500),
        },
      });
    });

    void this.thread.dispatchAfterCommit(args.tenantId, {
      engagementId: issued.engagementId,
      eventType: 'engagement_created_from_email',
      actorType: 'user',
      actorId: args.salesEmployeeId,
      payload: {
        source: args.dto.source ?? 'outlook',
        messageId: args.dto.messageId,
      },
    });

    return issued;
  }

  async list(tenantId: string): Promise<EngagementSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagement.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          template: { select: { name: true } },
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
}

function rowToSummary(r: {
  id: string;
  templateId: string;
  template: { name: string };
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
    templateName: r.template.name,
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
