/**
 * Tiny typed fetch wrapper for the Rhud API.
 *
 * Lives entirely on the client (uses localStorage). Once we add SSR for
 * authenticated views, this becomes a thin facade over a server-side fetch
 * that reads cookies — but for sprint 2 the admin UI is client-rendered.
 */
import type {
  LoopConfig,
  NodeBinding,
  Template,
  TemplateWithNodes,
  TemplateNode,
  NextRule,
  NodeOption,
  NodeType,
  TemplateStatus,
} from '@rhud/shared';

export type {
  LoopConfig,
  NextRule,
  NodeBinding,
  NodeOption,
  NodeType,
  Template,
  TemplateNode,
  TemplateWithNodes,
};

export type CreateTemplate = { serviceLine: string; name: string };
export type UpdateTemplate = Partial<{
  serviceLine: string;
  name: string;
  rootNodeId: string;
  status: TemplateStatus;
  rateCardId: string | null;
  /** Gamma template id forwarded to Gamma when proposal drafting is
   *  routed through the Gamma driver. Empty string clears it. */
  gammaTemplateId: string | null;
  /** Markdown scaffold with `{{token}}` merge fields. Empty string
   *  clears it (reverts to AI-generates-everything). */
  proposalScaffold: string | null;
}>;
export type CreateNode = {
  question: string;
  nodeType: NodeType;
  helpText?: string | null;
  placeholder?: string | null;
  required?: boolean;
  options?: NodeOption[];
  allowFiles?: boolean;
  nextRules?: NextRule[];
  position?: number;
  parentNodeId?: string;
  loopConfig?: LoopConfig;
  binding?: NodeBinding | null;
};
export type UpdateNode = Partial<CreateNode>;

export type ImportNodeInput = {
  question: string;
  nodeType: NodeType;
  helpText?: string;
  placeholder?: string;
  required?: boolean;
  options?: NodeOption[];
  allowFiles?: boolean;
};

const BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

function token(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem('rhud.token');
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
  }

  /** A user-facing message that respects whatever the server provided. */
  get displayMessage(): string {
    const body = this.body as { message?: string | string[]; error?: string } | null;
    if (this.status === 401) return 'Sign in again to continue.';
    if (this.status === 403) return "Your role doesn't have permission for that action.";
    if (this.status === 404) return 'Not found.';
    if (Array.isArray(body?.message)) return body!.message!.join(', ');
    if (typeof body?.message === 'string') return body!.message!;
    if (typeof body?.error === 'string') return body!.error!;
    return `Request failed (${this.status}).`;
  }
}

/** Helper for components that want a flat string error from anything thrown. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.displayMessage;
  if (e instanceof Error) return e.message;
  return String(e);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const t = token();
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  if (t) headers.set('authorization', `Bearer ${t}`);

  const res = await fetch(`${BASE}/api/v1${path}`, { ...init, headers });
  // Read the body as text once — `res.json()` would consume the stream
  // and any subsequent `res.text()` (e.g. in the error path) throws
  // "body already used". We parse JSON ourselves and gracefully fall
  // back to the raw text for non-JSON responses (a misrouted proxy
  // serving HTML, for instance).
  const rawText = res.status === 204 ? '' : await res.text();
  let parsed: unknown = null;
  if (rawText) {
    try {
      parsed = JSON.parse(rawText);
    } catch {
      parsed = rawText;
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, parsed, `${res.status} ${path}`);
  }
  // NestJS serialises a controller returning `null` as an empty body
  // (Content-Length: 0) rather than the literal string "null". Treat
  // empty bodies as `null` so callers don't have to special-case this.
  return parsed as T;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export const auth = {
  async login(email: string, password: string) {
    return request<{ token: string; user: { sub: string; tid: string; role: string; email: string } }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password }) },
    );
  },
  async me() {
    return request<{ sub: string; tid: string; role: string; email: string }>('/auth/me');
  },
};

// ── Templates ───────────────────────────────────────────────────────────────

export const templates = {
  list: () => request<Template[]>('/templates'),
  get: (id: string) => request<TemplateWithNodes>(`/templates/${id}`),
  create: (dto: CreateTemplate) =>
    request<Template>('/templates', { method: 'POST', body: JSON.stringify(dto) }),
  update: (id: string, dto: UpdateTemplate) =>
    request<Template>(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  remove: (id: string) => request<void>(`/templates/${id}`, { method: 'DELETE' }),

  addNode: (id: string, dto: CreateNode) =>
    request<TemplateNode>(`/templates/${id}/nodes`, { method: 'POST', body: JSON.stringify(dto) }),
  updateNode: (id: string, nodeId: string, dto: UpdateNode) =>
    request<TemplateNode>(`/templates/${id}/nodes/${nodeId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  removeNode: (id: string, nodeId: string) =>
    request<void>(`/templates/${id}/nodes/${nodeId}`, { method: 'DELETE' }),

  importNodes: (id: string, dto: { replace?: boolean; nodes: ImportNodeInput[] }) =>
    request<{ created: number; rootNodeId: string }>(`/templates/${id}/nodes/import`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),

  validate: (id: string) =>
    request<{ issues: Array<{ code: string; message: string; nodeId?: string }> }>(
      `/templates/${id}/validate`,
      { method: 'POST' },
    ),

  /** Pre-delete probe: opportunities currently using this template. */
  usage: (id: string) =>
    request<{ engagementCount: number }>(`/templates/${id}/usage`),

  /** Install the Prophaze gathering template, bound to the supplied rate card.
   *  Mirrors the rate-card seed flow — the admin first installs the rate card,
   *  then this endpoint wires a template that maps every body answer to one of
   *  its driver slugs. */
  seedProphazeSample: (rateCardId: string) =>
    request<TemplateWithNodes>('/templates/seed/prophaze-sample', {
      method: 'POST',
      body: JSON.stringify({ rateCardId }),
    }),
};

