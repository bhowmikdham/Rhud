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
  buildEngagementPatch,
  flattenOdooRecord,
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
  OdooImportedOpportunityRow,
  PromoteImportedOpportunityInput,
  PromoteImportedOpportunityResult,
  OdooPollResult,
} from '@rhud/shared';

/** Echo suppression window. If Odoo's write_date is within this many
 *  ms of our last_pushed_at on the same record, we treat the inbound
 *  event as the echo of our own push and skip it. 30s is generous
 *  enough to cover network latency + Odoo's automation rule debounce.
 *
 *  NOTE this constant lives here for the Odoo integration only.
 *  Lead-summary cool-down is in summary.service.ts. */
const ECHO_SUPPRESSION_WINDOW_MS = 30_000;

/** Fields we always pull from crm.lead during a poll/refresh. */
const CRM_LEAD_DEFAULT_FIELDS = [
  'id',
  'name',
  'type',
  'email_from',
  'phone',
  'partner_id',
  'partner_name',
  'contact_name',
  'expected_revenue',
  'probability',
  'stage_id',
  'user_id',
  'team_id',
  'tag_ids',
  'priority',
  'description',
  'date_deadline',
  'date_open',
  'date_closed',
  'kanban_state',
  'active',
  'write_date',
  'create_date',
];

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
      const now = new Date();
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
          lastSyncedAt: now,
          lastPushedAt: now, // for echo-suppression on the next inbound tick
        },
        update: { odooId, lastSyncedAt: now, lastPushedAt: now },
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
   * Real webhook processor. For each pending event:
   *
   *   1. Skip + mark `ignored` if we don't know the model.
   *   2. Re-fetch the canonical record from Odoo (NEVER trust the
   *      webhook payload — Studio rules let the customer choose what
   *      fields to send and could be misconfigured or even malicious).
   *   3. Echo-suppression: if there's an OdooEntityLink with a
   *      `last_pushed_at` within `ECHO_SUPPRESSION_WINDOW_MS` of the
   *      record's write_date, this is almost certainly our own push
   *      coming back — mark `ignored`.
   *   4. Otherwise, run `reconcileFromOdoo` which upserts the snapshot
   *      cache + (if linked to an Engagement) applies pull-direction
   *      mappings + emits an `engagement_synced` thread event.
   *
   * Idempotent: re-running on the same event yields the same state.
   * Hands errors per-event so one bad webhook doesn't block the rest.
   */
  async processPendingWebhooks(tenantId: string): Promise<{ processed: number; failed: number; ignored: number }> {
    let processed = 0;
    let failed = 0;
    let ignored = 0;
    const pending = await this.tenantDb.run(tenantId, async (db) =>
      db.odooWebhookEvent.findMany({
        where: { tenantId, status: 'pending' },
        orderBy: { receivedAt: 'asc' },
        take: 50,
      }),
    );
    if (pending.length === 0) return { processed, failed, ignored };

    let client: OdooClient;
    try {
      client = await this.clientFor(tenantId);
    } catch (e) {
      // No connection → mark all pending events failed; they can be
      // retried after the admin reconnects.
      for (const ev of pending) {
        await this.tenantDb.run(tenantId, async (db) => {
          await db.odooWebhookEvent.update({
            where: { id: ev.id },
            data: { status: 'failed', errorMessage: (e as Error).message, processedAt: new Date() },
          });
        });
        failed += 1;
      }
      return { processed, failed, ignored };
    }

    for (const ev of pending) {
      try {
        const outcome = await this.processWebhookEvent(client, tenantId, ev);
        if (outcome === 'ignored') ignored += 1;
        else processed += 1;
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
    return { processed, failed, ignored };
  }

  /** Single-event processing path. Returns 'processed' on success or
   *  'ignored' when the event is a deliberate skip (echo, unknown
   *  model, etc.). */
  private async processWebhookEvent(
    client: OdooClient,
    tenantId: string,
    ev: { id: string; odooModel: string; odooId: number | null; eventType: string },
  ): Promise<'processed' | 'ignored'> {
    if (ev.odooModel !== 'crm.lead') {
      // We only handle crm.lead today. res.partner could come later
      // when contact-merging matters.
      await this.tenantDb.run(tenantId, async (db) =>
        db.odooWebhookEvent.update({
          where: { id: ev.id },
          data: {
            status: 'ignored',
            errorMessage: `unsupported_model:${ev.odooModel}`,
            processedAt: new Date(),
          },
        }),
      );
      return 'ignored';
    }
    if (ev.odooId == null) {
      await this.tenantDb.run(tenantId, async (db) =>
        db.odooWebhookEvent.update({
          where: { id: ev.id },
          data: { status: 'ignored', errorMessage: 'no_record_id', processedAt: new Date() },
        }),
      );
      return 'ignored';
    }

    if (ev.eventType === 'unlink') {
      // Record was deleted in Odoo. Drop our links + snapshots.
      await this.handleOdooUnlink(tenantId, ev.odooModel, ev.odooId);
      await this.tenantDb.run(tenantId, async (db) =>
        db.odooWebhookEvent.update({
          where: { id: ev.id },
          data: { status: 'processed', processedAt: new Date() },
        }),
      );
      return 'processed';
    }

    // Re-fetch canonical record. If Odoo returns no rows, the record
    // was likely deleted between event fire and now → treat like unlink.
    const records = await client.read('crm.lead', [ev.odooId], CRM_LEAD_DEFAULT_FIELDS);
    if (records.length === 0) {
      await this.handleOdooUnlink(tenantId, 'crm.lead', ev.odooId);
      await this.tenantDb.run(tenantId, async (db) =>
        db.odooWebhookEvent.update({
          where: { id: ev.id },
          data: { status: 'processed', errorMessage: 'record_not_found', processedAt: new Date() },
        }),
      );
      return 'processed';
    }
    const record = records[0] as OdooRecord;

    const result = await this.reconcileFromOdoo(tenantId, 'crm.lead', ev.odooId, record);

    await this.tenantDb.run(tenantId, async (db) =>
      db.odooWebhookEvent.update({
        where: { id: ev.id },
        data: {
          status: result.echoSuppressed ? 'ignored' : 'processed',
          errorMessage: result.echoSuppressed ? 'echo_suppressed' : null,
          processedAt: new Date(),
        },
      }),
    );
    return result.echoSuppressed ? 'ignored' : 'processed';
  }

  /**
   * Core "given a fresh Odoo record snapshot, update Rhud accordingly":
   *
   *   - If linked to an Engagement: refresh OdooEntityLink.cachedRecord +
   *     (when pull-mappings exist) apply them to the engagement, emit a
   *     thread event.
   *   - If not linked: upsert into OdooImportedOpportunity so the user
   *     sees it in the "External" list and can promote it.
   *
   * Echo-suppression check happens here so both webhook and polling
   * paths benefit. Returns `echoSuppressed=true` when the record's
   * write_date is too close to our last push to be a real change.
   */
  private async reconcileFromOdoo(
    tenantId: string,
    odooModel: string,
    odooId: number,
    record: OdooRecord,
  ): Promise<{ echoSuppressed: boolean; engagementId: string | null; isNewImport: boolean }> {
    const flat = flattenOdooRecord(record);
    const writeDate = parseOdooDate(record.write_date);

    return this.tenantDb.run(tenantId, async (db) => {
      const link = await db.odooEntityLink.findUnique({
        where: { tenantId_odooModel_odooId: { tenantId, odooModel, odooId } },
      });

      // Echo suppression: our own push echoing back.
      if (
        link?.lastPushedAt &&
        writeDate &&
        Math.abs(writeDate.getTime() - link.lastPushedAt.getTime()) < ECHO_SUPPRESSION_WINDOW_MS
      ) {
        await this.writeLog(db, tenantId, {
          rhudEntity: link.rhudEntity,
          rhudId: link.rhudId,
          odooModel,
          odooId,
          direction: 'pull',
          operation: 'webhook',
          status: 'skipped',
          triggeredBy: 'webhook',
          errorMessage: 'echo_suppressed',
        });
        return { echoSuppressed: true, engagementId: link.rhudId, isNewImport: false };
      }

      // Linked to an Engagement → refresh cache + apply pull mappings.
      if (link?.rhudEntity === 'engagement') {
        await db.odooEntityLink.update({
          where: { id: link.id },
          data: {
            cachedRecord: record as unknown as object,
            cachedAt: new Date(),
            odooWriteDate: writeDate,
            lastSyncedAt: new Date(),
          },
        });

        const customMappings = await db.odooFieldMapping.findMany({ where: { tenantId } });
        const compiled = compileMappings(customMappings.map(toMappingDto));
        const patch = buildEngagementPatch(compiled, flat, odooModel);
        if (Object.keys(patch).length > 0) {
          // Coerce known numeric fields to BigInt so Prisma accepts them.
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (k.endsWith('Cents') && typeof v === 'number') clean[k] = BigInt(Math.round(v * 100));
            else clean[k] = v;
          }
          await db.engagement.update({
            where: { id: link.rhudId },
            data: clean as unknown as Parameters<typeof db.engagement.update>[0]['data'],
          }).catch((err) => {
            // Don't fail the whole reconciliation on a single bad
            // mapping — log and move on.
            this.logger.warn(`engagement patch failed eng=${link.rhudId}: ${(err as Error).message}`);
          });
          await db.threadEvent.create({
            data: {
              tenantId,
              engagementId: link.rhudId,
              eventType: 'engagement_synced',
              actorType: 'integration',
              actorId: 'odoo',
              payload: { odooModel, odooId, fields: Object.keys(patch) },
            },
          });
        }
        await this.writeLog(db, tenantId, {
          rhudEntity: 'engagement',
          rhudId: link.rhudId,
          odooModel,
          odooId,
          direction: 'pull',
          operation: 'update',
          status: 'ok',
          triggeredBy: 'webhook',
        });
        return { echoSuppressed: false, engagementId: link.rhudId, isNewImport: false };
      }

      // Not linked → upsert into the imported-opportunity table.
      // Also keep a parallel OdooEntityLink with rhudEntity='odoo_imported'
      // so the cache + last_pushed_at machinery applies uniformly.
      const imported = await db.odooImportedOpportunity.upsert({
        where: { tenantId_odooModel_odooId: { tenantId, odooModel, odooId } },
        create: {
          tenantId,
          odooModel,
          odooId,
          snapshot: record as unknown as object,
          odooWriteDate: writeDate,
          importedAt: new Date(),
          lastRefreshedAt: new Date(),
        },
        update: {
          snapshot: record as unknown as object,
          odooWriteDate: writeDate,
          lastRefreshedAt: new Date(),
        },
      });

      // If the snapshot has been promoted to an Engagement, also patch
      // the Engagement (same logic as the linked branch above).
      if (imported.promotedEngagementId) {
        const customMappings = await db.odooFieldMapping.findMany({ where: { tenantId } });
        const compiled = compileMappings(customMappings.map(toMappingDto));
        const patch = buildEngagementPatch(compiled, flat, odooModel);
        if (Object.keys(patch).length > 0) {
          const clean: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(patch)) {
            if (k.endsWith('Cents') && typeof v === 'number') clean[k] = BigInt(Math.round(v * 100));
            else clean[k] = v;
          }
          await db.engagement.update({
            where: { id: imported.promotedEngagementId },
            data: clean as unknown as Parameters<typeof db.engagement.update>[0]['data'],
          }).catch((err) => {
            this.logger.warn(`engagement patch failed eng=${imported.promotedEngagementId}: ${(err as Error).message}`);
          });
        }
      }

      const isNewImport = imported.lastRefreshedAt.getTime() === imported.importedAt.getTime();
      await this.writeLog(db, tenantId, {
        odooModel,
        odooId,
        direction: 'pull',
        operation: isNewImport ? 'create' : 'update',
        status: 'ok',
        triggeredBy: 'webhook',
      });
      return { echoSuppressed: false, engagementId: imported.promotedEngagementId ?? null, isNewImport };
    });
  }

  /** Drop all Rhud-side state for an Odoo record that was deleted. */
  private async handleOdooUnlink(tenantId: string, odooModel: string, odooId: number): Promise<void> {
    await this.tenantDb.run(tenantId, async (db) => {
      await db.odooEntityLink.deleteMany({ where: { tenantId, odooModel, odooId } });
      await db.odooImportedOpportunity.deleteMany({ where: { tenantId, odooModel, odooId } });
      await this.writeLog(db, tenantId, {
        odooModel,
        odooId,
        direction: 'pull',
        operation: 'unlink',
        status: 'ok',
        triggeredBy: 'webhook',
      });
    });
  }

  // ── Polling fallback (for tenants without Studio) ─────────────────

  /**
   * Pull every crm.lead whose `create_date` is greater than the cached
   * cursor — i.e. opportunities that are NEW since we last looked.
   *
   * Why create_date and not write_date: filtering on write_date means
   * every edit to every old opportunity comes through the cycle. On a
   * tenant with thousands of leads that's a torrent of mostly
   * irrelevant traffic, and most edits are bookkeeping the user
   * doesn't need mirrored in Rhud anyway. Restricting to *new* opps
   * keeps polling cheap and signal-rich.
   *
   * Updates to opportunities Rhud already cares about (i.e. promoted
   * to a Rhud Engagement) still flow in two ways:
   *   - via Studio webhooks (instant, when the customer's on a plan
   *     that supports Automation Rules), and
   *   - via the per-row "Refresh from Odoo" button on the imported
   *     list and on the opportunity detail page (admin/manual).
   *
   * Safe to call repeatedly: bounded by `last_polled_at` + uses
   * `limit` per page. First call on a fresh tenant scans the
   * `pollIntervalSeconds` look-back rather than the entire history;
   * the explicit `backfillImportedOpportunities` admin action is for
   * deliberately importing the existing book.
   */
  async pollOdooChanges(
    tenantId: string,
    opts: { sinceOverride?: Date; limit?: number } = {},
  ): Promise<OdooPollResult> {
    let client: OdooClient;
    try {
      client = await this.clientFor(tenantId);
    } catch (e) {
      return { ok: false, changed: 0, imported: 0, promoted: 0, skippedEcho: 0, errors: 0, newCursor: null, message: (e as Error).message };
    }

    const conn = await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.findUnique({ where: { tenantId } }),
    );
    if (!conn) return { ok: false, changed: 0, imported: 0, promoted: 0, skippedEcho: 0, errors: 0, newCursor: null, message: 'odoo_not_configured' };

    // Cursor: explicit override > stored last_polled_at > now − interval.
    // Note: cursor semantics now track create_date (see method comment),
    // not write_date. The column is still named last_polled_at because
    // callers consume it as "the moment we last looked"; the meaning is
    // documented at the schema level.
    const since = opts.sinceOverride
      ?? conn.lastPolledAt
      ?? new Date(Date.now() - conn.pollIntervalSeconds * 1000);

    const limit = opts.limit ?? 100;

    let records: OdooRecord[];
    try {
      records = await client.searchRead<OdooRecord>(
        'crm.lead',
        [['create_date', '>', formatOdooDate(since)]],
        {
          fields: CRM_LEAD_DEFAULT_FIELDS,
          limit,
          order: 'create_date asc',
        },
      );
    } catch (e) {
      const msg = (e as Error).message;
      await this.tenantDb.run(tenantId, async (db) =>
        this.writeLog(db, tenantId, {
          odooModel: 'crm.lead',
          direction: 'pull',
          operation: 'read',
          status: 'error',
          triggeredBy: 'system',
          errorMessage: msg,
        }),
      );
      return { ok: false, changed: 0, imported: 0, promoted: 0, skippedEcho: 0, errors: 1, newCursor: null, message: msg };
    }

    let changed = 0;
    let imported = 0;
    let promoted = 0;
    let skippedEcho = 0;
    let errors = 0;
    // Cursor advances based on max(create_date) — same field we filter
    // on, so the next poll's `> cursor` is monotonic.
    let maxCreateDate: Date | null = null;

    for (const rec of records) {
      const recId = typeof rec.id === 'number' ? rec.id : null;
      if (recId == null) continue;
      const cd = parseOdooDate((rec as Record<string, unknown>).create_date);
      if (cd && (!maxCreateDate || cd > maxCreateDate)) maxCreateDate = cd;
      try {
        const out = await this.reconcileFromOdoo(tenantId, 'crm.lead', recId, rec);
        if (out.echoSuppressed) skippedEcho += 1;
        else if (out.engagementId) promoted += 1;
        else if (out.isNewImport) imported += 1;
        else changed += 1;
      } catch (e) {
        errors += 1;
        this.logger.warn(`poll reconcile failed odoo_id=${recId}: ${(e as Error).message}`);
      }
    }

    // Advance cursor only if we processed at least one record. If the
    // page filled to `limit`, the next poll will pick up the rest.
    const newCursor = maxCreateDate ?? null;
    if (newCursor) {
      await this.tenantDb.run(tenantId, async (db) =>
        db.odooConnection.update({
          where: { tenantId },
          data: { lastPolledAt: newCursor, updatedAt: new Date() },
        }),
      );
    }

    await this.tenantDb.run(tenantId, async (db) =>
      this.writeLog(db, tenantId, {
        odooModel: 'crm.lead',
        direction: 'pull',
        operation: 'read',
        status: errors > 0 ? 'error' : 'ok',
        triggeredBy: 'system',
        responsePayload: { changed, imported, promoted, skippedEcho, errors, count: records.length },
      }),
    );

    return {
      ok: true,
      changed,
      imported,
      promoted,
      skippedEcho,
      errors,
      newCursor: newCursor ? newCursor.toISOString() : null,
    };
  }

  // ── Imported opportunities (UI-facing reads + actions) ─────────────

  async listImportedOpportunities(
    tenantId: string,
    opts: { includePromoted?: boolean; limit?: number } = {},
  ): Promise<OdooImportedOpportunityRow[]> {
    return this.tenantDb.run(tenantId, async (db) => {
      const rows = await db.odooImportedOpportunity.findMany({
        where: {
          tenantId,
          ...(opts.includePromoted ? {} : { promotedAt: null }),
        },
        orderBy: { lastRefreshedAt: 'desc' },
        take: Math.min(opts.limit ?? 200, 500),
      });
      return rows.map((r) => importedToDto(r));
    });
  }

  /** Fetch the canonical Odoo record for a single imported snapshot
   *  and refresh its cache in place. UI uses this for the "Refresh"
   *  button on individual rows. */
  async refreshImportedOpportunity(tenantId: string, odooId: number): Promise<OdooImportedOpportunityRow> {
    const client = await this.clientFor(tenantId);
    const records = await client.read('crm.lead', [odooId], CRM_LEAD_DEFAULT_FIELDS);
    if (records.length === 0) {
      // Record was deleted — drop our shadow and surface a 404.
      await this.handleOdooUnlink(tenantId, 'crm.lead', odooId);
      throw new NotFoundException('odoo_record_not_found');
    }
    const record = records[0] as OdooRecord;
    await this.reconcileFromOdoo(tenantId, 'crm.lead', odooId, record);
    const row = await this.tenantDb.run(tenantId, async (db) =>
      db.odooImportedOpportunity.findUnique({
        where: { tenantId_odooModel_odooId: { tenantId, odooModel: 'crm.lead', odooId } },
      }),
    );
    if (!row) throw new NotFoundException('imported_not_found');
    return importedToDto(row);
  }

  /**
   * Promote an imported Odoo opportunity to a real Rhud Engagement.
   * Creates the Engagement with `imported_from_odoo=true`, ties it to
   * the snapshot via OdooEntityLink, and stamps the snapshot row so
   * subsequent polls update both sides.
   *
   * Idempotent: a second promote on an already-promoted snapshot
   * returns the existing Engagement id with `alreadyPromoted=true`.
   */
  async promoteImportedOpportunity(
    tenantId: string,
    odooId: number,
    input: PromoteImportedOpportunityInput,
    actorUserId: string,
  ): Promise<PromoteImportedOpportunityResult> {
    return this.tenantDb.run(tenantId, async (db) => {
      const imported = await db.odooImportedOpportunity.findUnique({
        where: { tenantId_odooModel_odooId: { tenantId, odooModel: 'crm.lead', odooId } },
      });
      if (!imported) throw new NotFoundException('imported_not_found');
      if (imported.promotedEngagementId) {
        return { engagementId: imported.promotedEngagementId, alreadyPromoted: true };
      }

      const tmpl = await db.template.findUnique({
        where: { id: input.templateId },
        select: { id: true, version: true, status: true, tenantId: true },
      });
      if (!tmpl || tmpl.tenantId !== tenantId) throw new NotFoundException('template_not_found');
      if (tmpl.status !== 'published') throw new BadRequestException('template_not_published');

      const salesEmployeeId = input.salesEmployeeId ?? actorUserId;

      const snap = imported.snapshot as Record<string, unknown>;
      const flat = flattenOdooRecord(snap);
      const clientEmail = typeof flat.email_from === 'string' ? flat.email_from : `imported-${odooId}@odoo.local`;
      const name = input.name ?? (typeof flat.name === 'string' ? flat.name : null);

      const eng = await db.engagement.create({
        data: {
          tenantId,
          templateId: tmpl.id,
          templateVersion: tmpl.version,
          salesEmployeeId,
          clientEmail,
          name,
          // Imported opportunities skip the gathering flow — they
          // start in 'submitted' (scope already lives in Odoo) so the
          // pricing engine can run immediately if the user chooses.
          status: 'submitted',
          submittedAt: new Date(),
          importedFromOdoo: true,
        },
      });

      // Bind the engagement to the Odoo record via OdooEntityLink.
      await db.odooEntityLink.upsert({
        where: { tenantId_odooModel_odooId: { tenantId, odooModel: 'crm.lead', odooId } },
        create: {
          tenantId,
          rhudEntity: 'engagement',
          rhudId: eng.id,
          odooModel: 'crm.lead',
          odooId,
          lastSyncedAt: new Date(),
          cachedRecord: snap as unknown as object,
          cachedAt: new Date(),
          odooWriteDate: imported.odooWriteDate,
        },
        update: {
          rhudEntity: 'engagement',
          rhudId: eng.id,
          lastSyncedAt: new Date(),
          cachedRecord: snap as unknown as object,
          cachedAt: new Date(),
          odooWriteDate: imported.odooWriteDate,
        },
      });

      // Mark the snapshot promoted so subsequent polls keep the
      // engagement in sync but don't show it in "External" anymore.
      await db.odooImportedOpportunity.update({
        where: { id: imported.id },
        data: {
          promotedEngagementId: eng.id,
          promotedAt: new Date(),
          promotedBy: actorUserId,
        },
      });

      // Audit trail: thread event so the engagement timeline shows
      // where it came from.
      await db.threadEvent.create({
        data: {
          tenantId,
          engagementId: eng.id,
          eventType: 'engagement_synced',
          actorType: 'user',
          actorId: actorUserId,
          payload: {
            event: 'imported_from_odoo',
            odooModel: 'crm.lead',
            odooId,
          },
        },
      });

      await this.writeLog(db, tenantId, {
        rhudEntity: 'engagement',
        rhudId: eng.id,
        odooModel: 'crm.lead',
        odooId,
        direction: 'pull',
        operation: 'create',
        status: 'ok',
        triggeredBy: 'manual',
        actorUserId,
      });

      return { engagementId: eng.id, alreadyPromoted: false };
    });
  }

  /** One-time backfill: pull all crm.lead records into the imported
   *  table on first connect. Bounded to avoid exhausting Odoo's rate
   *  limit; runs in `pageSize` batches. The admin can call this from
   *  the UI; we don't auto-run it on connect. */
  async backfillImportedOpportunities(
    tenantId: string,
    opts: { pageSize?: number; maxPages?: number; activeOnly?: boolean } = {},
  ): Promise<{ imported: number; pages: number }> {
    const client = await this.clientFor(tenantId);
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 20;
    const domain: OdooDomain = opts.activeOnly === false ? [] : [['active', '=', true]];

    let imported = 0;
    let pages = 0;
    for (let offset = 0; pages < maxPages; offset += pageSize, pages++) {
      const recs = await client.searchRead<OdooRecord>(
        'crm.lead',
        domain,
        { fields: CRM_LEAD_DEFAULT_FIELDS, limit: pageSize, offset, order: 'id asc' },
      );
      if (recs.length === 0) break;
      for (const rec of recs) {
        const recId = typeof rec.id === 'number' ? rec.id : null;
        if (recId == null) continue;
        try {
          const out = await this.reconcileFromOdoo(tenantId, 'crm.lead', recId, rec);
          if (out.isNewImport) imported += 1;
        } catch (e) {
          this.logger.warn(`backfill reconcile failed odoo_id=${recId}: ${(e as Error).message}`);
        }
      }
      if (recs.length < pageSize) break;
    }

    // Stamp the cursor so subsequent polls start from "now" and don't
    // re-process the entire backfill.
    await this.tenantDb.run(tenantId, async (db) =>
      db.odooConnection.update({
        where: { tenantId },
        data: { lastPolledAt: new Date(), updatedAt: new Date() },
      }),
    );

    return { imported, pages };
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

/** Parse an Odoo write_date / date field. Odoo writes either ISO
 *  ('2026-05-07T08:30:00') or its older space-separated form
 *  ('2026-05-07 08:30:00'). Both are UTC. Returns null on bad input. */
function parseOdooDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (typeof value !== 'string' || value.length === 0) return null;
  // Tolerate both 'YYYY-MM-DD HH:MM:SS' and ISO forms. Always treat as UTC.
  const normalised = value.includes('T') ? value : value.replace(' ', 'T');
  const withZ = normalised.endsWith('Z') || /[+-]\d{2}:?\d{2}$/.test(normalised) ? normalised : `${normalised}Z`;
  const d = new Date(withZ);
  return isNaN(d.getTime()) ? null : d;
}

