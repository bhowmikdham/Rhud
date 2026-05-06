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

export const opportunities = {
  list: () => request<EngagementSummary[]>('/opportunities'),
  get: (id: string) =>
    request<EngagementSummary & { thread: ThreadEventRow[] }>(`/opportunities/${id}`),
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

export type LlmProviderName = 'anthropic' | 'openai' | 'ollama' | 'openai_compat' | 'manual';

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
  currentNode: TemplateNode | null;
  loopContext: GatheringLoopContext | null;
  loopStep: GatheringLoopStep | null;
  answers: Record<string, unknown>;
  loopAnswers: Record<string, Array<Record<string, unknown>>>;
  files: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>>;
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
  submit: (token: string) =>
    gFetch<{ status: string }>(token, '/submit', { method: 'POST' }),
};