// ── Opportunities (sales-facing) ────────────────────────────────────────────
// User-facing language: "Opportunity". The DB table + Prisma model are still
// called `engagements` for historical reasons; the UI only ever shows
// "Opportunity". Type names retain the legacy prefix to avoid churn.

export interface EngagementSummary {
  id: string;
  templateId: string;
  templateName: string;
  /** Free-text label set when the opportunity was created. */
  name: string | null;
  clientEmail: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
  predictedPriceCents: number | null;
  priceLowCents: number | null;
  priceHighCents: number | null;
}

/** Legacy alias used by older imports. */
export type OpportunitySummary = EngagementSummary;

export interface ThreadEventRow {
  id: string;
  eventType: string;
  actorType: string;
  actorId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface IssuedLink {
  engagementId: string;
  token: string;
  url: string;
  expiresAt: string;
}

/** Currently-active gathering link for an opportunity. Surfaces on the
 *  detail page so a rep can copy the URL after leaving the issue wizard. */
export interface GatheringLinkInfo {
  url: string;
  expiresAt: string;
  isExpired: boolean;
  isRevoked: boolean;
  accessCount: number;
}

export const opportunities = {
  list: () => request<EngagementSummary[]>('/opportunities'),
  get: (id: string) =>
    request<EngagementSummary & {
      thread: ThreadEventRow[];
      gatheringLink: GatheringLinkInfo | null;
    }>(`/opportunities/${id}`),
  issue: (dto: {
    templateId: string;
    clientEmail: string;
    name?: string;
    expiresInDays?: number;
  }) =>
    request<IssuedLink>('/opportunities', { method: 'POST', body: JSON.stringify(dto) }),
  remove: (id: string) =>
    request<void>(`/opportunities/${id}`, { method: 'DELETE' }),
};

/** Backwards-compat alias — prefer `opportunities` in new code. */
export const engagements = opportunities;

// ── Pricing engine — rate cards + quotes ─────────────────────────────────────

export interface RateCardSummary {
  id: string;
  name: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  currency: string;
}

export interface RateCardTier {
  id: string;
  rangeMin: number;
  rangeMax: number | null;
  methodology: string | null;
  customerType: 'internal' | 'external';
  priceCents: number;
  displayLabel?: string | null;
}

export interface RateCardServiceLineFull {
  id: string;
  slug: string;
  displayName: string;
  scopeUnit: 'pages' | 'screens' | 'apis' | 'loc' | 'devices' | 'hours' | 'other';
  pricingModel: 'tier_lookup' | 'per_unit' | 'flat' | 'hourly';
  position: number;
  tiers: RateCardTier[];
}

export interface RateCardOpenPricedServiceFull {
  id: string;
  slug: string;
  displayName: string;
  category?: string | null;
  position: number;
}

export interface RateCardFull extends RateCardSummary {
  serviceLines: RateCardServiceLineFull[];
  openPricedServices: RateCardOpenPricedServiceFull[];
}

export interface BasePriceLine {
  entityId: string;
  serviceLineSlug: string;
  serviceLineName: string;
  scopeUnit: string;
  scopeValue: number;
  methodology: string | null;
  customerType: 'internal' | 'external';
  tierId: string | null;
  tierLabel: string | null;
  priceCents: number;
  /** 'per_unit' | 'tier_lookup' | 'flat' | 'hourly' — included when
   *  the line is priced (not unmatched). Lets the UI render the math. */
  pricingModel?: 'per_unit' | 'tier_lookup' | 'flat' | 'hourly';
  /** Per-unit rate for `per_unit` lines. Null for flat/tier_lookup. */
  unitPriceCents?: number | null;
  manualQuoteRequired?: boolean;
  unmatched?: { reason: string };
}

export interface EngagementQuote {
  id: string;
  engagementId: string;
  rateCardId: string | null;
  rateCardVersion: number;
  currency: string;
  baseTotalCents: number;
  baseBreakdown: BasePriceLine[];
  predictedAdjustmentPct: number | null;
  predictedPriceCents: number | null;
  predictedBandLowCents: number | null;
  predictedBandHighCents: number | null;
  winProbability: number | null;
  techAdjustedPriceCents: number | null;
  techAdjustedAt: string | null;
  techAdjustedBy: string | null;
  techAdjustmentNote: string | null;
  techAdjustedPredictionId: string | null;
  approvedPriceCents: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  computedAt: string;
}

export interface RateCardAiCoverage {
  serviceLines: number;
  tiers: number;
  openPriced: number;
}

export type RateCardAiParseResult =
  | {
      mode: 'auto';
      rateCardId: string;
      draftName: string;
      provider: string;
      model?: string;
      coverage: RateCardAiCoverage;
      warnings: string[];
    }
  | { mode: 'manual'; prompt: string };

export const rateCards = {
  list: () => request<RateCardSummary[]>('/rate-cards'),
  get: (id: string) => request<RateCardFull>(`/rate-cards/${id}`),
  publish: (id: string) =>
    request<RateCardFull>(`/rate-cards/${id}/publish`, { method: 'PATCH' }),
  archive: (id: string) =>
    request<RateCardFull>(`/rate-cards/${id}/archive`, { method: 'PATCH' }),
  seedSample: () =>
    request<RateCardFull>('/rate-cards/seed/csaas-sample', { method: 'POST' }),
  /** Install the Prophaze rate card + the matching gathering template in one call.
   *  Returns the freshly created rate card; the template is bound to it server-side. */
  seedProphazeSample: () =>
    request<RateCardFull>('/rate-cards/seed/prophaze-sample', { method: 'POST' }),
  /** Parse an uploaded sheet (matrix of cells) and persist as a draft card. */
  parseSheet: (matrix: string[][], name?: string) =>
    request<{ rateCardId: string; warnings: string[] }>('/rate-cards/parse', {
      method: 'POST',
      body: JSON.stringify(name ? { matrix, name } : { matrix }),
    }),
  /** Pre-delete probe: how many templates would be unbound. */
  usage: (id: string) =>
    request<{ templateBindings: number }>(`/rate-cards/${id}/usage`),
  remove: (id: string) =>
    request<void>(`/rate-cards/${id}`, { method: 'DELETE' }),
  /** AI-driven parser for sheets that don't match the CSaaS layout. */
  parseWithAi: (matrix: string[][], name?: string) =>
    request<RateCardAiParseResult>('/rate-cards/parse-with-ai', {
      method: 'POST',
      body: JSON.stringify(name ? { matrix, name } : { matrix }),
    }),
  /** Manual-mode follow-up: admin pastes the AI's JSON, we save it. */
  parseWithAiManual: (text: string, name?: string) =>
    request<{ rateCardId: string; draftName: string; coverage: RateCardAiCoverage; warnings: string[] }>(
      '/rate-cards/parse-with-ai/manual',
      {
        method: 'POST',
        body: JSON.stringify(name ? { text, name } : { text }),
      },
    ),
};

export const quotes = {
  forEngagement: (engagementId: string) =>
    request<EngagementQuote | null>(`/opportunities/${engagementId}/quote`),
  recompute: (engagementId: string) =>
    request<EngagementQuote | null>(`/opportunities/${engagementId}/quote/recompute`, {
      method: 'POST',
    }),
  approve: (engagementId: string, approvedPriceCents: number) =>
    request<EngagementQuote>(`/opportunities/${engagementId}/quote/approve`, {
      method: 'POST',
      body: JSON.stringify({ approvedPriceCents }),
    }),
};

// ── Adaptive pricing — predictions, regime cascade, approval ────────────────

export type Regime = 'cold_start' | 'rules' | 'linear' | 'boosted';

export interface PredictionDriver {
  feature: string;
  weight: number;
  direction: 'discount' | 'premium' | 'neutral';
  label?: string;
}

export interface Prediction {
  id: string;
  engagementId: string;
  regime: Regime;
  basePriceCents: number;
  predictedPriceCents: number;
  adjustmentPct: number;
  bandLowCents: number;
  bandHighCents: number;
  drivers: PredictionDriver[];
  similarPast: unknown[];
  dataQuality: Record<string, unknown>;
  createdAt: string;
}

export type ApprovalChoice = 'base' | 'recommended' | 'aggressive' | 'tech_adjusted' | 'custom';

export interface ApprovalResult {
  engagementId: string;
  approvedPriceCents: number;
  status: string;
  predictionId: string;
  choice: ApprovalChoice;
}

export const predictions = {
  predict: (engagementId: string) =>
    request<Prediction>(`/opportunities/${engagementId}/predict`, { method: 'POST' }),
  list: (engagementId: string) =>
    request<Prediction[]>(`/opportunities/${engagementId}/predictions`),
  latest: (engagementId: string) =>
    request<Prediction | null>(`/opportunities/${engagementId}/predictions/latest`),
  approve: (
    engagementId: string,
    body: {
      predictionId: string;
      choice: ApprovalChoice;
      customPriceCents?: number;
      comment?: string;
      optionalComment?: string;
    },
  ) =>
    request<ApprovalResult>(`/opportunities/${engagementId}/approve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  reject: (
    engagementId: string,
    body: { reason: string; predictionId?: string },
  ) =>
    request<{ engagementId: string; status: string }>(
      `/opportunities/${engagementId}/reject`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revertApproval: (engagementId: string) =>
    request<{ engagementId: string; status: string }>(
      `/opportunities/${engagementId}/revert-approval`,
      { method: 'POST' },
    ),
  /** Tech-team only: lodge an adjusted price for the manager to review. */
  techAdjust: (
    engagementId: string,
    body: { predictionId: string; adjustedPriceCents: number; note?: string },
  ) =>
    request<{
      engagementId: string;
      techAdjustedPriceCents: number | null;
      techAdjustedAt: string | null;
      techAdjustedPredictionId: string | null;
    }>(`/opportunities/${engagementId}/tech-adjust`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

// ── Tenant pricing config (regime thresholds + loyalty rules) ───────────────

export interface LoyaltyRule {
  tier: string;
  minLifetimeValueCents: number;
  discountPct: number;
  label?: string;
}

export interface ManualModifier {
  name: string;
  multiplier: number;
  label?: string;
}

export interface TenantPricingConfig {
  tenantId: string;
  loyaltyRules: LoyaltyRule[];
  manualModifiers: ManualModifier[];
  coldStartUntilNClosed: number;
  rulesUntilNClosed: number;
  linearUntilNClosed: number;
  retrainHourUtc: number;
  updatedAt: string;
}

// ── Team management (admin) ─────────────────────────────────────────────────

export type Role = 'admin' | 'sales_manager' | 'sales_employee' | 'tech_team';

export interface UserSummary {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
}

export interface InviteSummary {
  id: string;
  email: string;
  role: Role;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  invitedByEmail: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface TenantInfo {
  id: string;
  name: string;
  plan: string;
}

export const tenant = {
  me: () => request<TenantInfo>('/tenant/me'),
  update: (dto: { name?: string }) =>
    request<TenantInfo>('/tenant/me', { method: 'PATCH', body: JSON.stringify(dto) }),
};

export const team = {
  listUsers: () => request<UserSummary[]>('/tenant/users'),
  updateUserRole: (id: string, role: Role) =>
    request<UserSummary>(`/tenant/users/${id}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    }),
  removeUser: (id: string) => request<void>(`/tenant/users/${id}`, { method: 'DELETE' }),

