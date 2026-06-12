/**
 * Shared types for the Gamma proposal-template library (multi-template v2).
 *
 * A tenant curates a LIBRARY of reusable Gamma decks (GammaTemplate); each
 * opportunity selects one (Engagement.selectedGammaTemplateId), decoupled
 * from the questionnaire Template so it works for template-less
 * (direct-ingest) opportunities too. The `manifest` bridges a rep-authored
 * Gamma deck (placeholder tokens like "[[investment]]") to Rhud's computed
 * fields and names sections to keep verbatim.
 *
 * See docs/gamma-multi-template-design.md.
 */

// ── Field catalog ────────────────────────────────────────────────────────────

/** The computed values Rhud can push into a Gamma deck per proposal. Mirrors
 *  the scaffold context built in proposal-draft.service.ts. */
export const GAMMA_FIELD_KEYS = [
  'clientName',
  'clientEmail',
  'opportunityName',
  'serviceLine',
  'tenantName',
  'investment',
  'date',
  'lineItems',
  'scopeSummary',
] as const;
export type GammaFieldKey = (typeof GAMMA_FIELD_KEYS)[number];
export function isGammaFieldKey(v: unknown): v is GammaFieldKey {
  return typeof v === 'string' && (GAMMA_FIELD_KEYS as readonly string[]).includes(v);
}

export const GAMMA_TEMPLATE_FORMATS = ['presentation', 'document'] as const;
export type GammaTemplateFormat = (typeof GAMMA_TEMPLATE_FORMATS)[number];
export function isGammaTemplateFormat(v: unknown): v is GammaTemplateFormat {
  return typeof v === 'string' && (GAMMA_TEMPLATE_FORMATS as readonly string[]).includes(v);
}

export const GAMMA_TEMPLATE_STATUSES = ['active', 'archived'] as const;
export type GammaTemplateStatus = (typeof GAMMA_TEMPLATE_STATUSES)[number];
export function isGammaTemplateStatus(v: unknown): v is GammaTemplateStatus {
  return typeof v === 'string' && (GAMMA_TEMPLATE_STATUSES as readonly string[]).includes(v);
}

// ── Manifest ─────────────────────────────────────────────────────────────────

/** One placeholder→field bridge inside a Gamma deck. `token` is the literal
 *  text the rep placed in the deck (e.g. "[[investment]]"); `fieldKey` says
 *  which computed Rhud value replaces it. */
export interface GammaManifestField {
  token: string;
  fieldKey: GammaFieldKey;
  label: string;
  defaultInclude: boolean;
}

export interface GammaTemplateManifest {
  fields: GammaManifestField[];
  /** Named cards/sections to keep verbatim by default. Rep-typed names —
   *  Gamma's REST API can't enumerate a deck's cards. */
  lockedSections: string[];
}

/** Canonical empty manifest. The DB column defaults to `{}`; the API service
 *  normalizes every read through this so consumers always get both arrays. */
export const EMPTY_GAMMA_MANIFEST: GammaTemplateManifest = { fields: [], lockedSections: [] };

// ── Library entry (public shape) ─────────────────────────────────────────────

export interface GammaTemplate {
  id: string;
  tenantId: string;
  label: string;
  /** The Gamma File ID this entry clones from (free-form; not a UUID). */
  gammaTemplateId: string;
  format: GammaTemplateFormat;
  /** Label / future per-service-line default hook. Not used for v1 resolution. */
  serviceLine: string | null;
  isDefault: boolean;
  manifest: GammaTemplateManifest;
  status: GammaTemplateStatus;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

export interface CreateGammaTemplate {
  label: string;
  gammaTemplateId: string;
  format?: GammaTemplateFormat;
  serviceLine?: string | null;
  isDefault?: boolean;
  manifest?: GammaTemplateManifest;
}

export type UpdateGammaTemplate = Partial<CreateGammaTemplate>;

export interface GammaTemplateTestResult {
  ok: boolean;
  error?: string;
}

// ── Per-proposal generation request ──────────────────────────────────────────

export interface GammaFieldOverride {
  fieldKey: GammaFieldKey;
  include: boolean;
  /** Rep's edited value; omit → use the computed value. */
  value?: string;
}

export interface GenerateDraftRequest {
  /** Library entry id (GammaTemplate.id), NOT the raw Gamma File ID. */
  gammaTemplateId?: string;
  fieldOverrides?: GammaFieldOverride[];
  lockedSections?: string[];
}

// ── Field-preview (powers the per-proposal review form) ──────────────────────

export interface FieldPreviewField {
  fieldKey: GammaFieldKey;
  label: string;
  /** The deck placeholder this field maps to, when the manifest declares one. */
  token: string | null;
  computedValue: string;
  include: boolean;
}

export interface FieldPreviewTemplateOption {
  id: string;
  label: string;
  isDefault: boolean;
  serviceLine: string | null;
  format: GammaTemplateFormat;
}

export interface FieldPreviewResponse {
  /** The tenant's active library entries, for the picker. */
  templates: FieldPreviewTemplateOption[];
  /** The entry this opportunity currently resolves to (null = freeform). */
  resolvedTemplateId: string | null;
  fields: FieldPreviewField[];
  lockedSections: string[];
}
