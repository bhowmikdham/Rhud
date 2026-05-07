/**
 * Engagement tickets — complaints, change requests, internal check-ins.
 *
 * Lifecycle: open → in_progress → resolved (or wont_fix). Every
 * status transition emits a thread event so the existing audit
 * timeline + notification fan-out picks it up.
 */

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import type {
  CreateTicketInput,
  TicketRow,
  UpdateTicketInput,
  TicketStatus,
  TicketCategory,
  TicketPriority,
  TicketRaisedBy,
  OpenTicketSummary,
} from '@rhud/shared';
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUSES } from '@rhud/shared';

@Injectable()
export class TicketsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  async list(tenantId: string, engagementId: string): Promise<TicketRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      await assertEngagementExists(db, engagementId);
      const rows = await db.engagementTicket.findMany({
        where: { engagementId },
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      });
      return await Promise.all(rows.map((r) => this.toDto(db, r)));
    });
  }

  async get(tenantId: string, engagementId: string, ticketId: string): Promise<TicketRow> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.engagementTicket.findUnique({ where: { id: ticketId } });
      if (!row || row.engagementId !== engagementId) throw new NotFoundException('ticket_not_found');
      return this.toDto(db, row);
    });
  }

  async create(
    tenantId: string,
    engagementId: string,
    input: CreateTicketInput,
    actor: { userId: string; role: string; email: string },
  ): Promise<TicketRow> {
    if (!TICKET_CATEGORIES.includes(input.category)) throw new BadRequestException('bad_category');
    if (input.priority && !TICKET_PRIORITIES.includes(input.priority)) throw new BadRequestException('bad_priority');
    if (!input.title?.trim()) throw new BadRequestException('title_required');

    // Default raisedBy from the caller's role unless overridden (admin
    // logging on behalf of a client).
    const raisedBy: TicketRaisedBy =
      input.raisedBy ?? (
        actor.role === 'admin' ? 'admin'
        : actor.role === 'sales_manager' ? 'sales_manager'
        : 'sales_rep'
      );

    return this.tenantDb.run(tenantId, async (db) => {
      await assertEngagementExists(db, engagementId);
      const created = await db.engagementTicket.create({
        data: {
          tenantId,
          engagementId,
          category: input.category,
          priority: input.priority ?? 'medium',
          title: input.title.trim(),
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          raisedBy,
          ...(raisedBy === 'client' ? {} : { raisedByUserId: actor.userId }),
          ...(input.raisedByEmail?.trim() ? { raisedByEmail: input.raisedByEmail.trim() } : { raisedByEmail: actor.email }),
          ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
        },
      });
      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'ticket_opened',
        actorType: 'user',
        actorId: actor.userId,
        payload: {
          ticketId: created.id,
          category: created.category,
          priority: created.priority,
          title: created.title,
        },
      });
      return this.toDto(db, created);
    });
  }

  async update(
    tenantId: string,
    engagementId: string,
    ticketId: string,
    input: UpdateTicketInput,
    actorUserId: string,
  ): Promise<TicketRow> {
    if (input.category && !TICKET_CATEGORIES.includes(input.category)) throw new BadRequestException('bad_category');
    if (input.priority && !TICKET_PRIORITIES.includes(input.priority)) throw new BadRequestException('bad_priority');
    if (input.status && !TICKET_STATUSES.includes(input.status)) throw new BadRequestException('bad_status');

    return this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementTicket.findUnique({ where: { id: ticketId } });
      if (!existing || existing.engagementId !== engagementId) throw new NotFoundException('ticket_not_found');

      const transitioning = input.status && input.status !== existing.status;
      const resolving = transitioning && (input.status === 'resolved' || input.status === 'wont_fix');

      const updated = await db.engagementTicket.update({
        where: { id: ticketId },
        data: {
          ...(input.category ? { category: input.category as TicketCategory } : {}),
          ...(input.priority ? { priority: input.priority as TicketPriority } : {}),
          ...(input.status ? { status: input.status as TicketStatus } : {}),
          ...(input.title?.trim() ? { title: input.title.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() ?? null } : {}),
          ...(input.assignedTo !== undefined ? { assignedTo: input.assignedTo ?? null } : {}),
          ...(input.resolutionNote !== undefined ? { resolutionNote: input.resolutionNote?.trim() ?? null } : {}),
          ...(resolving ? { resolvedAt: new Date() } : {}),
          ...(transitioning && !resolving && existing.resolvedAt ? { resolvedAt: null } : {}),
          updatedAt: new Date(),
        },
      });

      if (transitioning) {
        await this.thread.emitWithin(db, tenantId, {
          engagementId,
          eventType: resolving ? 'ticket_resolved' : 'ticket_status_changed',
          actorType: 'user',
          actorId: actorUserId,
          payload: {
            ticketId,
            from: existing.status,
            to: updated.status,
            ...(input.resolutionNote ? { note: input.resolutionNote.trim() } : {}),
          },
        });
      }
      return this.toDto(db, updated);
    });
  }

  async remove(tenantId: string, engagementId: string, ticketId: string, actorRole: string): Promise<void> {
    if (actorRole !== 'admin' && actorRole !== 'sales_manager') {
      throw new ForbiddenException('only_managers_can_delete_tickets');
    }
    await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.engagementTicket.findUnique({ where: { id: ticketId } });
      if (!existing || existing.engagementId !== engagementId) throw new NotFoundException('ticket_not_found');
      await db.engagementTicket.delete({ where: { id: ticketId } });
    });
  }

  /** Manager dashboard: open + in_progress tickets across the tenant. */
  async listOpenForTenant(tenantId: string, limit = 100): Promise<OpenTicketSummary[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.engagementTicket.findMany({
        where: { tenantId, status: { in: ['open', 'in_progress'] } },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        take: Math.min(limit, 500),
        include: {
          engagement: { select: { name: true, clientEmail: true } },
        },
      });
      const userIds = unique([
        ...rows.map((r) => r.raisedByUserId).filter((x): x is string => !!x),
        ...rows.map((r) => r.assignedTo).filter((x): x is string => !!x),
      ]);
      const userMap = await loadUserEmails(db, userIds);
      const now = Date.now();
      return rows.map((r) => ({
        id: r.id,
        engagementId: r.engagementId,
        engagementName: r.engagement?.name ?? null,
        clientEmail: r.engagement?.clientEmail ?? '',
        category: r.category as TicketCategory,
        priority: r.priority as TicketPriority,
        status: r.status as TicketStatus,
        title: r.title,
        raisedByDisplay: r.raisedByUserId ? userMap.get(r.raisedByUserId) ?? null : r.raisedByEmail ?? null,
        assignedToDisplay: r.assignedTo ? userMap.get(r.assignedTo) ?? null : null,
        createdAt: r.createdAt.toISOString(),
        ageDays: Math.floor((now - r.createdAt.getTime()) / 86_400_000),
      }));
    });
  }

  // ── Internals ───────────────────────────────────────────────────────

  private async toDto(
    db: PrismaTx,
    r: {
      id: string;
      engagementId: string;
      category: string;
      priority: string;
      status: string;
      title: string;
      description: string | null;
      raisedBy: string;
      raisedByUserId: string | null;
      raisedByEmail: string | null;
      assignedTo: string | null;
      resolvedAt: Date | null;
      resolutionNote: string | null;
      createdAt: Date;
      updatedAt: Date;
    },
  ): Promise<TicketRow> {
    const userIds = [r.raisedByUserId, r.assignedTo].filter((x): x is string => !!x);
    const userMap = userIds.length > 0 ? await loadUserEmails(db, userIds) : new Map<string, string>();
    return {
      id: r.id,
      engagementId: r.engagementId,
      category: r.category as TicketCategory,
      priority: r.priority as TicketPriority,
      status: r.status as TicketStatus,
      title: r.title,
      description: r.description,
      raisedBy: r.raisedBy as TicketRaisedBy,
      raisedByUserId: r.raisedByUserId,
      raisedByEmail: r.raisedByEmail,
      raisedByDisplay: r.raisedByUserId ? userMap.get(r.raisedByUserId) ?? null : r.raisedByEmail ?? null,
      assignedTo: r.assignedTo,
      assignedToDisplay: r.assignedTo ? userMap.get(r.assignedTo) ?? null : null,
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      resolutionNote: r.resolutionNote,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }
}

// ── Module-local helpers ────────────────────────────────────────────

async function assertEngagementExists(db: PrismaTx, engagementId: string): Promise<void> {
  const exists = await db.engagement.findUnique({
    where: { id: engagementId },
    select: { id: true },
  });
  if (!exists) throw new NotFoundException('engagement_not_found');
}

export async function loadUserEmails(db: PrismaTx, ids: string[]): Promise<Map<string, string>> {
  const list = unique(ids);
  if (list.length === 0) return new Map();
  const users = await db.user.findMany({
    where: { id: { in: list } },
    select: { id: true, email: true },
  });
  return new Map(users.map((u) => [u.id, u.email]));
}

function unique<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
