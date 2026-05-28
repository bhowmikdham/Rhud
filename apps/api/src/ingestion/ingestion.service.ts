/**
 * Direct-ingest pipeline core. See docs/direct-ingest.md.
 *
 * IngestionService is the channel-agnostic layer that sits between
 * channel adapters (paste-text UI, file-drop UI, future Outlook
 * extension, future WhatsApp webhook, future SES inbound) and the
 * existing extraction → engagement pipeline.
 *
 * Three entry points:
 *   - receive():            land an artifact, no engagement yet.
 *                           Webhooks call this when they fire and
 *                           leave a rep to promote later.
 *   - promote():            turn one or more existing artifacts
 *                           into an Engagement; runs extraction.
 *   - receiveAndPromote():  the in-app happy path — receive + promote
 *                           in one transaction. UI calls this.
 *
 * Artifacts always survive promotion (we never delete the rawText /
 * S3 object on success) so the audit chain has a faithful record of
 * "what the rep actually pasted / dropped / received." Failure paths
 * mark the artifact `failed` and surface `failureReason`.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb, type PrismaTx } from '../db/with-tenant.js';
import { ThreadService } from '../thread/thread.service.js';
import { S3Service } from '../storage/s3.service.js';
import { ExtractionService } from '../extraction/extraction.service.js';
import { EngagementsService } from '../engagements/engagements.service.js';
import type {
  EngagementSource,
  ArtifactKind,
} from '@rhud/shared';

/** Shape of a text-only artifact (paste-text, email body, transcript). */
export interface TextContent {
  rawText: string;
}

/** Shape of a file-shaped artifact (file or audio). Either provide the
 *  S3 key directly (when the rep used the two-step upload + presigned
 *  PUT) or the bytes inline (small files, server-side ingestion). */
export type FileContent =
  | {
      kind: 'inline';
      filename: string;
      contentType: string;
      bytes: Buffer;
    }
  | {
      kind: 'preuploaded';
      s3Key: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
    };

/** Shape of an email artifact (body + structured metadata). */
export interface EmailContent {
  subject?: string | null;
  from?: string | null;
  to?: string[];
  date?: Date | null;
  headers?: Record<string, unknown> | null;
  externalId?: string | null;
  bodyText: string;
}

/** Audio is currently file-shaped with optional pre-transcription text. */
export type AudioContent = FileContent & { transcript?: string };

export type ArtifactContent =
  | { kind: 'text'; data: TextContent }
  | { kind: 'file'; data: FileContent }
  | { kind: 'audio'; data: AudioContent }
  | { kind: 'email'; data: EmailContent };

export interface ReceiveArgs {
  tenantId: string;
  source: EngagementSource;
  content: ArtifactContent;
  /** UserId of the rep that triggered the receive (null for webhooks). */
  receivedBy?: string | null;
  /** Provider-side dedupe key (Message-ID, wamid). When set + a row
   *  with the same (tenantId, externalId) already exists, this is a
   *  no-op — returns the prior artifactId. */
  externalId?: string | null;
}

export interface PromoteArgs {
  tenantId: string;
  artifactIds: string[];
  salesEmployeeId: string;
  /** Rep-provided client metadata overrides. When LLM extraction also
   *  proposes values, the rep's overrides win. Sprint 1 keeps this
   *  simple — no LLM-extracted client metadata yet. */
  overrides?: {
    clientEmail?: string;
    clientName?: string | null;
    clientAddress?: string | null;
    contactName?: string | null;
    contactPhone?: string | null;
  };
  /** Free-text engagement label. */
  name?: string;
}

