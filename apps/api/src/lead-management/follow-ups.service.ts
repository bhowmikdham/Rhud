/**
 * Engagement follow-ups — scheduled "remind me to check on this" tasks
 * any sales rep or manager can stack against an opportunity.
 *
 * Lifecycle is soft: completion sets `completedAt` and the row stays
 * for audit. The manager dashboard reads pending rows ordered by
 * `scheduledFor` (overdue first).
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import type {
  CreateFollowUpInput,
  CompleteFollowUpInput,
  FollowUpRow,
  UpdateFollowUpInput,
  UpcomingFollowUp,
} from '@rhud/shared';
import { loadUserEmails } from './tickets.service.js';

@Injectable()
export class FollowUpsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  async list(tenantId: string, engagementId: string): Promise<FollowUpRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagementFollowUp.findMany({
        where: { engagementId },
        orderBy: [{ completedAt: { sort: 'asc', nulls: 'first' } }, { scheduledFor: 'asc' }],
      });
      return await Promise.all(rows.map((r) => this.toDto(db, r)));
    });
  }

  async create(
    tenantId: string,
    engagementId: string,
    input: CreateFollowUpInput,
    actorUserId: string,
  ): Promise<FollowUpRow> {
    const scheduledFor = parseDate(input.scheduledFor);
    if (!scheduledFor) throw new BadRequestException('bad_scheduled_for');
    if (!input.reason?.trim()) throw new BadRequestException('reason_required');

    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      if (input.relatedTicketId) {
        const t = await db.engagementTicket.findUnique({
          where: { id: input.relatedTicketId },
          select: { id: true, engagementId: true },
        });
        if (!t || t.engagementId !== engagementId) {
          throw new BadRequestException('related_ticket_invalid');
        }
      }

      const created = await db.engagementFollowUp.create({
        data: {
          tenantId,
          engagementId,
          scheduledFor,
          reason: input.reason.trim(),
          ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
          ...(input.relatedTicketId ? { relatedTicketId: input.relatedTicketId } : {}),
          createdBy: actorUserId,
        },
      });

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'follow_up_scheduled',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          followUpId: created.id,
          scheduledFor: scheduledFor.toISOString(),
          reason: created.reason,
          ...(created.assignedTo ? { assignedTo: created.assignedTo } : {}),
        },
      });
      return this.toDto(db, created);
    });
  }

  async update(
    tenantId: string,
    engagementId: string,
    id: string,
    input: UpdateFollowUpInput,
  ): Promise<FollowUpRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementFollowUp.findUnique({ where: { id } });
      if (!existing || existing.engagementId !== engagementId) throw new NotFoundException('follow_up_not_found');

      const data: Record<string, unknown> = {};
      if (input.scheduledFor) {
        const d = parseDate(input.scheduledFor);
        if (!d) throw new BadRequestException('bad_scheduled_for');
        data.scheduledFor = d;
      }
      if (input.reason?.trim()) data.reason = input.reason.trim();
      if (input.assignedTo !== undefined) data.assignedTo = input.assignedTo ?? null;
      if (input.relatedTicketId !== undefined) data.relatedTicketId = input.relatedTicketId ?? null;
      data.updatedAt = new Date();

      const updated = await db.engagementFollowUp.update({
        where: { id },
        data: data as Parameters<typeof db.engagementFollowUp.update>[0]['data'],
      });
      return this.toDto(db, updated);
    });
  }

  async complete(
    tenantId: string,
    engagementId: string,
    id: string,
    input: CompleteFollowUpInput,
    actorUserId: string,
  ): Promise<FollowUpRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementFollowUp.findUnique({ where: { id } });
      if (!existing || existing.engagementId !== engagementId) throw new NotFoundException('follow_up_not_found');
      if (existing.completedAt) {
        // Idempotent — return as-is.
        return this.toDto(db, existing);
      }
      const updated = await db.engagementFollowUp.update({
        where: { id },
        data: {
          completedAt: new Date(),
          completedBy: actorUserId,
          ...(input.completionNote?.trim() ? { completionNote: input.completionNote.trim() } : {}),
          updatedAt: new Date(),
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'follow_up_completed',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          followUpId: id,
          ...(input.completionNote?.trim() ? { note: input.completionNote.trim() } : {}),
        },
      });
      return this.toDto(db, updated);
    });
  }

  async remove(tenantId: string, engagementId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementFollowUp.findUnique({ where: { id } });
      if (!existing || existing.engagementId !== engagementId) throw new NotFoundException('follow_up_not_found');
      await db.engagementFollowUp.delete({ where: { id } });
    });
  }

  /** Manager dashboard: pending follow-ups due in the next `withinDays`
   *  (default 14). Overdue ones come first. */
  async listUpcomingForTenant(tenantId: string, opts: { withinDays?: number; limit?: number } = {}): Promise<UpcomingFollowUp[]> {
    const within = opts.withinDays ?? 14;
    const cutoff = new Date(Date.now() + within * 86_400_000);
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagementFollowUp.findMany({
        where: {
          tenantId,
          completedAt: null,
          scheduledFor: { lte: cutoff },
        },
        orderBy: { scheduledFor: 'asc' },
        take: Math.min(opts.limit ?? 100, 500),
        include: { engagement: { select: { name: true, clientEmail: true } } },
      });
      const userIds = rows.map((r) => r.assignedTo).filter((x): x is string => !!x);
      const userMap = await loadUserEmails(db, userIds);
      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        engagementName: r.engagement?.name ?? null,
        clientEmail: r.engagement?.clientEmail ?? '',
        scheduledFor: r.scheduledFor.toISOString(),
        reason: r.reason,
        assignedToDisplay: r.assignedTo ? userMap.get(r.assignedTo) ?? null : null,
        overdue: r.scheduledFor.getTime() < now,
      }));
    });
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async toDto(
    db: PrismaTx,
    r: {
      id: string;
      engagementId: string;
      scheduledFor: Date;
      reason: string;
      assignedTo: string | null;
      completedAt: Date | null;
      completedBy: string | null;
      completionNote: string | null;
      relatedTicketId: string | null;
      createdBy: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ): Promise<FollowUpRow> {
    const ids = [r.assignedTo, r.completedBy, r.createdBy].filter((x): x is string => !!x);
    const userMap = ids.length ? await loadUserEmails(db, ids) : new Map<string, string>();
    return {
      id: r.id,
      engagementId: r.engagementId,
      scheduledFor: r.scheduledFor.toISOString(),
      reason: r.reason,
      assignedTo: r.assignedTo,
      assignedToDisplay: r.assignedTo ? userMap.get(r.assignedTo) ?? null : null,
      completedAt: r.completedAt?.toISOString() ?? null,
      completedBy: r.completedBy,
      completedByDisplay: r.completedBy ? userMap.get(r.completedBy) ?? null : null,
      completionNote: r.completionNote,
      relatedTicketId: r.relatedTicketId,
      createdBy: r.createdBy,
      createdByDisplay: userMap.get(r.createdBy) ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      overdue: !r.completedAt && r.scheduledFor.getTime() < Date.now(),
    };
  }
}

function parseDate(value: string): Date | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}
