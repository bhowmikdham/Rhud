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
  // Engagement → crm.lead.
  // Note: we deliberately do NOT map Rhud `status` to `crm.lead.kanban_state`.
  // That field was removed from crm.lead in Odoo 18+ (it was a kanban-only
  // UI thing) and breaks search_read on those versions. Stage transitions
  // in Odoo are now driven by `stage_id`, which a tenant maps explicitly
  // if they want it (the default mapping leaves stage_id alone — the
  // Odoo-side default stage applies on create).
  { rhudEntity: 'engagement', rhudField: 'name',                odooModel: 'crm.lead',    odooField: 'name',              transform: null,              required: true,  direction: 'push' },
  { rhudEntity: 'engagement', rhudField: 'clientEmail',         odooModel: 'crm.lead',    odooField: 'email_from',        transform: null,              required: false, direction: 'push' },
  { rhudEntity: 'engagement', rhudField: 'approvedPriceCents',  odooModel: 'crm.lead',    odooField: 'expected_revenue',  transform: 'cents_to_currency', required: false, direction: 'push' },
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

// ── Inbound (Odoo → Rhud) sync ───────────────────────────────────────

/** Snapshot of an Odoo opportunity that hasn't been promoted to a
 *  Rhud Engagement yet. Surfaced in the "External (from Odoo)" list. */
export interface OdooImportedOpportunityRow {
  id: string;
  odooModel: string;
  odooId: number;
  /** Display name from Odoo crm.lead.name. */
  name: string | null;
  /** Email of the lead's contact (lead.email_from). */
  emailFrom: string | null;
  /** Stage label flattened from crm.lead.stage_id [id, name]. */
  stageName: string | null;
  /** Salesperson display name flattened from user_id [id, name]. */
  userName: string | null;
  /** Sales team display name. */
  teamName: string | null;
  /** Expected revenue in account currency (Odoo's float field). */
  expectedRevenue: number | null;
  /** Probability percentage (0..100) from Odoo. */
  probability: number | null;
  /** ISO timestamp of Odoo's write_date — when the record last changed. */
  odooWriteDate: string | null;
  /** True when this snapshot has been promoted to a Rhud Engagement. */
  promoted: boolean;
  /** When non-null, the Rhud engagement id this snapshot promoted to. */
  promotedEngagementId: string | null;
  /** ISO of import + last refresh times. */
  importedAt: string;
  lastRefreshedAt: string;
}

/** Body of the "promote imported opportunity to engagement" request. */
export interface PromoteImportedOpportunityInput {
  /** Rhud template to bind the new Engagement to (required — Odoo
   *  doesn't have an analogue, the user picks). */
  templateId: string;
  /** Sales rep to assign. Defaults to the calling user when omitted. */
  salesEmployeeId?: string;
  /** Optional Rhud-side display name override; falls back to crm.lead.name. */
  name?: string;
}

export interface PromoteImportedOpportunityResult {
  engagementId: string;
  alreadyPromoted: boolean;
}

/** Result of an incremental poll cycle. */
export interface OdooPollResult {
  ok: boolean;
  changed: number;
  imported: number;
  promoted: number;
  skippedEcho: number;
  errors: number;
  /** ISO of the new cursor (nullable when nothing was found). */
  newCursor: string | null;
  /** When ok=false, why. */
  message?: string;
}
