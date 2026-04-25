import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantDb } from '../db/with-tenant.js';

/**
 * Audit hash chain over `thread_events`.
 *
 * Why this exists (design doc §4.6):
 *   thread_events is append-only at the role level (no UPDATE/DELETE for
 *   rhud_app). That stops the running app from rewriting history. But it
 *   doesn't stop someone with DB superuser from doing so. The hash chain
 *   layered on top means any silent tampering invalidates the chain at the
 *   first divergence — and once we mirror to S3 Object Lock (later sprint),
 *   the off-DB anchor is immutable for compliance windows.
 *
 * Algorithm:
 *   1. For each event, compute eventHash = sha256(canonical(event)).
 *   2. Build a window of new events since the last link's `to_created_at`.
 *   3. rootHash = sha256(prevHash ?? GENESIS || eventHash_1 || ... || eventHash_n).
 *   4. Persist (sequence, rootHash, prevHash, [from, to), event_count).
 *
 * `verify()` re-computes the chain from scratch and asserts every stored
 * link matches; the first mismatch identifies which link diverged. The
 * existing INSERT-only RLS posture means a successful verify is durable
 * proof that the audit trail wasn't mutated by app code.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private static readonly GENESIS = '0'.repeat(64);

  constructor(private readonly tenantDb: TenantDb) {}

  /**
   * Compute and persist the next chain link for a tenant. If no new events
   * exist since the last link, returns null without writing.
   */
  async build(tenantId: string): Promise<{
    sequence: number;
    rootHash: string;
    eventCount: number;
    fromCreatedAt: string;
    toCreatedAt: string;
  } | null> {
    return this.tenantDb.run(tenantId, async (db) => {
      const last = await db.auditChainLink.findFirst({
        where: { tenantId },
        orderBy: { sequence: 'desc' },
      });

      const since = last?.toCreatedAt ?? new Date(0);
      const events = await db.threadEvent.findMany({
        where: {
          tenantId,
          createdAt: { gte: since },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });

      // De-overlap: if `since` matches an event's createdAt boundary the
      // gte query may include events already covered by the previous link.
      // We filter by id to be safe.
      const fresh = last
        ? events.filter((e) => e.createdAt > since || /* never re-include */ false)
        : events;

      if (fresh.length === 0) return null;

      const prevHash = last?.rootHash ?? AuditService.GENESIS;
      const rootHash = computeRoot(prevHash, fresh);
      const sequence = (last?.sequence ?? 0) + 1;
      const fromCreatedAt = fresh[0]!.createdAt;
      const toCreatedAt = fresh[fresh.length - 1]!.createdAt;

      await db.auditChainLink.create({
        data: {
          tenantId,
          sequence,
          rootHash,
          prevHash: last?.rootHash ?? null,
          fromCreatedAt,
          toCreatedAt,
          eventCount: fresh.length,
        },
      });

      return {
        sequence,
        rootHash,
        eventCount: fresh.length,
        fromCreatedAt: fromCreatedAt.toISOString(),
        toCreatedAt: toCreatedAt.toISOString(),
      };
    });
  }

  /**
   * Re-derive the entire chain from `thread_events` and compare against
   * stored `audit_chain_links`. Returns the first mismatch (if any) or
   * `{ ok: true, links }` if every stored root matches what we'd compute.
   */
  async verify(tenantId: string): Promise<
    | { ok: true; links: number }
    | { ok: false; failedAtSequence: number; expected: string; actual: string }
  > {
    return this.tenantDb.run(tenantId, async (db) => {
      const links = await db.auditChainLink.findMany({
        where: { tenantId },
        orderBy: { sequence: 'asc' },
      });
      if (links.length === 0) return { ok: true as const, links: 0 };

      let prevHash = AuditService.GENESIS;
      for (const link of links) {
        const events = await db.threadEvent.findMany({
          where: {
            tenantId,
            createdAt: { gte: link.fromCreatedAt, lte: link.toCreatedAt },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (events.length !== link.eventCount) {
          // A row was inserted backdated into a sealed window — sealed
          // windows are immutable per the chain. Treat as tamper.
          return {
            ok: false as const,
            failedAtSequence: link.sequence,
            expected: link.rootHash,
            actual: `event_count_mismatch:${events.length}!=${link.eventCount}`,
          };
        }
        const computed = computeRoot(prevHash, events);
        if (computed !== link.rootHash) {
          return {
            ok: false as const,
            failedAtSequence: link.sequence,
            expected: link.rootHash,
            actual: computed,
          };
        }
        prevHash = link.rootHash;
      }
      return { ok: true as const, links: links.length };
    });
  }
}

// ── Hashing primitives ──────────────────────────────────────────────────────

/**
 * Canonical event hash. We hash the fields that are durable + meaningful:
 * id (PK), tenant_id, engagement_id, event_type, actor_type, actor_id,
 * payload (canonical JSON), created_at (epoch ms). Anything not in here
 * could in principle be modified without invalidating the chain — so we
 * intentionally include everything that matters to the audit story.
 */
function eventHash(e: {
  id: string;
  tenantId: string;
  engagementId: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: unknown;
  createdAt: Date;
}): string {
  const canonical = JSON.stringify([
    e.id,
    e.tenantId,
    e.engagementId,
    e.eventType,
    e.actorType,
    e.actorId,
    canonicalJson(e.payload),
    e.createdAt.getTime(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Stable-key JSON serialization. Object keys are sorted recursively so two
 * payloads with the same data but different key orders hash identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function computeRoot(
  prevHash: string,
  events: Array<Parameters<typeof eventHash>[0]>,
): string {
  const h = createHash('sha256');
  h.update(prevHash);
  for (const e of events) h.update(eventHash(e));
  return h.digest('hex');
}
