/**
 * Odoo integration service — connection management, sync orchestration,
 * field mapping. Sits between the controller (HTTP-facing) and the
 * OdooClient (XML-RPC-facing).
 *
 * Layering matches the Outlook integration:
 *   - OdooClient: pure XML-RPC, no DB.
 *   - This service: per-tenant client resolution, credential storage
 *     (envelope-encrypted), mapping engine, sync logging.
 *
 * All DB access goes through TenantDb.run() — RLS enforced per tenant.
 */

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { TenantDb, type PrismaTx } from '../../db/with-tenant.js';
import { encryptApiKey, decryptApiKey } from '../../llm/llm.crypto.js';
import {
  OdooClient,
  OdooApiError,
  type OdooDomain,
  type OdooRecord,
} from './odoo.client.js';
import {
  compileMappings,
  buildOdooPayload,
} from './odoo.mapping.js';
import type {
  OdooConnectionStatus,
  OdooConnectionTestResult,
  UpsertOdooConnectionInput,
  UpsertOdooFieldMapping,
  OdooFieldMapping,
  OdooSyncLogRow,
  OdooEntityLinkRow,
  OdooWebhookEventRow,
  OdooPushRequest,
  OdooPushResult,
  OdooStageOption,
  OdooTeamOption,
  OdooUserOption,
  OdooTagOption,
} from '@rhud/shared';

@Injectable()
export class OdooService {
  private readonly logger = new Logger(OdooService.name);

  constructor(private readonly tenantDb: TenantDb) {}

  // ── Connection management ─────────────────────────────────────────

  /** Build the webhook URL the customer pastes into their Odoo
   *  Automation Rule. The shared secret in the path lets us
   *  authenticate inbound calls without per-message signing. */
  webhookUrl(tenantId: string, secret: string): string {
    const base = (process.env.API_PUBLIC_URL ?? 'http://localhost:8000').replace(/\/$/, '');
    return `${base}/api/v1/integrations/odoo/webhooks/${tenantId}/${encodeURIComponent(secret)}`;
  }

