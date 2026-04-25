import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  resolveNext,
  validateAnswerShape,
  type Answer,
  type TemplateNode,
  type TemplateWithNodes,
} from '@rhud/shared';
import { TenantDb } from '../db/with-tenant.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { ThreadService } from '../thread/thread.service.js';
import { S3Service } from '../storage/s3.service.js';
import { deviceFingerprint, fingerprintsEqual, verifyToken } from './token.util.js';

export interface RequestContext {
  ip: string;
  userAgent: string;
  acceptLanguage?: string;
}

interface ResolvedToken {
  tokenId: string;
  tenantId: string;
  engagementId: string;
}

export interface GatheringState {
  engagementId: string;
  templateName: string;
  status: string;
  // Current node to render next, or null if scope already submitted.
  currentNode: TemplateNode | null;
  // Existing answers so the client can resume mid-tree.
  answers: Record<string, Answer>;
  // Files already uploaded (filenames) per node.
  files: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>>;
}

/**
 * Client-facing gathering flow. No JWT — authority comes from the token in
 * the URL path. Each method:
 *   1. Resolves the token (UnscopedDb scan + argon2 verify) → tenantId.
 *   2. Records the access event + (on first use) binds the device fingerprint.
 *   3. Switches to TenantDb for the actual work.
 */
@Injectable()
export class GatheringService {
  private readonly logger = new Logger(GatheringService.name);

  constructor(
    private readonly unscoped: UnscopedDb,
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly s3: S3Service,
  ) {}

  // ── Token resolution ─────────────────────────────────────────────────────

  private async resolveToken(plaintext: string, ctx: RequestContext): Promise<ResolvedToken> {
    if (!plaintext || plaintext.length < 16) {
      throw new UnauthorizedException('invalid_token');
    }

    const candidates = await this.unscoped.findActiveGatheringTokens();

    let matched: typeof candidates[number] | null = null;
    for (const c of candidates) {
      if (await verifyToken(c.tokenHash, plaintext)) {
        matched = c;
        break;
      }
    }
    if (!matched) throw new UnauthorizedException('invalid_or_expired_token');

    const fingerprint = deviceFingerprint(ctx);

    // First-use binding, or fingerprint-mismatch detection. Done within the
    // tenant scope so RLS holds.
    let firstUse = false;
    const linkOpenedPayload = { ip: redactIp(ctx.ip), userAgent: ctx.userAgent };
    await this.tenantDb.run(matched.tenantId, async (db) => {
      if (!matched!.boundFingerprintHash) {
        firstUse = true;
        await db.gatheringToken.update({
          where: { id: matched!.id },
          data: {
            boundFingerprintHash: fingerprint,
            accessCount: { increment: 1 },
          },
        });
        await this.thread.emitWithin(db, matched!.tenantId, {
          engagementId: matched!.engagementId,
          eventType: 'link_opened',
          actorType: 'client',
          actorId: null,
          payload: linkOpenedPayload,
        });
      } else {
        if (!fingerprintsEqual(matched!.boundFingerprintHash, fingerprint)) {
          this.logger.warn(`gathering token ${matched!.id}: device fingerprint mismatch`);
          throw new UnauthorizedException('device_changed');
        }
        await db.gatheringToken.update({
          where: { id: matched!.id },
          data: { accessCount: { increment: 1 } },
        });
      }
    });

    if (firstUse) {
      void this.thread.dispatchAfterCommit(matched.tenantId, {
        engagementId: matched.engagementId,
        eventType: 'link_opened',
        actorType: 'client',
        payload: linkOpenedPayload,
      });
    }

    return {
      tokenId: matched.id,
      tenantId: matched.tenantId,
      engagementId: matched.engagementId,
    };
  }

  // ── State / cursor ───────────────────────────────────────────────────────

