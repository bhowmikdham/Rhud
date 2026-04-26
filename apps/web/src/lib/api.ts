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
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
    }
    throw new ApiError(res.status, body, `${res.status} ${path}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
  approvedPriceCents: number | null;
  approvedAt: string | null;
  approvedBy: string | null;
  computedAt: string;
}

export const rateCards = {
  list: () => request<RateCardSummary[]>('/rate-cards'),
  get: (id: string) => request<RateCardFull>(`/rate-cards/${id}`),
  publish: (id: string) =>
    request<RateCardFull>(`/rate-cards/${id}/publish`, { method: 'PATCH' }),
  seedSample: () =>
    request<RateCardFull>('/rate-cards/seed/csaas-sample', { method: 'POST' }),
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

export type ApprovalChoice = 'base' | 'recommended' | 'aggressive' | 'custom';

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
