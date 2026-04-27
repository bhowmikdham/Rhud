import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  resolveRoute,
  type RecipientRole,
  type TenantNotificationConfig,
  type ThreadEventType,
} from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { EmailTransport } from './email.transport.js';
import { renderEmail, type EmailContext } from './email.templates.js';

interface DispatchArgs {
  tenantId: string;
  engagementId: string;
  eventType: ThreadEventType;
  payload: Record<string, unknown>;
}

interface ResolvedRecipient {
  role: RecipientRole;
  email: string;
  userId?: string;
}

/**
 * Notifications service — turns a thread event into outbound emails.
 *
 * Async-aware: `dispatch()` returns a Promise that resolves once the
 * fan-out completes (or fails individually per recipient). Callers that
 * need to keep the request path snappy `void`-discard the return; tests
 * await it for assertions.
 *
 * Reliability posture: best-effort with per-recipient `Promise.allSettled`.
 * A transport failure is logged but does NOT throw — losing an email is
 * less bad than failing the upstream operation that triggered it. The
 * audit hash chain on thread_events is the durable record either way.
 *
 * BullMQ retries land in a follow-up sprint when SLA matters; the
 * interface here (one async call per event) makes that swap trivial.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly portalBase = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly transport: EmailTransport,
  ) {}

  async dispatch(args: DispatchArgs): Promise<{ sent: number; skipped: number; failed: number }> {
    const { recipients, ctx } = await this.resolve(args);
    if (recipients.length === 0) {
      return { sent: 0, skipped: 1, failed: 0 };
    }

    const results = await Promise.allSettled(
      recipients.map((r) => this.sendOne(args.eventType, ctx(r), r)),
    );

    let sent = 0;
    let failed = 0;
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value) sent += 1;
      else failed += 1;
    }
    return { sent, skipped: 0, failed };
  }

  /**
   * Read tenant config + engagement participants + decide who to email.
   * All DB reads happen inside a single tenant scope.
   */
  private async resolve(
    args: DispatchArgs,
  ): Promise<{ recipients: ResolvedRecipient[]; ctx: (r: ResolvedRecipient) => EmailContext }> {
    return this.tenantDb.run(args.tenantId, async (db) => {
      const engagement = await db.engagement.findUnique({
        where: { id: args.engagementId },
        include: {
          template: { select: { name: true } },
        },
      });
      if (!engagement) {
        this.logger.warn(`dispatch: engagement ${args.engagementId} not visible`);
        return { recipients: [], ctx: () => emptyCtx() };
      }

      const tenant = await db.tenant.findUnique({
        where: { id: args.tenantId },
        select: { notificationConfig: true },
      });

      const route = resolveRoute(
        args.eventType,
        (tenant?.notificationConfig as TenantNotificationConfig | null) ?? null,
      );
      if (route.length === 0) {
        return { recipients: [], ctx: () => emptyCtx() };
      }

      // Collect required user lookups based on the route.
      const userIds: string[] = [];
      if (route.includes('sales_employee')) userIds.push(engagement.salesEmployeeId);
      if (route.includes('sales_manager') && engagement.salesManagerId) {
        userIds.push(engagement.salesManagerId);
      }

      const users = userIds.length
        ? await db.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true },
          })
        : [];
      const usersById = new Map(users.map((u) => [u.id, u]));

      // The proposal_sent event is always rep-driven (they email the
      // client from their own Outlook/Gmail account, with the PDF
      // attached). Rhud must NOT also send a noreply "your proposal"
      // email to the client — that's the path we explicitly killed
      // when moving to the bridge flow. Team-side recipients (sales
      // employee, sales manager) still get notified.
      //
      // Phase 2 (Outlook OAuth) replaces this carve-out with a real
      // send via the rep's account; the client recipient is filtered
      // here because *Rhud* never emails them, regardless of whether
      // the rep used the bridge mailto path or the OAuth path.
      const skipClient = args.eventType === 'proposal_sent';

      const recipients: ResolvedRecipient[] = [];
      for (const role of route) {
        if (role === 'sales_employee') {
          const u = usersById.get(engagement.salesEmployeeId);
          if (u) recipients.push({ role, email: u.email, userId: u.id });
        } else if (role === 'sales_manager' && engagement.salesManagerId) {
          const u = usersById.get(engagement.salesManagerId);
          if (u) recipients.push({ role, email: u.email, userId: u.id });
        } else if (role === 'client' && !skipClient) {
          recipients.push({ role, email: engagement.clientEmail });
        }
      }

      const portalUrl = `${this.portalBase.replace(/\/$/, '')}/engagements/${engagement.id}`;
      const baseCtx: Omit<EmailContext, 'recipientRole'> = {
        engagementId: engagement.id,
        templateName: engagement.template.name,
        clientEmail: engagement.clientEmail,
        portalUrl,
        payload: args.payload,
      };

      return {
        recipients,
        ctx: (r: ResolvedRecipient): EmailContext => ({ ...baseCtx, recipientRole: r.role }),
      };
    });
  }

  private async sendOne(
    eventType: ThreadEventType,
    ctx: EmailContext,
    recipient: ResolvedRecipient,
  ): Promise<boolean> {
    const rendered = renderEmail(eventType, ctx);
    if (!rendered) {
      // No template defined for this event type — silently skip. Many
      // events (link_opened, node_answered) intentionally have no email.
      return false;
    }
    try {
      await this.transport.send({
        to: recipient.email,
        subject: rendered.subject,
        textBody: rendered.textBody,
        notificationId: randomUUID(),
      });
      return true;
    } catch (err) {
      this.logger.error(
        `email send failed for ${recipient.email} on ${eventType}: ${(err as Error).message}`,
      );
      return false;
    }
  }
}

function emptyCtx(): EmailContext {
  return {
    engagementId: '',
    templateName: '',
    clientEmail: '',
    portalUrl: '',
    recipientRole: 'sales_employee',
    payload: {},
  };
}