  async getState(plaintext: string, ctx: RequestContext): Promise<GatheringState> {
    const t = await this.resolveToken(plaintext, ctx);
    return this.tenantDb.run(t.tenantId, async (db) => {
      const engagement = await db.engagement.findUniqueOrThrow({
        where: { id: t.engagementId },
        include: {
          template: { include: { nodes: { orderBy: { position: 'asc' } } } },
          answers: true,
          files: true,
        },
      });
      const tmpl: TemplateWithNodes = {
        id: engagement.template.id,
        tenantId: engagement.template.tenantId,
        serviceLine: engagement.template.serviceLine,
        name: engagement.template.name,
        version: engagement.template.version,
        status: engagement.template.status as TemplateWithNodes['status'],
        rootNodeId: engagement.template.rootNodeId,
        createdAt: engagement.template.createdAt.toISOString(),
        updatedAt: engagement.template.updatedAt.toISOString(),
        nodes: engagement.template.nodes.map((n) => ({
          id: n.id,
          templateId: n.templateId,
          tenantId: n.tenantId,
          question: n.question,
          nodeType: n.nodeType as TemplateNode['nodeType'],
          options: (n.options as unknown as TemplateNode['options']) ?? null,
          allowFiles: n.allowFiles,
          nextRules: (n.nextRules as unknown as TemplateNode['nextRules']) ?? [],
          position: n.position,
        })),
      };

      const answersMap: Record<string, Answer> = {};
      for (const a of engagement.answers) {
        answersMap[a.nodeId] = a.answer as Answer;
      }
      const filesMap: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>> = {};
      for (const f of engagement.files) {
        if (!filesMap[f.nodeId]) filesMap[f.nodeId] = [];
        filesMap[f.nodeId]!.push({
          id: f.id,
          filename: f.filename,
          sizeBytes: Number(f.sizeBytes),
        });
      }

      const currentNode = engagement.submittedAt
        ? null
        : findCurrentNode(tmpl, answersMap);

      return {
        engagementId: engagement.id,
        templateName: tmpl.name,
        status: engagement.status,
        currentNode,
        answers: answersMap,
        files: filesMap,
      };
    });
  }

  // ── Submit one answer ─────────────────────────────────────────────────────