  /** Public-safe status object for the /integrations page. */
  async getStatus(tenantId: string): Promise<OdooConnectionStatus> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({
        where: { tenantId },
        select: {
          url: true,
          database: true,
          login: true,
          uid: true,
          autoSyncEnabled: true,
          defaultTeamId: true,
          defaultUserId: true,
          webhookSecret: true,
          serverVersion: true,
          lastConnectedAt: true,
          lastErrorMessage: true,
        },
      }),
    );
    if (!row) {
      return {
        configured: false,
        connected: false,
        host: null,
        database: null,
        login: null,
        serverVersion: null,
        lastConnectedAt: null,
        lastErrorMessage: null,
        autoSyncEnabled: false,
        defaultTeamId: null,
        defaultUserId: null,
        webhookUrl: null,
      };
    }

    return {
      configured: true,
      connected: !!(row.uid && row.lastConnectedAt && !row.lastErrorMessage),
      host: hostFromUrl(row.url),
      database: row.database,
      login: row.login,
      serverVersion: row.serverVersion,
      lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
      lastErrorMessage: row.lastErrorMessage,
      autoSyncEnabled: row.autoSyncEnabled,
      defaultTeamId: row.defaultTeamId,
      defaultUserId: row.defaultUserId,
      webhookUrl: this.webhookUrl(tenantId, row.webhookSecret),
    };
  }

  /**
   * Insert or update the Odoo connection.
   *
   * On every save we issue a test authenticate; if it fails we still
   * persist the credentials but mark `lastErrorMessage` so the admin
   * sees the failure inline. (Prevents the "save then test" two-step.)
   *
   * If `apiKey` is empty/undefined and a row already exists, the
   * existing key is preserved — same UX as the LLM admin form.
   */
  async upsert(tenantId: string, input: UpsertOdooConnectionInput): Promise<OdooConnectionStatus> {
    const url = sanitiseUrl(input.url);
    const database = input.database.trim();
    const login = input.login.trim();
    if (!url) throw new BadRequestException('odoo_url_required');
    if (!database) throw new BadRequestException('odoo_database_required');
    if (!login) throw new BadRequestException('odoo_login_required');

    const existing = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({ where: { tenantId } }),
    );

    let apiKeyEnc;
    if (input.apiKey && input.apiKey.trim().length > 0) {
      apiKeyEnc = encryptApiKey(input.apiKey.trim());
    } else if (!existing) {
      throw new BadRequestException('odoo_api_key_required');
    } else {
      apiKeyEnc = null; // keep existing
    }

    const webhookSecret = existing?.webhookSecret ?? randomBytes(32).toString('hex');

    await this.tenantDb.run(tenantId, async (db) => {
      const baseData = {
        url,
        database,
        login,
        webhookSecret,
        autoSyncEnabled: input.autoSyncEnabled ?? existing?.autoSyncEnabled ?? true,
        defaultTeamId: input.defaultTeamId ?? existing?.defaultTeamId ?? null,
        defaultUserId: input.defaultUserId ?? existing?.defaultUserId ?? null,
        updatedAt: new Date(),
      };

      if (apiKeyEnc) {
        if (existing) {
          await db.odooConnection.update({
            where: { tenantId },
            data: {
              ...baseData,
              apiKeyCiphertext: apiKeyEnc.apiKeyCiphertext,
              apiKeyIv: apiKeyEnc.apiKeyIv,
              apiKeyDekCiphertext: apiKeyEnc.apiKeyDekCiphertext,
              apiKeyDekIv: apiKeyEnc.apiKeyDekIv,
              uid: null, // force reauthenticate next call
              lastErrorMessage: null,
            },
          });
        } else {
          await db.odooConnection.create({
            data: {
              tenantId,
              ...baseData,
              apiKeyCiphertext: apiKeyEnc.apiKeyCiphertext,
              apiKeyIv: apiKeyEnc.apiKeyIv,
              apiKeyDekCiphertext: apiKeyEnc.apiKeyDekCiphertext,
              apiKeyDekIv: apiKeyEnc.apiKeyDekIv,
              lastErrorMessage: null,
            },
          });
        }
      } else if (existing) {
        await db.odooConnection.update({
          where: { tenantId },
          data: baseData,
        });
      }
    });

    // Best-effort connection check; failures are recorded but don't
    // raise — the admin will see the lastErrorMessage in the status.
    try {
      await this.testConnection(tenantId);
    } catch {
      /* recorded inside testConnection */
    }
    return this.getStatus(tenantId);
  }

  /** Wipe credentials + cascade-delete entity links + sync logs. */
  async disconnect(tenantId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.odooConnection.delete({ where: { tenantId } }).catch(() => undefined);
    });
  }

  /** Test the saved credentials by calling `version` then `authenticate`. */
  async testConnection(tenantId: string): Promise<OdooConnectionTestResult> {
    const start = Date.now();
    let client: OdooClient;
    try {
      client = await this.clientFor(tenantId);
    } catch (e) {
      return { ok: false, uid: null, serverVersion: null, message: (e as Error).message };
    }

    try {
      const v = await client.version();
      const uid = await client.authenticate();
      await this.tenantDb.run(tenantId, async (db) => {
        await db.odooConnection.update({
          where: { tenantId },
          data: {
            uid,
            serverVersion: v.serverVersion,
            lastConnectedAt: new Date(),
            lastErrorMessage: null,
            updatedAt: new Date(),
          },
        });
        await this.writeLog(db, tenantId, {
          direction: 'push',
          operation: 'test',
          status: 'ok',
          triggeredBy: 'manual',
          durationMs: Date.now() - start,
        });
      });
      return { ok: true, uid, serverVersion: v.serverVersion, message: 'connected' };
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) => {
        await db.odooConnection
          .update({
            where: { tenantId },
            data: { lastErrorMessage: msg, updatedAt: new Date() },
          })
          .catch(() => undefined);
        await this.writeLog(db, tenantId, {
          direction: 'push',
          operation: 'test',
          status: 'error',
          triggeredBy: 'manual',
          errorMessage: msg,
          durationMs: Date.now() - start,
        });
      });
      return { ok: false, uid: null, serverVersion: null, message: msg };
    }
  }

  /**
   * Decrypt creds and build an OdooClient. Throws 503 with a stable
   * code when the connection isn't configured — matches the Outlook
   * pattern.
   */
  private async clientFor(tenantId: string): Promise<OdooClient> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({ where: { tenantId } }),
    );
    if (!row) throw new ServiceUnavailableException('odoo_not_configured');

    let apiKey: string;
    try {
      apiKey = decryptApiKey({
        apiKeyCiphertext: row.apiKeyCiphertext,
        apiKeyIv: row.apiKeyIv,
        apiKeyDekCiphertext: row.apiKeyDekCiphertext,
        apiKeyDekIv: row.apiKeyDekIv,
      });
    } catch (e) {
      this.logger.error(`odoo decrypt failed tenant=${tenantId}: ${(e as Error).message}`);
      throw new ServiceUnavailableException('odoo_secret_decryption_failed');
    }

    return new OdooClient({
      url: row.url,
      database: row.database,
      login: row.login,
      apiKey,
      cachedUid: row.uid,
    });
  }

  // ── Field mappings (per-tenant CRUD) ──────────────────────────────

  async listMappings(tenantId: string): Promise<OdooFieldMapping[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.odooFieldMapping.findMany({
        where: { tenantId },
        orderBy: [{ rhudEntity: 'asc' }, { rhudField: 'asc' }],
      });
      return rows.map(toMappingDto);
    });
  }

  async createMapping(tenantId: string, input: UpsertOdooFieldMapping): Promise<OdooFieldMapping> {
    if (!input.rhudEntity || !input.rhudField || !input.odooModel || !input.odooField) {
      throw new BadRequestException('mapping_fields_required');
    }
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.odooFieldMapping.create({
        data: {
          tenantId,
          rhudEntity: input.rhudEntity,
          rhudField: input.rhudField,
          odooModel: input.odooModel,
          odooField: input.odooField,
          transform: input.transform ?? null,
          required: input.required ?? false,
          direction: input.direction ?? 'push',
        },
      });
      return toMappingDto(row);
    });
  }

  async updateMapping(tenantId: string, id: string, input: UpsertOdooFieldMapping): Promise<OdooFieldMapping> {
    return this.tenantDb.run(tenantId, async (db) => {
      const row = await db.odooFieldMapping.update({
        where: { id },
        data: {
          rhudEntity: input.rhudEntity,
          rhudField: input.rhudField,
          odooModel: input.odooModel,
          odooField: input.odooField,
          transform: input.transform ?? null,
          required: input.required ?? false,
          direction: input.direction ?? 'push',
          updatedAt: new Date(),
        },
      });
      return toMappingDto(row);
    });
  }

  async deleteMapping(tenantId: string, id: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.odooFieldMapping.delete({ where: { id } }).catch(() => undefined);
    });
  }

  // ── Generic Odoo CRUD passthrough (admin/full-control panel) ───────

  /** Read records from any model. Surfaced via `/odoo/records/:model`. */
  async searchRecords(
    tenantId: string,
    model: string,
    opts: { domain?: OdooDomain; fields?: string[]; limit?: number; offset?: number; order?: string } = {},
  ): Promise<OdooRecord[]> {
    const start = Date.now();
    const client = await this.clientFor(tenantId);
    try {
      const out = await client.searchRead<OdooRecord>(model, opts.domain ?? [], {
        ...(opts.fields ? { fields: opts.fields } : {}),
        limit: opts.limit ?? 50,
        offset: opts.offset ?? 0,
        ...(opts.order ? { order: opts.order } : {}),
      });
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          direction: 'pull',
          operation: 'read',
          status: 'ok',
          triggeredBy: 'manual',
          durationMs: Date.now() - start,
        }),
      );
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          direction: 'pull',
          operation: 'read',
          status: 'error',
          triggeredBy: 'manual',
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }
  }

  /** Get the field schema of a model — for the mapping-builder UI. */
  async fieldsGet(tenantId: string, model: string): Promise<Record<string, unknown>> {
    const client = await this.clientFor(tenantId);
    return client.fieldsGet(model);
  }

  /** Direct create — admin power user. */
  async createRecord(tenantId: string, model: string, values: Record<string, unknown>, actorUserId: string | null = null): Promise<{ id: number }> {
    const start = Date.now();
    const client = await this.clientFor(tenantId);
    try {
      const idOrIds = await client.create(model, values);
      const id = extractId(idOrIds);
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          odooId: id,
          direction: 'push',
          operation: 'create',
          status: 'ok',
          triggeredBy: 'manual',
          actorUserId,
          requestPayload: values as object,
          responsePayload: { id },
          durationMs: Date.now() - start,
        }),
      );
      return { id };
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          direction: 'push',
          operation: 'create',
          status: 'error',
          triggeredBy: 'manual',
          actorUserId,
          requestPayload: values as object,
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }
  }

  /** Direct write — admin power user. */
  async updateRecord(
    tenantId: string,
    model: string,
    id: number,
    values: Record<string, unknown>,
    actorUserId: string | null = null,
  ): Promise<{ ok: true }> {
    const start = Date.now();
    const client = await this.clientFor(tenantId);
    try {
      await client.write(model, id, values);
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          odooId: id,
          direction: 'push',
          operation: 'update',
          status: 'ok',
          triggeredBy: 'manual',
          actorUserId,
          requestPayload: values as object,
          durationMs: Date.now() - start,
        }),
      );
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          odooId: id,
          direction: 'push',
          operation: 'update',
          status: 'error',
          triggeredBy: 'manual',
          actorUserId,
          requestPayload: values as object,
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }
  }

  /** Direct delete — admin power user. Use with care. */
  async deleteRecord(tenantId: string, model: string, id: number, actorUserId: string | null = null): Promise<{ ok: true }> {
    const start = Date.now();
    const client = await this.clientFor(tenantId);
    try {
      await client.unlink(model, id);
      await this.tenantDb.run(tenantId, async (db) => {
        // Also drop any entity_links pointing at it.
        await db.odooEntityLink.deleteMany({
          where: { tenantId, odooModel: model, odooId: id },
        });
        await this.writeLog(db, tenantId, {
          odooModel: model,
          odooId: id,
          direction: 'push',
          operation: 'unlink',
          status: 'ok',
          triggeredBy: 'manual',
          actorUserId,
          durationMs: Date.now() - start,
        });
      });
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: model,
          odooId: id,
          direction: 'push',
          operation: 'unlink',
          status: 'error',
          triggeredBy: 'manual',
          actorUserId,
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }
  }

  // ── Engagement → Odoo (the high-level domain sync) ─────────────────

  /**
   * Push a single engagement to Odoo. Creates or updates a `crm.lead`
   * (with type='opportunity') plus the associated `res.partner`
   * contact. Idempotent on re-call thanks to OdooEntityLink rows.
   *
   * Args:
   *   triggeredBy = 'auto' when called from the lifecycle hook,
   *                 'manual' when called from the UI button.
   */
  async pushEngagement(
    tenantId: string,
    engagementId: string,
    opts: OdooPushRequest = {},
    triggeredBy: 'auto' | 'manual' = 'manual',
    actorUserId: string | null = null,
  ): Promise<OdooPushResult> {
    const conn = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({ where: { tenantId } }),
    );
    if (!conn) throw new ServiceUnavailableException('odoo_not_configured');

    // Pull the engagement + quote + tenant default mappings in one read.
    const ctx = await this.tenantDb.run(tenantId, async (db) => {
      const eng = await db.engagement.findUnique({
        where: { id: engagementId },
        include: { template: { select: { name: true, serviceLine: true } }, quote: true },
      });
      if (!eng) return null;
      const links = await db.odooEntityLink.findMany({
        where: { tenantId, rhudEntity: 'engagement', rhudId: engagementId },
      });
      const customMappings = await db.odooFieldMapping.findMany({ where: { tenantId } });
      return { eng, links, customMappings: customMappings.map(toMappingDto) };
    });
    if (!ctx) throw new NotFoundException('engagement_not_found');

    const mappings = compileMappings(ctx.customMappings);
    const targetModel = opts.asModel ?? 'crm.lead';

    // Build the source object the mapping engine walks. We flatten a
    // few computed fields so mappings can use simple paths.
    const source = {
      ...ctx.eng,
      // approvedPriceCents may live on the quote; expose both via flat names.
      approvedPriceCents: ctx.eng.approvedPriceCents ?? ctx.eng.quote?.approvedPriceCents ?? null,
      predictedPriceCents: ctx.eng.predictedPriceCents ?? ctx.eng.quote?.predictedPriceCents ?? null,
      // Quote for nested-path mappings ("quote.baseTotalCents").
      quote: ctx.eng.quote
        ? {
            ...ctx.eng.quote,
            baseTotalCents: Number(ctx.eng.quote.baseTotalCents),
            approvedPriceCents: ctx.eng.quote.approvedPriceCents ? Number(ctx.eng.quote.approvedPriceCents) : null,
          }
        : null,
      // template snapshot
      templateName: ctx.eng.template?.name ?? null,
      serviceLine: ctx.eng.template?.serviceLine ?? null,
    };

    // 1) Make sure the partner exists. Try to find by email first.
    const client = await this.clientFor(tenantId);
    const start = Date.now();

    const existingLink = ctx.links.find((l) => l.odooModel === targetModel);

    let partnerId: number | null = null;
    if (ctx.eng.clientEmail) {
      const partnerLinkRow = ctx.links.find((l) => l.odooModel === 'res.partner');
      if (partnerLinkRow) {
        partnerId = partnerLinkRow.odooId;
      } else {
        const matches = await client.searchRead<{ id: number }>(
          'res.partner',
          [['email', '=', ctx.eng.clientEmail]],
          { fields: ['id'], limit: 1 },
        );
        if (matches.length > 0 && matches[0]) {
          partnerId = matches[0].id;
        } else {
          const partnerPayload = buildOdooPayload(mappings, 'engagement', source, 'res.partner');
          if (Object.keys(partnerPayload.fields).length > 0) {
            const created = await client.create('res.partner', partnerPayload.fields);
            partnerId = extractId(created);
          }
        }
        if (partnerId != null) {
          // Capture into a const so the closure below doesn't widen the
          // type back to `number | null` across the await boundary.
          const pid: number = partnerId;
          await this.tenantDb.run(tenantId, async (db) =>
            db.odooEntityLink.upsert({
              where: {
                tenantId_rhudEntity_rhudId_odooModel: {
                  tenantId,
                  rhudEntity: 'engagement',
                  rhudId: engagementId,
                  odooModel: 'res.partner',
                },
              },
              create: {
                tenantId,
                rhudEntity: 'engagement',
                rhudId: engagementId,
                odooModel: 'res.partner',
                odooId: pid,
                lastSyncedAt: new Date(),
              },
              update: { odooId: pid, lastSyncedAt: new Date() },
            }),
          );
        }
      }
    }

    // 2) Upsert the lead/opportunity itself.
    const leadPayload = buildOdooPayload(mappings, 'engagement', source, targetModel);
    if (leadPayload.missingRequired.length > 0) {
      throw new BadRequestException(`missing_required_fields:${leadPayload.missingRequired.join(',')}`);
    }
    // Default: every engagement maps to a `crm.lead` of type='opportunity'.
    if (targetModel === 'crm.lead' && leadPayload.fields.type === undefined) {
      leadPayload.fields.type = 'opportunity';
    }
    if (partnerId != null) leadPayload.fields.partner_id = partnerId;
    if (conn.defaultTeamId != null && leadPayload.fields.team_id === undefined) {
      leadPayload.fields.team_id = conn.defaultTeamId;
    }
    if (conn.defaultUserId != null && leadPayload.fields.user_id === undefined) {
      leadPayload.fields.user_id = conn.defaultUserId;
    }
    if (opts.overrides) Object.assign(leadPayload.fields, opts.overrides);

    let odooId: number;
    let operation: 'create' | 'update';
    try {
      if (existingLink && !opts.force) {
        await client.write(targetModel, existingLink.odooId, leadPayload.fields);
        odooId = existingLink.odooId;
        operation = 'update';
      } else {
        const created = await client.create(targetModel, leadPayload.fields);
        odooId = extractId(created);
        operation = 'create';
      }
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          rhudEntity: 'engagement',
          rhudId: engagementId,
          odooModel: targetModel,
          direction: 'push',
          operation: existingLink ? 'update' : 'create',
          status: 'error',
          triggeredBy,
          actorUserId,
          requestPayload: leadPayload.fields as object,
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }

    await this.tenantDb.run(tenantId, async (db) => {
      await db.odooEntityLink.upsert({
        where: {
          tenantId_rhudEntity_rhudId_odooModel: {
            tenantId,
            rhudEntity: 'engagement',
            rhudId: engagementId,
            odooModel: targetModel,
          },
        },
        create: {
          tenantId,
          rhudEntity: 'engagement',
          rhudId: engagementId,
          odooModel: targetModel,
          odooId,
          lastSyncedAt: new Date(),
        },
        update: { odooId, lastSyncedAt: new Date() },
      });
      // Mirror odoo_quotation_id on the engagement for legacy callers
      // (the schema placeholder existed pre-integration). Stringify
      // because the column is text.
      if (targetModel === 'crm.lead' || targetModel === 'sale.order') {
        await db.engagement.update({
          where: { id: engagementId },
          data: { odooQuotationId: String(odooId) },
        });
      }
      await this.writeLog(db, tenantId, {
        rhudEntity: 'engagement',
        rhudId: engagementId,
        odooModel: targetModel,
        odooId,
        direction: 'push',
        operation,
        status: 'ok',
        triggeredBy,
        actorUserId,
        requestPayload: leadPayload.fields as object,
        responsePayload: { id: odooId },
        durationMs: Date.now() - start,
      });
    });

    return { ok: true, odooModel: targetModel, odooId, operation };
  }

  /** Pull the latest version of the linked Odoo record back into Rhud
   *  (for the "refresh from Odoo" button). Currently writes nothing
   *  back into the engagement — surfaces the canonical Odoo state for
   *  display. Future: 2-way mappings overwrite on configured fields. */
  async pullEngagement(tenantId: string, engagementId: string): Promise<{ records: OdooRecord[] }> {
    const links = await this.tenantDb.run(tenantId, async (db) =>
      db.odooEntityLink.findMany({
        where: { tenantId, rhudEntity: 'engagement', rhudId: engagementId },
      }),
    );
    if (links.length === 0) return { records: [] };

    const client = await this.clientFor(tenantId);
    const out: OdooRecord[] = [];
    for (const link of links) {
      try {
        const recs = await client.read(link.odooModel, [link.odooId]);
        out.push(...(recs as OdooRecord[]));
      } catch {
        // Soft-skip a stale link rather than failing the whole call.
      }
    }
    return { records: out };
  }

  /** Drop the link between an engagement and Odoo (without deleting in
   *  Odoo). Useful when an admin wants to "reset and resync". */
  async unlinkEngagement(tenantId: string, engagementId: string): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.odooEntityLink.deleteMany({
        where: { tenantId, rhudEntity: 'engagement', rhudId: engagementId },
      });
      await db.engagement.update({
        where: { id: engagementId },
        data: { odooQuotationId: null },
      }).catch(() => undefined);
    });
  }

  /** Mark a linked Odoo opportunity as won or lost via the
   *  `action_set_won` / `action_set_lost` server actions. */
  async setOutcome(
    tenantId: string,
    engagementId: string,
    outcome: 'won' | 'lost',
    actorUserId: string | null = null,
  ): Promise<{ ok: true }> {
    const link = await this.tenantDb.run(tenantId, async (db) =>
      db.odooEntityLink.findFirst({
        where: { tenantId, rhudEntity: 'engagement', rhudId: engagementId, odooModel: 'crm.lead' },
      }),
    );
    if (!link) throw new NotFoundException('odoo_lead_not_linked');

    const client = await this.clientFor(tenantId);
    const start = Date.now();
    try {
      if (outcome === 'won') {
        await client.callAction('crm.lead', 'action_set_won', link.odooId);
      } else {
        await client.callAction('crm.lead', 'action_set_lost', link.odooId);
      }
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          rhudEntity: 'engagement',
          rhudId: engagementId,
          odooModel: 'crm.lead',
          odooId: link.odooId,
          direction: 'push',
          operation: 'update',
          status: 'ok',
          triggeredBy: 'manual',
          actorUserId,
          requestPayload: { action: `action_set_${outcome}` },
          durationMs: Date.now() - start,
        }),
      );
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          rhudEntity: 'engagement',
          rhudId: engagementId,
          odooModel: 'crm.lead',
          odooId: link.odooId,
          direction: 'push',
          operation: 'update',
          status: 'error',
          triggeredBy: 'manual',
          actorUserId,
          errorMessage: msg,
          durationMs: Date.now() - start,
        }),
      );
      throw e instanceof OdooApiError ? new BadRequestException(`odoo_${e.code}: ${msg}`) : e;
    }
  }

  // ── CRM dropdown helpers ──────────────────────────────────────────

  async listStages(tenantId: string): Promise<OdooStageOption[]> {
    const recs = await this.searchRecords(tenantId, 'crm.stage', {
      fields: ['id', 'name', 'sequence', 'is_won'],
      limit: 200,
      order: 'sequence asc',
    });
    return recs.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      sequence: Number(r.sequence ?? 0),
      isWon: Boolean(r.is_won),
    }));
  }

  async listTeams(tenantId: string): Promise<OdooTeamOption[]> {
    const recs = await this.searchRecords(tenantId, 'crm.team', {
      fields: ['id', 'name'],
      limit: 200,
      order: 'name asc',
    });
    return recs.map((r) => ({ id: Number(r.id), name: String(r.name ?? '') }));
  }

  async listUsers(tenantId: string): Promise<OdooUserOption[]> {
    const recs = await this.searchRecords(tenantId, 'res.users', {
      domain: [['active', '=', true]],
      fields: ['id', 'name', 'login'],
      limit: 200,
      order: 'name asc',
    });
    return recs.map((r) => ({ id: Number(r.id), name: String(r.name ?? ''), login: String(r.login ?? '') }));
  }

  async listTags(tenantId: string): Promise<OdooTagOption[]> {
    const recs = await this.searchRecords(tenantId, 'crm.tag', {
      fields: ['id', 'name', 'color'],
      limit: 200,
      order: 'name asc',
    });
    return recs.map((r) => ({
      id: Number(r.id),
      name: String(r.name ?? ''),
      ...(r.color != null ? { color: Number(r.color) } : {}),
    }));
  }

  // ── Sync log + entity link reads ──────────────────────────────────

  async listSyncLogs(tenantId: string, limit = 100): Promise<OdooSyncLogRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.odooSyncLog.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 500),
      });
      return rows.map((r) => ({
        id: r.id,
        rhudEntity: r.rhudEntity,
        rhudId: r.rhudId,
        odooModel: r.odooModel,
        odooId: r.odooId,
        direction: r.direction as 'push' | 'pull',
        operation: r.operation as OdooSyncLogRow['operation'],
        status: r.status as 'ok' | 'error' | 'skipped',
        triggeredBy: r.triggeredBy as OdooSyncLogRow['triggeredBy'],
        actorUserId: r.actorUserId,
        errorMessage: r.errorMessage,
        durationMs: r.durationMs,
        createdAt: r.createdAt.toISOString(),
      }));
    });
  }

  async listEntityLinks(tenantId: string, limit = 200): Promise<OdooEntityLinkRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.odooEntityLink.findMany({
        where: { tenantId },
        orderBy: { createdAt: 'desc' },
        take: Math.min(limit, 500),
      });
      return rows.map((r) => ({
        id: r.id,
        rhudEntity: r.rhudEntity,
        rhudId: r.rhudId,
        odooModel: r.odooModel,
        odooId: r.odooId,
        lastSyncedAt: r.lastSyncedAt?.toISOString() ?? null,
        odooWriteDate: r.odooWriteDate?.toISOString() ?? null,
      }));
    });
  }

  async listWebhookEvents(tenantId: string, limit = 100): Promise<OdooWebhookEventRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.odooWebhookEvent.findMany({
        where: { tenantId },
        orderBy: { receivedAt: 'desc' },
        take: Math.min(limit, 500),
      });
      return rows.map((r) => ({
        id: r.id,
        odooModel: r.odooModel,
        odooId: r.odooId,
        eventType: r.eventType,
        status: r.status as OdooWebhookEventRow['status'],
        errorMessage: r.errorMessage,
        receivedAt: r.receivedAt.toISOString(),
        processedAt: r.processedAt?.toISOString() ?? null,
      }));
    });
  }

  // ── Webhook ingestion ─────────────────────────────────────────────

  /**
   * Persist + dispatch an inbound Odoo webhook. The shared-secret check
   * happens in the controller (URL-bound). This method assumes auth.
   *
   * Body shape we accept (Odoo Studio is configurable but typical):
   *   { model: 'crm.lead', record_id: 123, event: 'write', values: {...} }
   * Anything else is logged as `ignored`.
   */
  async ingestWebhook(
    tenantId: string,
    body: unknown,
  ): Promise<{ id: string; status: string }> {
    const safe = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const odooModel = String(safe.model ?? safe.modelName ?? 'unknown');
    const odooId =
      typeof safe.record_id === 'number'
        ? safe.record_id
        : typeof safe.id === 'number'
        ? safe.id
        : null;
    const eventType = String(safe.event ?? safe.event_type ?? 'unknown');

    return this.tenantDb.run(tenantId, async (db) => {
      const stored = await db.odooWebhookEvent.create({
        data: {
          tenantId,
          odooModel,
          odooId,
          eventType,
          payload: safe as object,
          status: 'pending',
        },
      });
      await this.writeLog(db, tenantId, {
        odooModel,
        odooId,
        direction: 'pull',
        operation: 'webhook',
        status: 'ok',
        triggeredBy: 'webhook',
      });
      return { id: stored.id, status: stored.status };
    });
  }

  /**
   * Best-effort processor for pending webhooks. Today: marks them
   * processed without side effects. Future: refresh OdooEntityLink
   * write_dates and run pull-mode mappings into Rhud entities.
   */
  async processPendingWebhooks(tenantId: string): Promise<{ processed: number; failed: number }> {
    let processed = 0;
    let failed = 0;
    const pending = await this.tenantDb.run(tenantId, async (db) =>
      db.odooWebhookEvent.findMany({
        where: { tenantId, status: 'pending' },
        orderBy: { receivedAt: 'asc' },
        take: 50,
      }),
    );
    for (const ev of pending) {
      try {
        await this.tenantDb.run(tenantId, async (db) => {
          await db.odooWebhookEvent.update({
            where: { id: ev.id },
            data: { status: 'processed', processedAt: new Date() },
          });
        });
        processed += 1;
      } catch (e) {
        failed += 1;
        await this.tenantDb.run(tenantId, async (db) => {
          await db.odooWebhookEvent.update({
            where: { id: ev.id },
            data: { status: 'failed', errorMessage: (e as Error).message, processedAt: new Date() },
          });
        });
      }
    }
    return { processed, failed };
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /** Insert a sync log row inside an existing tx. Soft-fail (we never
   *  want logging to abort a real sync). */
  private async writeLog(
    db: PrismaTx,
    tenantId: string,
    args: {
      rhudEntity?: string | null;
      rhudId?: string | null;
      odooModel?: string | null;
      odooId?: number | null;
      direction: 'push' | 'pull';
      operation: 'create' | 'update' | 'unlink' | 'read' | 'webhook' | 'authenticate' | 'test';
      status: 'ok' | 'error' | 'skipped';
      triggeredBy: 'auto' | 'manual' | 'webhook' | 'system';
      actorUserId?: string | null;
      errorMessage?: string | null;
      requestPayload?: object | null;
      responsePayload?: object | null;
      durationMs?: number | null;
    },
  ): Promise<void> {
    try {
      await db.odooSyncLog.create({
        data: {
          tenantId,
          rhudEntity: args.rhudEntity ?? null,
          rhudId: args.rhudId ?? null,
          odooModel: args.odooModel ?? null,
          odooId: args.odooId ?? null,
          direction: args.direction,
          operation: args.operation,
          status: args.status,
          triggeredBy: args.triggeredBy,
          actorUserId: args.actorUserId ?? null,
          errorMessage: args.errorMessage ?? null,
          ...(args.requestPayload ? { requestPayload: args.requestPayload as object } : {}),
          ...(args.responsePayload ? { responsePayload: args.responsePayload as object } : {}),
          durationMs: args.durationMs ?? null,
        },
      });
    } catch (e) {
      this.logger.warn(`odoo log write failed: ${(e as Error).message}`);
    }
  }

  /** True if auto-sync is on for this tenant — call from lifecycle hooks. */
  async isAutoSyncEnabled(tenantId: string): Promise<boolean> {
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({
        where: { tenantId },
        select: { autoSyncEnabled: true },
      }),
    );
    return !!row?.autoSyncEnabled;
  }

  /**
   * Best-effort lifecycle hook. Called after engagement status transitions
   * (submitted, approved, rejected, won, lost). Silently no-ops when:
   *   - Odoo isn't configured for the tenant
   *   - Auto-sync is disabled
   *   - The push fails (logged, never thrown — we don't want to fail an
   *     approval just because Odoo is down)
   *
   * Safe to call as `void svc.maybeAutoSync(...)` from any caller.
   */
  async maybeAutoSync(
    tenantId: string,
    engagementId: string,
    eventType: 'submitted' | 'approved' | 'rejected' | 'won' | 'lost',
  ): Promise<void> {
    try {
      const enabled = await this.isAutoSyncEnabled(tenantId);
      if (!enabled) return;

      // Push first — creates/updates the lead.
      await this.pushEngagement(tenantId, engagementId, {}, 'auto', null);

      // Then mark won/lost via the action helpers if applicable.
      if (eventType === 'won' || eventType === 'lost') {
        await this.setOutcome(tenantId, engagementId, eventType, null).catch(() => undefined);
      }
    } catch (e) {
      this.logger.warn(
        `odoo auto-sync skipped tenant=${tenantId} engagement=${engagementId} event=${eventType}: ${(e as Error).message}`,
      );
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function extractId(idOrIds: number | number[]): number {
  if (Array.isArray(idOrIds)) {
    const first = idOrIds[0];
    if (typeof first !== 'number') {
      throw new Error('odoo create returned empty id array');
    }
    return first;
  }
  return idOrIds;
}

function sanitiseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

function hostFromUrl(raw: string): string | null {
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function toMappingDto(row: {
  id: string;
  rhudEntity: string;
  rhudField: string;
  odooModel: string;
  odooField: string;
  transform: string | null;
  required: boolean;
  direction: string;
  updatedAt: Date;
}): OdooFieldMapping {
  return {
    id: row.id,
    rhudEntity: row.rhudEntity,
    rhudField: row.rhudField,
    odooModel: row.odooModel,
    odooField: row.odooField,
    transform: row.transform,
    required: row.required,
    direction: row.direction as 'push' | 'pull' | 'both',
    updatedAt: row.updatedAt.toISOString(),
  };
}
