import { Injectable } from '@nestjs/common';
import type { ActorType, ThreadEventType } from '@rhud/shared';
import type { PrismaTx } from '../db/with-tenant.js';
import { TenantDb } from '../db/with-tenant.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export interface EmitArgs {
  engagementId: string;
  eventType: ThreadEventType;
  actorType: ActorType;
  actorId?: string | null;
  payload?: Record<string, unknown>;
}

/**
 * Thread events are the audit trail for an engagement (design doc §4.7).
 *
 * Two emission modes:
 *   - `emit(tenantId, args)` — opens its own transaction via TenantDb,
 *     writes the event, and fans out notifications post-commit.
 *   - `emitWithin(tx, ...)`  — writes inside an existing transaction (used
 *     when the event must be atomic with the surrounding work, e.g.
 *     issuing a link writes Engagement + token + `link_issued` in one tx).
 *     Notifications are NOT dispatched from emitWithin — the caller is
 *     responsible for invoking `dispatchAfterCommit()` once their tx ends.
 *
 * Why split: notification dispatch is network I/O; binding it to the tx
 * lifetime would (a) hold transactions open for HTTP calls, (b) lose the
 * email if the tx rolls back, (c) make rollback semantics weird. Writing
 * the event in-tx and dispatching after-commit is the standard pattern.
 *
 * The DB role grants are SELECT + INSERT only on `thread_events` (no
 * UPDATE/DELETE). That's the strongest enforcement we have for audit
 * integrity in MVP — even a buggy service can't rewrite history.
 */
@Injectable()
export class ThreadService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly notifications: NotificationsService,
  ) {}

  async emit(tenantId: string, args: EmitArgs): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await this.emitWithin(db, tenantId, args);
    });
    // Fire-and-forget; failures are logged inside the dispatcher.
    void this.dispatchAfterCommit(tenantId, args);
  }

  async emitWithin(db: PrismaTx, tenantId: string, args: EmitArgs): Promise<void> {
    await db.threadEvent.create({
      data: {
        tenantId,
        engagementId: args.engagementId,
        eventType: args.eventType,
        actorType: args.actorType,
        actorId: args.actorId ?? null,
        payload: (args.payload ?? {}) as unknown as object,
      },
    });
  }

  /**
   * Call this AFTER a tenantDb.run(...) that contained an `emitWithin`. It
   * triggers the notification fan-out for that event. Returns a Promise the
   * caller may await (in tests) or void (in handlers — fire-and-forget).
   */
  dispatchAfterCommit(tenantId: string, args: EmitArgs): Promise<unknown> {
    return this.notifications.dispatch({
      tenantId,
      engagementId: args.engagementId,
      eventType: args.eventType,
      payload: args.payload ?? {},
    });
  }

  async listForEngagement(
    tenantId: string,
    engagementId: string,
  ): Promise<
    Array<{
      id: string;
      eventType: string;
      actorType: string;
      actorId: string | null;
      payload: unknown;
      createdAt: string;
    }>
  > {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.threadEvent.findMany({
        where: { engagementId },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        actorType: r.actorType,
        actorId: r.actorId,
        payload: r.payload,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }
}