@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly thread: ThreadService,
    private readonly s3: S3Service,
    private readonly extraction: ExtractionService,
    private readonly engagements: EngagementsService,
  ) {}

  /**
   * Land an artifact. Doesn't create an engagement.
   *
   * For text/email artifacts the rawText is persisted directly on the
   * row. For file/audio, the caller has either pre-uploaded to S3
   * (via the presigned-PUT flow) or handed us inline bytes that we
   * write to S3 here. Either way, after this returns the artifact is
   * durable and discoverable by a later promote().
   */
  async receive(args: ReceiveArgs): Promise<{ artifactId: string }> {
    // Dedupe by (tenantId, externalId) when provided. Webhook providers
    // redeliver, so this is the safety belt.
    if (args.externalId) {
      const externalId = args.externalId;
      const existing = await this.tenantDb.run(args.tenantId, (db) =>
        db.ingestionArtifact.findFirst({
          where: { tenantId: args.tenantId, externalId },
          select: { id: true },
        }),
      );
      if (existing) return { artifactId: existing.id };
    }

    const created = await this.tenantDb.run(args.tenantId, async (db) =>
      db.ingestionArtifact.create({
        data: {
          tenantId: args.tenantId,
          source: args.source,
          kind: args.content.kind as ArtifactKind,
          status: 'received',
          ...(args.receivedBy ? { receivedBy: args.receivedBy } : {}),
          ...(args.externalId ? { externalId: args.externalId } : {}),
          ...this.materialiseContentFields(args.content),
        },
        select: { id: true },
      }),
    );

    // For inline file/audio artifacts the row exists but the S3 key
    // is empty until we write the bytes. Doing it OUTSIDE the row
    // creation means a failed S3 write leaves a visible failed-row
    // (status='received', s3_key=null) the rep can retry rather than
    // a silent drop. We update s3_key + status to 'processing' on
    // success.
    if (
      (args.content.kind === 'file' || args.content.kind === 'audio') &&
      args.content.data.kind === 'inline'
    ) {
      const data = args.content.data;
      const key = S3Service.keyForIngestionArtifact({
        tenantId: args.tenantId,
        artifactId: created.id,
        filename: data.filename,
      });
      try {
        await this.s3.putBytes({ key, contentType: data.contentType, body: data.bytes });
      } catch (e) {
        await this.tenantDb.run(args.tenantId, (db) =>
          db.ingestionArtifact.update({
            where: { id: created.id },
            data: {
              status: 'failed',
              failureReason: `s3_put_failed: ${(e as Error).message}`,
            },
          }),
        );
        throw e;
      }
      await this.tenantDb.run(args.tenantId, (db) =>
        db.ingestionArtifact.update({
          where: { id: created.id },
          data: {
            s3Key: key,
            sizeBytes: data.bytes.length,
          },
        }),
      );
    }

    this.logger.log(
      `ingestion artifact received id=${created.id} tenant=${args.tenantId} ` +
        `source=${args.source} kind=${args.content.kind}`,
    );
    return { artifactId: created.id };
  }

  /**
   * Promote one or more existing artifacts into a fresh engagement.
   *
   * Steps inside the transaction:
   *   1. Load the artifacts; refuse if any have already been promoted.
   *   2. Pick the "primary" artifact (most informative kind) for the
   *      Engagement.ingestionId back-pointer.
   *   3. Resolve the client email — rep override wins; otherwise pull
   *      from the email-shaped artifact's `from`; otherwise reject.
   *   4. Create the engagement via EngagementsService.createFromIngest.
   *   5. For each artifact: create the matching EngagementFile row
   *      (for text artifacts: materialise rawText to S3 first), tag
   *      it with originArtifactId, mark the artifact `promoted` +
   *      engagementId.
   *   6. Emit `requirements_ingested` once for the whole batch.
   *
   * After commit, kick off extraction on every EngagementFile. The
   * engagement transitions ingesting → submitted when extraction
   * completes (handled by ExtractionService's normal lifecycle).
   */
  async promote(args: PromoteArgs): Promise<{ engagementId: string; artifactIds: string[] }> {
    if (args.artifactIds.length === 0) {
      throw new BadRequestException('no_artifacts_to_promote');
    }

    // Idempotency: if these artifacts were already promoted, return the
    // opportunity they're linked to instead of erroring. Re-creating from
    // the same email (same Message-Id → same artifact) is a no-op that
    // hands back the original opportunity — that's what the rep wants when
    // they click Create twice, not an "artifact_already_promoted" 400.
    const existingEngagementId = await this.tenantDb.run(args.tenantId, async (db) => {
      const promoted = await db.ingestionArtifact.findFirst({
        where: {
          id: { in: args.artifactIds },
          tenantId: args.tenantId,
          status: 'promoted',
          engagementId: { not: null },
        },
        select: { engagementId: true },
      });
      return promoted?.engagementId ?? null;
    });
    if (existingEngagementId) {
      return { engagementId: existingEngagementId, artifactIds: args.artifactIds };
    }

    const { engagementId, source, kind } = await this.tenantDb.run(args.tenantId, async (db) => {
      const artifacts = await db.ingestionArtifact.findMany({
        where: { id: { in: args.artifactIds }, tenantId: args.tenantId },
      });
      if (artifacts.length !== args.artifactIds.length) {
        throw new NotFoundException('artifact_not_found');
      }
      // Defensive: a 'promoted' artifact with no engagementId is a corrupt
      // half-state (shouldn't happen — promotion sets both atomically). The
      // idempotency short-circuit above already handled the normal case.
      const corruptPromoted = artifacts.find((a) => a.status === 'promoted' && !a.engagementId);
      if (corruptPromoted) {
        throw new BadRequestException('artifact_already_promoted');
      }

      // Primary artifact: prefer email > text > file > audio, then
      // earliest received. This is the one the Engagement.ingestionId
      // points to; the others remain reachable via the artifacts[]
      // collection.
      const priorityByKind: Record<ArtifactKind, number> = {
        email: 0,
        text: 1,
        file: 2,
        audio: 3,
      };
      const sorted = [...artifacts].sort((a, b) => {
        const pa = priorityByKind[a.kind as ArtifactKind] ?? 99;
        const pb = priorityByKind[b.kind as ArtifactKind] ?? 99;
        if (pa !== pb) return pa - pb;
        return a.receivedAt.getTime() - b.receivedAt.getTime();
      });
      const primary = sorted[0]!;

      // Resolve clientEmail. Rep override > email artifact `from` > reject.
      let clientEmail = args.overrides?.clientEmail?.trim();
      if (!clientEmail) {
        const emailArt = artifacts.find((a) => a.kind === 'email');
        clientEmail = emailArt?.emailFrom ?? undefined;
      }
      if (!clientEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
        throw new BadRequestException('client_email_required');
      }

      // 1. Create the bare engagement (no template, no token).
      //    EngagementsService.createFromIngest opens its own
      //    tenant-scoped tx — we close ours, do that, then re-open
      //    for the per-artifact updates. The cost: createFromIngest
      //    isn't strictly atomic with the artifact attachment. We
      //    accept that for v1 because (a) the artifact rows already
      //    exist and won't disappear, (b) if attachment fails the
      //    engagement is recoverable (status='ingesting', no files),
      //    (c) a future retry just calls promote() again.
      //
      //    The alternative — passing the open `db` tx into
      //    createFromIngest — would couple the two services tighter
      //    than warranted at this stage.
      return {
        primaryId: primary.id,
        primarySource: primary.source as EngagementSource,
        primaryKind: primary.kind as ArtifactKind,
        artifactRows: artifacts,
        clientEmail,
      };
    }).then(async (ctx) => {
      const { engagementId } = await this.engagements.createFromIngest({
        tenantId: args.tenantId,
        salesEmployeeId: args.salesEmployeeId,
        source: ctx.primarySource,
        clientEmail: ctx.clientEmail,
        ingestionId: ctx.primaryId,
        ...(args.name ? { name: args.name } : {}),
        ...(args.overrides
          ? {
              client: {
                ...(args.overrides.clientName !== undefined    ? { clientName:    args.overrides.clientName }    : {}),
                ...(args.overrides.clientAddress !== undefined ? { clientAddress: args.overrides.clientAddress } : {}),
                ...(args.overrides.contactName !== undefined   ? { contactName:   args.overrides.contactName }   : {}),
                ...(args.overrides.contactPhone !== undefined  ? { contactPhone:  args.overrides.contactPhone }  : {}),
              },
            }
          : {}),
      });

      // 2. Attach each artifact to the engagement + materialise an
      //    EngagementFile row. Done in its own transaction.
      const fileIds = await this.tenantDb.run(args.tenantId, async (db) => {
        const createdFileIds: string[] = [];
        for (const art of ctx.artifactRows) {
          const fileId = await this.materialiseArtifactToFile(db, {
            tenantId: args.tenantId,
            engagementId,
            artifact: art,
          });
          if (fileId) createdFileIds.push(fileId);
          await db.ingestionArtifact.update({
            where: { id: art.id },
            data: {
              engagementId,
              status: 'promoted',
              promotedAt: new Date(),
            },
          });
        }

        // 3. Emit a single requirements_ingested event for the whole batch.
        await this.thread.emitWithin(db, args.tenantId, {
          engagementId,
          eventType: 'requirements_ingested',
          actorType: 'user',
          actorId: args.salesEmployeeId,
          payload: {
            source: ctx.primarySource,
            kind: ctx.primaryKind,
            artifactIds: args.artifactIds,
          },
        });

        return createdFileIds;
      });

      return {
        engagementId,
        source: ctx.primarySource,
        kind: ctx.primaryKind,
        fileIds,
      };
    });

    // Post-commit: kick off extraction on every newly-created file.
    // Fire-and-forget — extraction has its own retry/queue lifecycle.
    void this.extraction.kickoffForEngagement(args.tenantId, engagementId).catch((e) => {
      this.logger.warn(
        `extraction kickoff failed engagement=${engagementId}: ${(e as Error).message}`,
      );
    });

    // Post-commit notification dispatch for the requirements_ingested
    // event. Per packages/shared/src/notifications.ts this is a silent
    // event by default — the dispatcher will find an empty recipient
    // list and no-op — but we still go through the same machinery so
    // a future per-tenant override can opt in.
    void this.thread.dispatchAfterCommit(args.tenantId, {
      engagementId,
      eventType: 'requirements_ingested',
      actorType: 'user',
      actorId: args.salesEmployeeId,
      payload: { source, kind, artifactIds: args.artifactIds },
    });

    return { engagementId, artifactIds: args.artifactIds };
  }

  /**
   * Convenience: land + promote in one call. The in-app UI uses this
   * because the rep is already saying "create an opportunity from
   * this paste/file." Webhooks use receive() alone and let a rep
   * promote later via the dashboard.
   */
  async receiveAndPromote(
    args: ReceiveArgs & Omit<PromoteArgs, 'artifactIds' | 'tenantId'>,
  ): Promise<{ engagementId: string; artifactIds: string[] }> {
    const { artifactId } = await this.receive({
      tenantId: args.tenantId,
      source: args.source,
      content: args.content,
      ...(args.receivedBy !== undefined ? { receivedBy: args.receivedBy } : {}),
      ...(args.externalId !== undefined ? { externalId: args.externalId } : {}),
    });
    return this.promote({
      tenantId: args.tenantId,
      artifactIds: [artifactId],
      salesEmployeeId: args.salesEmployeeId,
      ...(args.overrides ? { overrides: args.overrides } : {}),
      ...(args.name ? { name: args.name } : {}),
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers

  /**
   * Pick the right Prisma create payload for the artifact's content.
   * Centralised so receive() doesn't fork on `kind` inline.
   */
  private materialiseContentFields(content: ArtifactContent): Record<string, unknown> {
    switch (content.kind) {
      case 'text':
        return { rawText: content.data.rawText };
      case 'email': {
        const d = content.data;
        return {
          rawText: d.bodyText,
          emailSubject: d.subject ?? null,
          emailFrom: d.from ?? null,
          emailTo: d.to ?? [],
          emailDate: d.date ?? null,
          emailHeaders: d.headers ?? null,
        };
      }
      case 'file':
      case 'audio': {
        const d = content.data;
        if (d.kind === 'preuploaded') {
          return {
            s3Key: d.s3Key,
            contentType: d.contentType,
            sizeBytes: d.sizeBytes,
            originalName: d.filename,
          };
        }
        // Inline: row is created without s3Key; receive() writes the
        // bytes + patches s3Key in a follow-up update.
        return {
          contentType: d.contentType,
          originalName: d.filename,
        };
      }
    }
  }

  /**
   * Turn one IngestionArtifact into an EngagementFile so the existing
   * extraction pipeline can run over it. Returns the new file id, or
   * null when the artifact has no content (shouldn't happen given the
   * CHECK constraints, but defensive).
   *
   * Text artifacts: materialise rawText to S3 as text/plain, so the
   * existing pipeline treats it like any other uploaded text file.
   *
   * Email artifacts: materialise the body as text/plain too — the
   * subject + headers stay on the IngestionArtifact row for audit
   * but the extraction pipeline only operates on the body text.
   */
  private async materialiseArtifactToFile(
    db: PrismaTx,
    args: {
      tenantId: string;
      engagementId: string;
      artifact: {
        id: string;
        tenantId: string;
        kind: string;
        rawText: string | null;
        s3Key: string | null;
        contentType: string | null;
        sizeBytes: number | null;
        originalName: string | null;
        emailSubject: string | null;
      };
    },
  ): Promise<string | null> {
    const art = args.artifact;

    // Decide on bytes + content-type + filename for the file row.
    let s3Key: string;
    let contentType: string;
    let filename: string;
    let sizeBytes: number;

    if (art.kind === 'text' || art.kind === 'email') {
      if (!art.rawText) return null;
      const body = art.rawText;
      filename =
        art.kind === 'email' && art.emailSubject
          ? `email — ${art.emailSubject}.txt`.slice(0, 200)
          : 'notes.txt';
      contentType = 'text/plain';
      sizeBytes = Buffer.byteLength(body, 'utf8');
      // We need a file id BEFORE we know the final S3 key (the key
      // includes the file id). Use the artifact id as a unique
      // prefix — uploads under ingestion/<tenant>/<artifactId>/...
      // are already canonical for the artifact, and the materialised
      // file just references that same object. This avoids a second
      // S3 write for text artifacts.
      s3Key = S3Service.keyForIngestionArtifact({
        tenantId: art.tenantId,
        artifactId: art.id,
        filename,
      });
      await this.s3.putBytes({ key: s3Key, contentType, body });
    } else {
      // file / audio: s3Key must already be set (CHECK constraint).
      if (!art.s3Key) return null;
      s3Key = art.s3Key;
      contentType = art.contentType ?? 'application/octet-stream';
      filename = art.originalName ?? `artifact-${art.id}.bin`;
      sizeBytes = art.sizeBytes ?? 0;
    }

    const file = await db.engagementFile.create({
      data: {
        tenantId: args.tenantId,
        engagementId: args.engagementId,
        // 'scoping_doc' mirrors the legacy Quick-fill upload path —
        // file is engagement-level, not bound to a template node.
        kind: 'scoping_doc',
        s3Key,
        filename,
        sizeBytes: BigInt(sizeBytes),
        contentType,
        originArtifactId: art.id,
      },
      select: { id: true },
    });

    return file.id;
  }
}
