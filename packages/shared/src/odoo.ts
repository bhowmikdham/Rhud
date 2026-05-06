// Odoo integration — shared types between API and web.
//
// We deliberately keep the Odoo "shape" loose: Odoo is dynamically
// typed at the model level (any model can have any field), so most
// records flow through the API as Record<string, unknown> with a
// few well-known fields surfaced as helpers.

export type OdooDirection = 'push' | 'pull' | 'both';
export type OdooSyncStatus = 'ok' | 'error' | 'skipped';
export type OdooSyncDirection = 'push' | 'pull';
export type OdooOperation =
  | 'create'
  | 'update'
  | 'unlink'
  | 'read'
  | 'webhook'
  | 'authenticate'
  | 'test';
export type OdooTriggeredBy = 'auto' | 'manual' | 'webhook' | 'system';
export type OdooWebhookStatus = 'pending' | 'processed' | 'failed' | 'ignored';

/** Status object the /integrations page reads to render the Odoo card. */
export interface OdooConnectionStatus {
  /** True when an OdooConnection row exists for this tenant. */
  configured: boolean;
  /** True when the last test succeeded — i.e. credentials work right now. */
  connected: boolean;
  /** Friendly hostname extracted from URL ("acme.odoo.com"). */
  host: string | null;
  /** Database name. */
  database: string | null;
  /** Login email. */
  login: string | null;
  /** Reported by Odoo on the last successful authenticate. */
  serverVersion: string | null;
  /** ISO of the last successful API call. */
  lastConnectedAt: string | null;
  /** Last error message — null when healthy. */
  lastErrorMessage: string | null;
  /** Whether engagement lifecycle events auto-sync. */
  autoSyncEnabled: boolean;
  /** Default crm.team for new opportunities, when set. */
  defaultTeamId: number | null;
  /** Default res.users (salesperson) for new opportunities. */
  defaultUserId: number | null;
  /** The webhook URL to paste into the customer's Odoo Automation Rule. */
  webhookUrl: string | null;
}

export interface UpsertOdooConnectionInput {
  url: string;
  database: string;
  login: string;
  /** Plaintext API key. Only sent on save; never echoed back. Pass an
   *  empty string to leave existing key in place during partial updates. */
  apiKey?: string;
  autoSyncEnabled?: boolean;
  defaultTeamId?: number | null;
  defaultUserId?: number | null;
}

export interface OdooConnectionTestResult {
  ok: boolean;
  /** Authenticated uid when ok. */
  uid: number | null;
  /** Server version reported by Odoo. */
  serverVersion: string | null;
  /** Diagnostic message — successful or error description. */
  message: string;
}

/** A single field-mapping rule. */
export interface OdooFieldMapping {
  id: string;
  rhudEntity: string;
  rhudField: string;
  odooModel: string;
  odooField: string;
  transform: string | null;
  required: boolean;
  direction: OdooDirection;
  updatedAt: string;
}

export interface UpsertOdooFieldMapping {
  id?: string;
  rhudEntity: string;
  rhudField: string;
  odooModel: string;
  odooField: string;
  transform?: string | null;
  required?: boolean;
  direction?: OdooDirection;
}

/** Default mapping suggestions surfaced in the UI when a tenant
 *  hasn't customised anything. The API exposes these so the web app
 *  can render them as "currently active by default" without a save. */
export const ODOO_DEFAULT_MAPPINGS: ReadonlyArray<Omit<OdooFieldMapping, 'id' | 'updatedAt'>> = [
  // Engagement → crm.lead
  { rhudEntity: 'engagement', rhudField: 'name',                odooModel: 'crm.lead',    odooField: 'name',              transform: null,              required: true,  direction: 'push' },
  { rhudEntity: 'engagement', rhudField: 'clientEmail',         odooModel: 'crm.lead',    odooField: 'email_from',        transform: null,              required: false, direction: 'push' },
  { rhudEntity: 'engagement', rhudField: 'approvedPriceCents',  odooModel: 'crm.lead',    odooField: 'expected_revenue',  transform: 'cents_to_currency', required: false, direction: 'push' },
  { rhudEntity: 'engagement', rhudField: 'status',              odooModel: 'crm.lead',    odooField: 'kanban_state',      transform: null,              required: false, direction: 'push' },
  // Engagement → res.partner (the contact)
  { rhudEntity: 'engagement', rhudField: 'clientEmail',         odooModel: 'res.partner', odooField: 'email',             transform: null,              required: true,  direction: 'push' },
];

/** A row in the Odoo sync log shown in the integrations dashboard. */
export interface OdooSyncLogRow {
  id: string;
  rhudEntity: string | null;
  rhudId: string | null;
  odooModel: string | null;
  odooId: number | null;
  direction: OdooSyncDirection;
  operation: OdooOperation;
  status: OdooSyncStatus;
  triggeredBy: OdooTriggeredBy;
  actorUserId: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  createdAt: string;
}

/** A mapping entry showing where a Rhud record landed in Odoo. */
export interface OdooEntityLinkRow {
  id: string;
  rhudEntity: string;
  rhudId: string;
  odooModel: string;
  odooId: number;
  lastSyncedAt: string | null;
  odooWriteDate: string | null;
}

export interface OdooWebhookEventRow {
  id: string;
  odooModel: string;
  odooId: number | null;
  eventType: string;
  status: OdooWebhookStatus;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
}

/** Entity push request body — the user clicked "Sync to Odoo" in the UI. */
export interface OdooPushRequest {
  /** Force re-create even when an OdooEntityLink already exists. */
  force?: boolean;
  /** Override the default model — useful for "create as lead, not opp". */
  asModel?: string;
  /** Optional caller-specified field overrides applied AFTER mapping. */
  overrides?: Record<string, unknown>;
}

export interface OdooPushResult {
  ok: boolean;
  odooModel: string;
  odooId: number;
  operation: OdooOperation;
  /** When ok=false, why. */
  message?: string;
}

/** Generic record returned from a search_read call. Caller knows the
 *  shape based on the model they asked for. */
export type OdooRecord = Record<string, unknown> & { id?: number };

/** Common CRM models the UI needs to know about for dropdowns. */
export interface OdooStageOption { id: number; name: string; sequence: number; isWon?: boolean }
export interface OdooTeamOption  { id: number; name: string }
export interface OdooUserOption  { id: number; name: string; login: string }
export interface OdooTagOption   { id: number; name: string; color?: number }