  listInvites: () => request<InviteSummary[]>('/tenant/invites'),
  createInvite: (dto: { email: string; role: Role }) =>
    request<{ invite: InviteSummary; devToken?: string }>('/tenant/invites', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  resendInvite: (id: string) =>
    request<{ devToken?: string }>(`/tenant/invites/${id}/resend`, { method: 'POST' }),
  revokeInvite: (id: string) =>
    request<void>(`/tenant/invites/${id}`, { method: 'DELETE' }),
};

// ── LLM (admin) ─────────────────────────────────────────────────────────────

export type LlmProviderName =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'openai_compat'
  | 'manual';

export type JustificationResult =
  | { mode: 'auto'; text: string; provider: string; model?: string }
  | { mode: 'manual'; prompt: string };

export interface GeneratedTemplateNode {
  question: string;
  nodeType: NodeType;
  helpText?: string;
  required?: boolean;
  options?: NodeOption[];
}

export type TemplateGenResult =
  | { mode: 'auto'; nodes: GeneratedTemplateNode[]; provider: string; model?: string }
  | { mode: 'manual'; prompt: string };

export const templateGen = {
  generate: (description: string, serviceLine?: string) =>
    request<TemplateGenResult>('/templates/from-description', {
      method: 'POST',
      body: JSON.stringify({ description, ...(serviceLine && { serviceLine }) }),
    }),
  parseManual: (text: string) =>
    request<{ nodes: GeneratedTemplateNode[] }>('/templates/from-description/parse-manual', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
};

// ── Proposal draft (LLM-generated + Gamma + manual paste-back) ─────────────

export interface CurrentProposalDraft {
  text: string | null;
  draftedAt: string | null;
  source: string | null;
  status: string;
  gammaDeckUrl: string | null;
  gammaDeckId: string | null;
  /** Live Gamma phase ("queued", "processing", "completed") while a
   *  generation is in flight. Null otherwise. */
  gammaPhase: string | null;
  /** Seconds since the Gamma generation kicked off. */
  gammaElapsedSeconds: number | null;
  /** True when a PDF attachment is downloadable for the Send-to-client
   *  modal. False for text-only drafts and for Gamma drafts whose
   *  cached export URL has expired. */
  proposalPdfAvailable: boolean;
  /** ISO timestamp — Gamma export URLs lapse after ~7 days. */
  proposalPdfExpiresAt: string | null;
}

export type ProposalDraftResult =
  | { mode: 'auto'; text: string; provider: string; draftedAt: string }
  | { mode: 'gamma'; url: string; deckId: string; draftedAt: string }
  | { mode: 'gamma_pending'; generationId: string }
  | { mode: 'manual'; prompt: string };

// ── Gamma integration (admin) ───────────────────────────────────────────────

export type ProposalDriver = 'llm' | 'gamma';

export interface GammaConfig {
  workspaceName: string | null;
  workspaceId: string | null;
  apiKeySet: boolean;
  proposalDriver: ProposalDriver;
  enabled: boolean;
  updatedAt: string;
}

export interface UpsertGammaConfig {
  workspaceName?: string | null;
  workspaceId?: string | null;
  /** undefined leaves existing key alone; '' or null clears it. */
  apiKey?: string | null;
  proposalDriver?: ProposalDriver;
  enabled?: boolean;
}

export const gamma = {
  get: () => request<GammaConfig | null>('/tenant/gamma-config'),
  upsert: (dto: UpsertGammaConfig) =>
    request<GammaConfig>('/tenant/gamma-config', { method: 'PUT', body: JSON.stringify(dto) }),
  remove: () => request<void>('/tenant/gamma-config', { method: 'DELETE' }),
  test: () =>
    request<{ ok: boolean; error?: string }>('/tenant/gamma-config/test', { method: 'POST' }),
};

export const proposalDraft = {
  current: (engagementId: string) =>
    request<CurrentProposalDraft>(`/opportunities/${engagementId}/draft`),
  generate: (engagementId: string) =>
    request<ProposalDraftResult>(`/opportunities/${engagementId}/draft`, { method: 'POST' }),
  acceptManual: (engagementId: string, text: string) =>
    request<{ text: string; draftedAt: string }>(
      `/opportunities/${engagementId}/draft/manual`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  clear: (engagementId: string) =>
    request<void>(`/opportunities/${engagementId}/draft`, { method: 'DELETE' }),
  markSent: (engagementId: string) =>
    request<{ status: string }>(`/opportunities/${engagementId}/draft/mark-sent`, {
      method: 'POST',
    }),
  /** URL the rep can use to download / open the proposal PDF (Gamma export).
   *  Resolves server-side via a 302; safe to use as an `<a href>` or to
   *  pass to the browser's native download flow. Returns null when no
   *  PDF is available (text drafts in phase 1, or expired Gamma URL). */
  /**
   * Trigger a browser download of the proposal PDF. We can't use a
   * plain <a href> because the API endpoint requires a bearer token,
   * and a navigation drops localStorage-stored auth. Instead: fetch
   * the bytes (with the header) and synthesise a click on a hidden
   * anchor pointing at an object URL.
   *
   * Returns true on success, false when the PDF is unavailable
   * (expired Gamma export URL, or text-only draft).
   */
  async downloadPdf(engagementId: string, filename = 'Proposal.pdf'): Promise<boolean> {
    const t =
      typeof window === 'undefined' ? null : window.localStorage.getItem('rhud.token');
    const res = await fetch(
      `${BASE}/api/v1/opportunities/${engagementId}/draft/pdf`,
      { headers: t ? { authorization: `Bearer ${t}` } : {} },
    );
    if (!res.ok) return false;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    return true;
  },
  /** One-click send via the rep's connected Outlook account. */
  sendViaOutlook: (engagementId: string, args: { subject: string; body: string }) =>
    request<{ status: string; recipientEmail: string; sentFrom: string }>(
      `/opportunities/${engagementId}/draft/send-via-outlook`,
      { method: 'POST', body: JSON.stringify(args) },
    ),
};

export interface OutlookConnectionStatus {
  /** True when the rep has completed OAuth at least once. */
  connected: boolean;
  /** Mailbox the proposal will be sent FROM. */
  accountEmail: string | null;
  /** True when an admin has configured the workspace's Microsoft app. */
  available: boolean;
  updatedAt: string | null;
}

export interface OutlookAppConfig {
  /** True when an admin has saved Microsoft Entra credentials. */
  isConfigured: boolean;
  /** Public Application (client) ID — safe to display. */
  clientId: string | null;
  /** The redirect URI the admin must paste into Microsoft Entra. */
  redirectUri: string;
  updatedAt: string | null;
}

// ── Document extraction (client-uploaded files → structured points) ───────

export type PointCategory =
  | 'scope'
  | 'methodology'
  | 'service_type'
  | 'identity'
  | 'environment'
  | 'compliance'
  | 'other';

export interface ExtractedPoint {
  key: string;
  value: string;
  sourceQuote: string;
  relatedQuestion: string | null;
  /** Sheet name the point came from (multi-sheet xlsx). Null for
   *  PDFs / LLM-extracted points. */
  sheet?: string | null;
  /** Layer 2 — semantic classification surfaced as a chip in the UI. */
  category?: PointCategory;
}

export interface InferredEntity {
  serviceLineSlug: string;
  scopeValue: number;
  methodology: string | null;
  customerType: 'internal' | 'external';
  /** 0..1 — only ≥0.6 reach the priced quote. */
  confidence: number;
  reasoning: string;
  sourceQuote: string;
  /** Where this inference came from. `manual` means a rep override. */
  source: 'llm' | 'heuristic' | 'manual';
}

export interface FileExtraction {
  id: string;
  filename: string;
  contentType: string;
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped' | 'retry_queued' | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** When status === 'retry_queued', the ISO timestamp the cron will
   *  re-fire the extraction. The UI uses this to render a countdown
   *  ("Retrying in 1m 23s…"). Null otherwise. */
  retryAt: string | null;
  /** Number of attempts made so far. Surfaced in the UI as
   *  "attempt 2/5" so the rep knows we're not infinitely looping. */
  attempts: number;
  error: string | null;
  points: ExtractedPoint[];
  /** Layer 3 — service-line entities the mapper produced from this
   *  file. The rep can edit these inline to override the LLM. */
  inferredEntities: InferredEntity[];
  emptyResult: boolean;
  /** Engagement-wide pipeline counters — diagnose chain breaks
   *  without needing log access. */
  diagnostics: {
    extracted: number;
    matchedToQuestion: number;
    /** Layer 3 — service-line entities the field mapper produced
     *  with confidence ≥0.6 (LLM-first, heuristic safety net). */
    inferredHighConfidence: number;
    answeredQuestions: number;
    mappedToRateCard: number;
    quoteLineItems: number;
    rateCardBound: boolean;
  };
}

/**
 * Canonical RhudDocument shape on the wire. Mirrors
 * `packages/shared/src/document.ts` so the web client doesn't import
 * @rhud/shared directly (web has its own minimal type surface for
 * Layer-3 contracts). Keep these in sync — the backend test suite
 * locks the server-side shape; this type is what the UI renders.
 */
export interface ParsedDocument {
  id: string;
  filename: string;
  contentType: string;
  parsedAt: string;
  sheets: Array<{
    name: string;
    index: number;
    rowCount: number;
    columnCount: number;
    rows: Array<{
      index: number;
      cells: Array<{
        column: number;
        value: string;
        mergeAnchor?: boolean;
        mergedFromAnchor?: boolean;
      }>;
    }>;
    detectedShape: 'qa' | 'asset_list' | 'pricing_table' | null;
  }>;
  textBlocks: Array<{
    heading: string | null;
    headingDepth: number | null;
    body: string;
    page: number | null;
  }>;
  warnings: string[];
}

export const extraction = {
  list: (engagementId: string) =>
    request<FileExtraction[]>(`/opportunities/${engagementId}/extraction`),
  reExtract: (engagementId: string, fileId: string) =>
    request<{ status: 'kicked_off' }>(
      `/opportunities/${engagementId}/files/${fileId}/extract`,
      { method: 'POST' },
    ),
  /** Re-run JUST the Layer-3 mapper LLM using the file's cached
   *  extracted points. Use this after a 429 / mapper failure — much
   *  faster than `reExtract` because S3 + text extraction are skipped. */
  rerunInference: (engagementId: string, fileId: string) =>
    request<{ rerun: 'mapper_only' | 'full_extract' }>(
      `/opportunities/${engagementId}/files/${fileId}/rerun-inference`,
      { method: 'POST' },
    ),
  /** Read the canonical RhudDocument the parser captured for a file —
   *  the structured representation BEFORE any LLM step ran. Used by the
   *  "Parsed structure" admin panel to debug parsing-quality issues
   *  separately from extraction-quality issues. Returns `document: null`
   *  when the file has no Document representation (legacy row, plain
   *  text, or LLM-fallback xlsx path). */
  parsedDocument: (engagementId: string, fileId: string) =>
    request<{ filename: string; document: ParsedDocument | null }>(
      `/opportunities/${engagementId}/files/${fileId}/parsed-document`,
    ),
  /** Override an inferred entity's pricing inputs (scope value,
   *  methodology, customer type). Slug is the rate-card service-line
   *  slug. Triggers a quote re-compute on the server. */
  overrideEntity: (
    engagementId: string,
    fileId: string,
    slug: string,
    patch: {
      scopeValue?: number;
      methodology?: string | null;
      customerType?: 'internal' | 'external';
    },
  ) =>
    request<{ status: 'updated' }>(
      `/opportunities/${engagementId}/files/${fileId}/inferred-entities/${encodeURIComponent(slug)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),
};

// ── Site enumeration (crawl prospect site → categorised scope → quote) ──────

export type SiteEnumerationStatus =
  | 'pending'
  | 'crawling'
  | 'classifying'
  | 'ready'
  | 'failed'
  | 'retry_queued';

export type SiteUrlCategory =
  | 'product'
  | 'ecommerce'
  | 'blog'
  | 'cms'
  | 'form'
  | 'knowledge_base'
  | 'attachment'
  | 'members'
  | 'media'
  | 'module'
  | 'api'
  | 'integration'
  | 'other';

export interface SiteEnumerationCategorySummary {
  category: SiteUrlCategory;
  count: number;
  examples: Array<{ url: string; title: string | null }>;
}

export interface SiteEnumerationOptions {
  maxPages?: number;
  maxDepth?: number;
  includePathRegex?: string;
  excludePathRegex?: string;
  /** Render every page in headless Chromium before extracting links.
   *  Required for JavaScript SPAs whose link graph isn't in the static
   *  HTML. Slower; tighter budget caps apply. */
  useJsRendering?: boolean;
}

export interface ScopedEntity {
  entityId: string;
  serviceLineSlug: string;
  dimensions: {
    pages?: number;
    screens?: number;
    apis?: number;
    loc?: number;
    devices?: number;
    hours?: number;
    other?: number;
  };
  methodology: string | null;
  customerType: 'internal' | 'external';
}

export interface SiteEnumerationMappedSnapshot {
  rateCardId: string;
  rateCardVersion: number;
  computedAt: string;
  entities: ScopedEntity[];
}

export interface SiteEnumerationStateView {
  id: string;
  engagementId: string;
  siteUrl: string;
  status: SiteEnumerationStatus;
  totalUrls: number;
  classifiedUrls: number;
  startedAt: string | null;
  completedAt: string | null;
  retryAt: string | null;
  attempts: number;
  error: string | null;
  categories: SiteEnumerationCategorySummary[];
  mappedRateCards: SiteEnumerationMappedSnapshot[];
  options: SiteEnumerationOptions | null;
  /** Set when the root looked like a JS SPA (no static anchors).
   *  Coverage is inherently incomplete in that case. */
  looksLikeSpa: boolean;
  /** Set when every probe path returned the same body as the root —
   *  textbook SPA catch-all. There's exactly one distinct page at the
   *  static layer; price as a single SPA-rewrite. */
  spaCatchAll: boolean;
  /** Distinct same-origin JS bundles loaded during the crawl. */
  jsBundleCount: number;
  /** Distinct same-origin CSS files loaded during the crawl. */
  cssFileCount: number;
  /** Sum of input/select/textarea elements across rendered pages —
   *  each is a potential VAPT injection point. */
  totalFormFields: number;
  techFingerprint: { platform: string; signals: string[]; generator?: string } | null;
  manifest: { name?: string; startUrl?: string; scope?: string; shortcuts: string[] } | null;
  specsFound: string[];
  serviceWorkersFound: string[];
}

/** BasePriceResult shape returned by the quote endpoint. Mirrors the
 *  server's `@rhud/shared` BasePriceResult. */
export interface SiteEnumQuoteResult {
  rateCardId: string;
  entities: ScopedEntity[];
  quote: {
    rateCardId: string;
    rateCardVersion: number;
    currency: string;
    lines: BasePriceLine[];
    totalCents: number;
    hasManualQuoteRequired: boolean;
    hasUnmatched: boolean;
  };
}

export interface DiscoveredPageRow {
  url: string;
  category: string | null;
  title: string | null;
  description: string | null;
  httpStatus: number | null;
  contentType: string | null;
  classifierSource: string | null;
  classifierConfidence: number | null;
  fetchedAt: string;
}

export const siteEnumeration = {
  get: (engagementId: string) =>
    request<SiteEnumerationStateView | null>(
      `/opportunities/${engagementId}/site-enumeration`,
    ),
  kickoff: (
    engagementId: string,
    body: { siteUrl: string; options?: SiteEnumerationOptions },
  ) =>
    request<{ enumerationId: string; status: SiteEnumerationStatus }>(
      `/opportunities/${engagementId}/site-enumeration`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  map: (engagementId: string, rateCardId: string) =>
    request<{ entities: ScopedEntity[] }>(
      `/opportunities/${engagementId}/site-enumeration/map`,
      { method: 'POST', body: JSON.stringify({ rateCardId }) },
    ),
  quote: (engagementId: string) =>
    request<SiteEnumQuoteResult>(
      `/opportunities/${engagementId}/site-enumeration/quote`,
      { method: 'POST' },
    ),
  retry: (enumerationId: string) =>
    request<{ enumerationId: string; status: SiteEnumerationStatus }>(
      `/site-enumerations/${enumerationId}/retry`,
      { method: 'POST' },
    ),
  /** Full list of every discovered page (URL, category, classifier
   *  confidence, etc.). Backs the "view all" modal. */
  listPages: (engagementId: string) =>
    request<DiscoveredPageRow[]>(
      `/opportunities/${engagementId}/site-enumeration/pages`,
    ),
  /** CSV download URL — used by the download button to trigger a
   *  browser-native save. The bearer token is appended via
   *  fetchCsvBlob below since the browser's `<a download>` can't
   *  attach Authorization headers. */
  csvUrl: (engagementId: string) =>
    `${BASE}/api/v1/opportunities/${engagementId}/site-enumeration/pages.csv`,
  /** Fetch the CSV body so the caller can wrap it in a Blob and
   *  trigger a download via createObjectURL. */
  fetchCsv: async (engagementId: string): Promise<string> => {
    const t = token();
    const res = await fetch(
      `${BASE}/api/v1/opportunities/${engagementId}/site-enumeration/pages.csv`,
      { headers: t ? { authorization: `Bearer ${t}` } : {} },
    );
    if (!res.ok) throw new ApiError(res.status, null, `${res.status} csv export`);
    return res.text();
  },
};

export const integrations = {
  outlook: {
    status: () => request<OutlookConnectionStatus>(`/integrations/outlook/status`),
    /** Fetch the Microsoft authorize URL, then navigate the browser
     *  to it. We can't redirect from a JWT-guarded endpoint because
     *  the bearer header doesn't survive `window.location.href`. */
    authorizeUrl: () =>
      request<{ url: string }>(`/integrations/outlook/authorize-url`),
    disconnect: () =>
      request<void>(`/integrations/outlook/disconnect`, { method: 'POST' }),

    // Admin-only — Microsoft Entra app credentials.
    getAppConfig: () =>
      request<OutlookAppConfig>(`/integrations/outlook/app-config`),
    saveAppConfig: (args: { clientId: string; clientSecret: string }) =>
      request<OutlookAppConfig>(`/integrations/outlook/app-config`, {
        method: 'POST',
        body: JSON.stringify(args),
      }),
    clearAppConfig: () =>
      request<void>(`/integrations/outlook/app-config`, { method: 'DELETE' }),
  },
};

export const justification = {
  generate: (engagementId: string) =>
    request<JustificationResult>(`/opportunities/${engagementId}/justification`, {
      method: 'POST',
    }),
  acceptManual: (engagementId: string, text: string) =>
    request<{ text: string }>(`/opportunities/${engagementId}/justification/manual`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
};

export interface LlmConfig {
  provider: LlmProviderName;
  model: string;
  baseUrl: string | null;
  apiKeySet: boolean;
  enabled: boolean;
  monthlyTokenBudget: number;
  updatedAt: string;
}

export interface UpsertLlmConfig {
  provider: LlmProviderName;
  model: string;
  baseUrl?: string | null;
  /** undefined = leave existing key in place; '' or null = clear it. */
  apiKey?: string | null;
  enabled?: boolean;
  monthlyTokenBudget?: number;
}

export const llm = {
  get: () => request<LlmConfig | null>('/tenant/llm-config'),
  upsert: (dto: UpsertLlmConfig) =>
    request<LlmConfig>('/tenant/llm-config', { method: 'PUT', body: JSON.stringify(dto) }),
  remove: () => request<void>('/tenant/llm-config', { method: 'DELETE' }),
  test: () =>
    request<{ ok: boolean; error?: string; sample?: string }>('/tenant/llm-config/test', {
      method: 'POST',
    }),
};

// Public — no JWT. The token IS the auth.
export const invitesPublic = {
  preview: (token: string) =>
    request<{ email: string; role: Role; tenantName: string } | null>(
      `/invites/${encodeURIComponent(token)}/preview`,
    ),
  accept: (token: string, password: string) =>
    request<{ token: string; user: { sub: string; tid: string; role: Role; email: string } }>(
      '/invites/accept',
      { method: 'POST', body: JSON.stringify({ token, password }) },
    ),
};

// ────────────────────────────────────────────────────────────────────────────

export const pricingConfig = {
  get: () => request<TenantPricingConfig>('/tenant/pricing-config'),
  patch: (body: Partial<Omit<TenantPricingConfig, 'tenantId' | 'updatedAt'>>) =>
    request<TenantPricingConfig>('/tenant/pricing-config', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
};

// ── ML (admin-only) ─────────────────────────────────────────────────────────

export interface MlModelMeta {
  sequence: number;
  trainedAt: string;
  nTrain: number;
  mae: number | null;
  rmse: number | null;
  active: boolean;
}

export interface MlStatusResponse {
  ok: boolean;
  reason?: string;
  activeSequence?: number | null;
  activeMeta?: MlModelMeta | null;
  history?: MlModelMeta[];
}

export interface MlTrainRecord {
  scopeFields: Record<string, unknown>;
  finalPrice: number; // dollars
  /** Stage-2 deterministic base at the time the deal closed (dollars). */
  basePrice?: number;
  serviceLine?: string;
  closedAt?: string;
  wonLost?: boolean;
}

export interface MlTrainResponse {
  ok: boolean;
  reason?: string;
  sequence?: number;
  nTrain?: number;
  active?: boolean;
  coldStart?: boolean;
  maeCents?: number | null;
  rmseCents?: number | null;
  medianPriceCents?: number;
}

export const ml = {
  status: () => request<MlStatusResponse>('/ml/status'),
  train: (records: MlTrainRecord[]) =>
    request<MlTrainResponse>('/ml/train', {
      method: 'POST',
      body: JSON.stringify({ records }),
    }),
};

// ── Gathering (client-facing, token in URL — no JWT) ────────────────────────
// These calls intentionally bypass our JWT-aware `request()` wrapper. The
// token IS the auth; we hit the unprefixed /g/:token namespace directly.

const PUBLIC_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

async function gFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const res = await fetch(`${PUBLIC_BASE}/g/${encodeURIComponent(token)}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    let body: unknown = null;
    try { body = await res.json(); } catch { body = await res.text(); }
    throw new ApiError(res.status, body, `${res.status} /g/...${path}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface GatheringLoopContext {
  loopId: string;
  label: string;
  iter: number;
}
export interface GatheringLoopStep {
  loopId: string;
  label: string;
  iter: number;
}

export interface GatheringStateResponse {
  engagementId: string;
  templateName: string;
  status: string;
  /** Full template node list — used to build the outline sidebar and
   *  for back / jump-to navigation. Optional for backwards compat. */
  templateNodes?: TemplateNode[];
  templateRootNodeId?: string | null;
  currentNode: TemplateNode | null;
  loopContext: GatheringLoopContext | null;
  loopStep: GatheringLoopStep | null;
  answers: Record<string, unknown>;
  loopAnswers: Record<string, Array<Record<string, unknown>>>;
  files: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>>;
  /** Pre-populated values from cached document extraction. Surfaced as
   *  placeholders / initial values for unanswered nodes so the rep or
   *  client can confirm/edit instead of re-typing. Optional for
   *  backwards compatibility — older API builds don't return it. */
  suggestedAnswers?: Record<string, unknown>;
  /** Per-suggestion confidence in [0..1] — keys mirror suggestedAnswers.
   *  Used by the gathering UI to render a "Strong / Approximate / Borderline"
   *  chip so the responder treats borderline inferences with care. */
  suggestionConfidence?: Record<string, number>;
  /** Extraction status counts. The Quick-fill kickoff flow polls /state
   *  while files are still being parsed and shows progress ("Parsing
   *  your scoping sheet…") until everything settles. */
  extraction?: {
    totalFiles: number;
    readyFiles: number;
    inFlightFiles: number;
    failedFiles: number;
  };
  /**
   * Plain-English summary of what the LLM mapper read from uploaded
   * documents. Rendered in the Review modal ABOVE the form questions
   * so the client sees "we read 1 web app + 1 API + 2 roles" instead
   * of a confusingly half-empty form. Empty when no entities cleared
   * the priced threshold (≥0.6) — UI falls back to a "we couldn't
   * read your document" message.
   *
   * Optional for backwards compat — older API builds don't return it.
   */
  scopeSummary?: {
    groups: Array<{
      label: string;
      domain: 'web_app' | 'api' | 'mobile_ios' | 'mobile_android' | 'network' | 'cloud' | 'other';
      items: Array<{
        title: string;
        subtitle?: string;
        bullets: string[];
        confidence: number;
        sourceFiles: string[];
      }>;
    }>;
    totalItems: number;
    isEmpty: boolean;
  };
  /** Inferred entities that the engagement's template can't auto-fill
   *  because no node binds to their slug. The Review modal lists them
   *  so the rep / client knows what was understood but isn't in the
   *  form (still priced server-side, but invisible without this). */
  unprojectedEntities?: Array<{
    serviceLineSlug: string;
    displayName: string;
    scopeValue: number;
    confidence: number;
  }>;
}

export type GatheringNext =
  | { kind: 'node'; node: TemplateNode; loopContext: GatheringLoopContext | null }
  | { kind: 'loop_step'; loopId: string; label: string; iter: number }
  | { kind: 'end' };

export const gathering = {
  state: (token: string) => gFetch<GatheringStateResponse>(token, '/state'),
  answer: (token: string, dto: { nodeId: string; answer: unknown }) =>
    gFetch<{ next: GatheringNext }>(
      token,
      '/answers',
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  loopStep: (token: string, dto: { loopId: string; action: 'continue' | 'done' }) =>
    gFetch<{ next: GatheringNext }>(
      token,
      '/loop-step',
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  uploadUrl: (token: string, dto: { nodeId: string; filename: string; contentType: string; sizeBytes: number }) =>
    gFetch<{ uploadUrl: string; fileId: string; key: string; expiresAt: string }>(
      token,
      '/files',
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  /** Quick-fill scoping doc upload — engagement-level, no nodeId. The
   *  uploaded file lands with `kind='scoping_doc'` and doesn't appear
   *  in any per-question files list. Extraction kicks off automatically. */
  scopingDocUploadUrl: (token: string, dto: { filename: string; contentType: string; sizeBytes: number }) =>
    gFetch<{ uploadUrl: string; fileId: string; key: string; expiresAt: string }>(
      token,
      '/scoping-doc',
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  /** Remove a loop iteration — deletes all body answers at iter N and
   *  shifts subsequent iterations down. Used by the sidebar's per-
   *  iteration trash icon. */
  removeIteration: (token: string, dto: { loopId: string; iterIndex: number }) =>
    gFetch<{ ok: true }>(token, '/iterations/remove', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  submit: (token: string) =>
    gFetch<{ status: string }>(token, '/submit', { method: 'POST' }),
};