/** Format a JS Date for Odoo's domain-filter expectation:
 *  'YYYY-MM-DD HH:MM:SS' UTC, no timezone suffix. */
function formatOdooDate(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function importedToDto(row: {
  id: string;
  odooModel: string;
  odooId: number;
  snapshot: unknown;
  odooWriteDate: Date | null;
  promotedEngagementId: string | null;
  promotedAt: Date | null;
  importedAt: Date;
  lastRefreshedAt: Date;
}): OdooImportedOpportunityRow {
  const snap = (row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : {}) as Record<string, unknown>;
  const flat = flattenOdooRecord(snap);
  return {
    id: row.id,
    odooModel: row.odooModel,
    odooId: row.odooId,
    name: typeof flat.name === 'string' ? flat.name : null,
    emailFrom: typeof flat.email_from === 'string' ? flat.email_from : null,
    stageName: typeof flat.stage_id_display === 'string' ? flat.stage_id_display : null,
    userName: typeof flat.user_id_display === 'string' ? flat.user_id_display : null,
    teamName: typeof flat.team_id_display === 'string' ? flat.team_id_display : null,
    expectedRevenue:
      typeof flat.expected_revenue === 'number' ? flat.expected_revenue : null,
    probability: typeof flat.probability === 'number' ? flat.probability : null,
    odooWriteDate: row.odooWriteDate?.toISOString() ?? null,
    promoted: row.promotedEngagementId != null,
    promotedEngagementId: row.promotedEngagementId,
    importedAt: row.importedAt.toISOString(),
    lastRefreshedAt: row.lastRefreshedAt.toISOString(),
  };
}
