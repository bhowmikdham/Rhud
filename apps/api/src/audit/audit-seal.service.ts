import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { UnscopedDb } from '../db/unscoped-db.js';
import { AuditService } from './audit.service.js';

/**
 * Nightly audit-chain seal — the first consumer of the app-wide scheduler
 * foundation (ScheduleModule.forRoot() in AppModule).
 *
 * Why a cron: AuditService.build() is exposed as a manual admin endpoint, but
 * compliance wants a *standing* guarantee that the hash chain is sealed and
 * verified without anyone pressing a button. This sweeps every tenant once a
 * night, sealing new thread_events into the chain and re-verifying it still
 * reconciles. The result feeds the admin "chain sealed nightly, N divergences"
 * badge (GET /audit/status).
 *
 * Honest scope: this proves *app-level* tamper-evidence — that rhud_app did not
 * rewrite history. It does NOT yet prove immunity to a DB superuser; that needs
 * the off-DB WORM anchor (mirror rootHash to S3 Object-Lock), a later milestone.
 * See docs/future-of-rhud.md Bet 4.
 *
 * Hardening deferred: idempotency + retry via a real job queue (BullMQ/Redis)
 * is the follow-up. v1 relies on single-node serialization (one @Cron + an
 * in-process overlap guard) and per-tenant try/catch so one bad tenant can't
 * abort the sweep. build() is itself safe to re-run — it only ever seals events
 * newer than the last link, so a double-fire just produces finer-grained links.
 */
@Injectable()
export class AuditSealService {
  private readonly logger = new Logger(AuditSealService.name);
  private running = false;

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly audit: AuditService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'audit-chain-seal' })
  async nightlySeal(): Promise<void> {
    // Master switch (default on) + never fire under test. Read process.env
    // directly to match the house pattern (notifications/email/odoo services).
    if (process.env.AUDIT_SEAL_ENABLED === 'false') return;
    if (process.env.NODE_ENV === 'test') return;
    await this.sealAllTenants('cron');
  }

  /**
   * Seal + verify every tenant's audit chain. Returns a summary; also callable
   * from ops tooling. Serialized by an overlap guard so a slow sweep can't
   * stack on the next tick on this single-node box.
   */
  async sealAllTenants(trigger: 'cron' | 'manual' = 'manual'): Promise<{
    tenants: number;
    sealed: number;
    skipped: number;
    failed: number;
    divergences: number;
  }> {
    const summary = { tenants: 0, sealed: 0, skipped: 0, failed: 0, divergences: 0 };
    if (this.running) {
      this.logger.warn('audit seal sweep already in flight — skipping this tick');
      return summary;
    }
    this.running = true;
    try {
      const tenantIds = await this.unscoped.findAllTenantIds();
      summary.tenants = tenantIds.length;

      for (const tenantId of tenantIds) {
        try {
          const built = await this.audit.build(tenantId);
          if (built) summary.sealed += 1;
          else summary.skipped += 1;

          const verify = await this.audit.verify(tenantId);
          if (!verify.ok) {
            summary.divergences += 1;
            // A divergence means the chain no longer reconciles — i.e. a sealed
            // window was mutated. Loud, per-tenant, and actionable.
            this.logger.error(
              `audit chain DIVERGENCE tenant=${tenantId} ` +
                `failedAtSequence=${verify.failedAtSequence} ` +
                `expected=${verify.expected} actual=${verify.actual}`,
            );
          }
        } catch (err) {
          // One tenant's failure must not abort the whole sweep.
          summary.failed += 1;
          this.logger.error(
            `audit seal failed tenant=${tenantId}: ${(err as Error).message}`,
          );
        }
      }

      this.logger.log(
        `audit seal sweep (${trigger}) done: ` +
          `tenants=${summary.tenants} sealed=${summary.sealed} ` +
          `skipped=${summary.skipped} failed=${summary.failed} ` +
          `divergences=${summary.divergences}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }
}
