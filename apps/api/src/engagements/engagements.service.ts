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
  clientEmail: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
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
          status: 'issued',
        },
      });

      await db.gatheringToken.create({
        data: {
          tenantId: args.tenantId,
          engagementId: created.id,
          tokenHash,
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
      return rows.map((r) => ({
        id: r.id,
        templateId: r.templateId,
        templateName: r.template.name,
        clientEmail: r.clientEmail,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      }));
    });
  }

  async getById(tenantId: string, id: string): Promise<EngagementSummary & { thread: Awaited<ReturnType<ThreadService['listForEngagement']>> }> {
    const summary = await this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagement.findUnique({
        where: { id },
        include: { template: { select: { name: true } } },
      });
      if (!row) throw new NotFoundException('engagement_not_found');
      return {
        id: row.id,
        templateId: row.templateId,
        templateName: row.template.name,
        clientEmail: row.clientEmail,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
      };
    });

    const thread = await this.thread.listForEngagement(tenantId, id);
    return { ...summary, thread };
  }
}
