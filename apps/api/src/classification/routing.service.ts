/**
 * Routing service — assigns a reviewer based on tenant rules.
 *
 * After classification:
 *   1. look up routing rules for the engagement's category, ordered
 *      by `position` asc (first match wins for MVP);
 *   2. set engagement.assignedReviewerId to the matched user;
 *   3. emit reviewer_assigned (first time) or reviewer_reassigned
 *      (subsequent automatic assignment overwrites a prior one).
 *
 * Manual reassign path:
 *   - reassignReviewer() lets an admin/manager pick a reviewer
 *     directly. Always emits reviewer_reassigned (whether or not the
 *     opportunity had one). Pass `reviewerUserId: null` to clear.
 *
 * No-rule case:
 *   - applyForEngagement() silently no-ops. The opportunity stays
 *     unassigned until manual intervention.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import type {
  ReassignReviewerInput,
  RoutingRuleRow,
  UpsertRoutingRuleInput,
} from '@rhud/shared';

@Injectable()
export class RoutingService {
  private readonly logger = new Logger(RoutingService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
  ) {}

  /**
   * Look up + apply the matching rule for the engagement's category.
   * Idempotent: if the matched reviewer is already assigned, no event
   * is emitted and the existing assignment stays.
   *
   * Best-effort: errors are logged, not thrown, so a classification
   * cycle isn't aborted by a routing issue.
   */
  async applyForEngagement(tenantId: string, engagementId: string): Promise<void> {
    try {
      await this.tenantDb.run(tenantId, async (db) => {
        const eng = await db.engagement.findUnique({
          where: { id: engagementId },
          select: {
            id: true,
            categorySlug: true,
            assignedReviewerId: true,
          },
        });
        if (!eng || !eng.categorySlug) return;

        // First match wins (lowest position).
        const rule = await db.opportunityRoutingRule.findFirst({
          where: { tenantId, categorySlug: eng.categorySlug },
          orderBy: { position: 'asc' },
        });
        if (!rule) return; // no rule — leave unassigned

        if (eng.assignedReviewerId === rule.reviewerUserId) return; // already assigned

        const isReassign = eng.assignedReviewerId != null;
        const previousReviewerUserId = eng.assignedReviewerId;

        await db.engagement.update({
          where: { id: engagementId },
          data: { assignedReviewerId: rule.reviewerUserId },
        });

        await this.thread.emitWithin(db, tenantId, {
          engagementId,
          eventType: isReassign ? 'reviewer_reassigned' : 'reviewer_assigned',
          actorType: 'system',
          actorId: null,
          payload: {
            reviewerUserId: rule.reviewerUserId,
            categorySlug: eng.categorySlug,
            ruleId: rule.id,
            ...(previousReviewerUserId ? { previousReviewerUserId } : {}),
          },
        });
      });
    } catch (e) {
      this.logger.warn(
        `routing apply failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    }
  }

  /** Manual reassignment by an admin / manager. */
  async reassignReviewer(
    tenantId: string,
    engagementId: string,
    input: ReassignReviewerInput,
    actorUserId: string,
  ): Promise<{ assignedReviewerId: string | null }> {
    return this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        select: { id: true, assignedReviewerId: true },
      });
      if (!eng) throw new NotFoundException('engagement_not_found');

      // When setting to a non-null user, verify the user is in this tenant.
      if (input.reviewerUserId) {
        const u = await db.user.findUnique({
          where: { id: input.reviewerUserId },
          select: { id: true, tenantId: true },
        });
        if (!u || u.tenantId !== tenantId) {
          throw new BadRequestException('reviewer_not_in_tenant');
        }
      }

      const previousReviewerUserId = eng.assignedReviewerId;
      if (previousReviewerUserId === (input.reviewerUserId ?? null)) {
        // No-op — same value.
        return { assignedReviewerId: eng.assignedReviewerId };
      }

      await db.engagement.update({
        where: { id: engagementId },
        data: { assignedReviewerId: input.reviewerUserId ?? null },
      });

      await this.thread.emitWithin(db, tenantId, {
        engagementId,
        eventType: 'reviewer_reassigned',
        actorType: 'user',
        actorId: actorUserId,
        payload: {
          reviewerUserId: input.reviewerUserId,
          ...(previousReviewerUserId ? { previousReviewerUserId } : {}),
          ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
        },
      });

      return { assignedReviewerId: input.reviewerUserId ?? null };
    });
  }

  // ── Routing rules CRUD (admin) ──────────────────────────────────

  async listRules(tenantId: string): Promise<RoutingRuleRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.opportunityRoutingRule.findMany({
        where: { tenantId },
        orderBy: [{ categorySlug: 'asc' }, { position: 'asc' }],
        include: { reviewer: { select: { id: true, email: true } } },
      });
      return rows.map((r) => ({
        id: r.id,
        categorySlug: r.categorySlug,
        reviewerUserId: r.reviewerUserId,
        reviewerEmail: r.reviewer?.email ?? null,
        position: r.position,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      }));
    });
  }

  async upsertRule(tenantId: string, input: UpsertRoutingRuleInput): Promise<RoutingRuleRow> {
    if (!input.categorySlug?.trim()) throw new BadRequestException('category_required');
    if (!input.reviewerUserId) throw new BadRequestException('reviewer_required');

    return this.tenantDb.run(tenantId, async (db) => {
      // Verify category exists in the tenant's visible taxonomy.
      const cat = await db.opportunityCategory.findFirst({
        where: { slug: input.categorySlug },
      });
      if (!cat) throw new BadRequestException('unknown_category');

      // Verify reviewer is in the tenant.
      const u = await db.user.findUnique({
        where: { id: input.reviewerUserId },
        select: { id: true, tenantId: true, email: true },
      });
      if (!u || u.tenantId !== tenantId) {
        throw new BadRequestException('reviewer_not_in_tenant');
      }

      const row = await db.opportunityRoutingRule.upsert({
        where: {
          tenantId_categorySlug_reviewerUserId: {
            tenantId,
            categorySlug: input.categorySlug,
            reviewerUserId: input.reviewerUserId,
          },
        },
        create: {
          tenantId,
          categorySlug: input.categorySlug,
          reviewerUserId: input.reviewerUserId,
          position: input.position ?? 0,
        },
        update: {
          position: input.position ?? 0,
          updatedAt: new Date(),
        },
      });

      return {
        id: row.id,
        categorySlug: row.categorySlug,
        reviewerUserId: row.reviewerUserId,
        reviewerEmail: u.email,
        position: row.position,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async deleteRule(tenantId: string, ruleId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      const existing = await db.opportunityRoutingRule.findUnique({
        where: { id: ruleId },
      });
      if (!existing || existing.tenantId !== tenantId) {
        throw new NotFoundException('rule_not_found');
      }
      await db.opportunityRoutingRule.delete({ where: { id: ruleId } });
    });
  }
}
