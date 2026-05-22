import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { hashToken, mintToken } from '../gathering/token.util.js';
import type { CreateEngagementDto } from './dto.js';

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

  async list(tenantId: string): Promise<EngagementSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagement.findMany({
        orderBy: { createdAt: 'desc' },
        include: { template: { select: { name: true } } },
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
        include: { template: { select: { name: true } } },
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
    assumptions: r.assumptions ?? null,
    exclusions: r.exclusions ?? null,
    deliveryTimelineOverride: r.deliveryTimelineOverride ?? null,
    categorySlug: r.categorySlug ?? null,
    subCategorySlug: r.subCategorySlug ?? null,
    classifiedBy: (r.classifiedBy ?? null) as 'llm' | 'manual' | null,
    classifiedAt: r.classifiedAt ? r.classifiedAt.toISOString() : null,
    assignedReviewerId: r.assignedReviewerId ?? null,
  };
}