  async submitAnswer(
    plaintext: string,
    ctx: RequestContext,
    args: { nodeId: string; answer: Answer },
  ): Promise<{ next: { kind: 'node'; node: TemplateNode } | { kind: 'end' } }> {
    const t = await this.resolveToken(plaintext, ctx);

    const result = await this.tenantDb.run(t.tenantId, async (db) => {
      // Find the node to validate against. Done inside the same scope.
      const dbNode = await db.templateNode.findUnique({ where: { id: args.nodeId } });
      if (!dbNode) throw new NotFoundException('node_not_found');

      const node: TemplateNode = {
        id: dbNode.id,
        templateId: dbNode.templateId,
        tenantId: dbNode.tenantId,
        question: dbNode.question,
        nodeType: dbNode.nodeType as TemplateNode['nodeType'],
        options: (dbNode.options as unknown as TemplateNode['options']) ?? null,
        allowFiles: dbNode.allowFiles,
        nextRules: (dbNode.nextRules as unknown as TemplateNode['nextRules']) ?? [],
        position: dbNode.position,
      };

      const shape = validateAnswerShape(node.nodeType, args.answer);
      if (!shape.ok) throw new BadRequestException({ code: 'invalid_answer_shape', reason: shape.reason });

      await db.engagementAnswer.upsert({
        where: { engagementId_nodeId: { engagementId: t.engagementId, nodeId: args.nodeId } },
        update: { answer: args.answer as unknown as object },
        create: {
          tenantId: t.tenantId,
          engagementId: t.engagementId,
          nodeId: args.nodeId,
          answer: args.answer as unknown as object,
        },
      });

      // First answer transitions issued → in_progress.
      await db.engagement.updateMany({
        where: { id: t.engagementId, status: 'issued' },
        data: { status: 'in_progress' },
      });

      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'node_answered',
        actorType: 'client',
        payload: { nodeId: args.nodeId },
      });

      const r = resolveNext(node, args.answer);
      if (r.kind === 'invalid') {
        throw new BadRequestException({ code: 'tree_resolution_failed', reason: r.reason });
      }
      if (r.kind === 'end') return { next: { kind: 'end' } as const };

      const nextDbNode = await db.templateNode.findUnique({ where: { id: r.nodeId } });
      if (!nextDbNode) throw new BadRequestException('next_node_not_found');
      return {
        next: {
          kind: 'node' as const,
          node: {
            id: nextDbNode.id,
            templateId: nextDbNode.templateId,
            tenantId: nextDbNode.tenantId,
            question: nextDbNode.question,
            nodeType: nextDbNode.nodeType as TemplateNode['nodeType'],
            options: (nextDbNode.options as unknown as TemplateNode['options']) ?? null,
            allowFiles: nextDbNode.allowFiles,
            nextRules: (nextDbNode.nextRules as unknown as TemplateNode['nextRules']) ?? [],
            position: nextDbNode.position,
          },
        },
      };
    });

    // Suppressed by default in the route map (too noisy), but dispatch
    // anyway so per-tenant overrides can opt in.
    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'node_answered',
      actorType: 'client',
      payload: { nodeId: args.nodeId },
    });

    return result;
  }

  // ── Files: signed PUT URL ─────────────────────────────────────────────────

  async createSignedUploadUrl(
    plaintext: string,
    ctx: RequestContext,
    args: { nodeId: string; filename: string; contentType: string; sizeBytes: number },
  ): Promise<{ uploadUrl: string; fileId: string; key: string; expiresAt: string }> {
    const t = await this.resolveToken(plaintext, ctx);

    if (args.sizeBytes > 50 * 1024 * 1024) {
      throw new BadRequestException('file_too_large');
    }

    const fileId = randomUUID();
    const key = S3Service.keyForEngagementFile({
      tenantId: t.tenantId,
      engagementId: t.engagementId,
      fileId,
      filename: args.filename,
    });

    const { url, expiresAt } = await this.s3.presignPut({ key, contentType: args.contentType });

    // Pre-record the file row so the client only needs to PUT.
    // The browser confirms with `confirmUpload` once S3 returns 200.
    const fileUploadedPayload = {
      nodeId: args.nodeId,
      filename: args.filename,
      sizeBytes: args.sizeBytes,
    };
    await this.tenantDb.run(t.tenantId, async (db) => {
      await db.engagementFile.create({
        data: {
          id: fileId,
          tenantId: t.tenantId,
          engagementId: t.engagementId,
          nodeId: args.nodeId,
          s3Key: key,
          filename: args.filename,
          sizeBytes: BigInt(args.sizeBytes),
          contentType: args.contentType,
        },
      });
      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'file_uploaded',
        actorType: 'client',
        payload: fileUploadedPayload,
      });
    });

    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'file_uploaded',
      actorType: 'client',
      payload: fileUploadedPayload,
    });

    return { uploadUrl: url, fileId, key, expiresAt };
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async submit(plaintext: string, ctx: RequestContext): Promise<{ status: string }> {
    const t = await this.resolveToken(plaintext, ctx);
    const result = await this.tenantDb.run(t.tenantId, async (db) => {
      await db.engagement.update({
        where: { id: t.engagementId },
        data: { status: 'submitted', submittedAt: new Date() },
      });
      await this.thread.emitWithin(db, t.tenantId, {
        engagementId: t.engagementId,
        eventType: 'scope_submitted',
        actorType: 'client',
      });
      // Revoke the token so it can't be reused after submission.
      await db.gatheringToken.update({
        where: { id: t.tokenId },
        data: { revokedAt: new Date() },
      });
      return { status: 'submitted' };
    });

    void this.thread.dispatchAfterCommit(t.tenantId, {
      engagementId: t.engagementId,
      eventType: 'scope_submitted',
      actorType: 'client',
    });

    return result;
  }
}

/**
 * Walk the template using existing answers and return the first node whose
 * answer is missing — that's the node to show next on resume.
 */
function findCurrentNode(tmpl: TemplateWithNodes, answers: Record<string, Answer>): TemplateNode | null {
  if (!tmpl.rootNodeId) return null;
  const byId = new Map(tmpl.nodes.map((n) => [n.id, n]));
  let cursor: string | null = tmpl.rootNodeId;
  const visited = new Set<string>();

  while (cursor) {
    if (visited.has(cursor)) return null; // cycle — shouldn't happen on published templates
    visited.add(cursor);
    const node = byId.get(cursor);
    if (!node) return null;
    const ans = answers[node.id];
    if (ans === undefined) return node;
    const r = resolveNext(node, ans);
    if (r.kind === 'end') return null;
    if (r.kind === 'invalid') return node;
    cursor = r.nodeId;
  }
  return null;
}

/** Mask the last octet of an IPv4 (or last group of IPv6) for thread payloads. */
function redactIp(ip: string): string {
  const v4 = ip.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/);
  if (v4) return `${v4[1]}.x`;
  if (ip.includes(':')) {
    const groups = ip.split(':');
    return `${groups.slice(0, -1).join(':')}:x`;
  }
  return ip;
}
