/**
 * Tiny typed fetch wrapper for the Rhud API.
 *
 * Lives entirely on the client (uses localStorage). Once we add SSR for
 * authenticated views, this becomes a thin facade over a server-side fetch
 * that reads cookies — but for sprint 2 the admin UI is client-rendered.
 */
import type {
  Template,
  TemplateWithNodes,
  TemplateNode,
  NextRule,
  NodeOption,
  NodeType,
  TemplateStatus,
} from '@rhud/shared';

export type { NextRule, NodeOption, NodeType, Template, TemplateNode, TemplateWithNodes };

export type CreateTemplate = { serviceLine: string; name: string };
export type UpdateTemplate = Partial<{
  serviceLine: string;
  name: string;
  rootNodeId: string;
  status: TemplateStatus;
}>;
export type CreateNode = {
  question: string;
  nodeType: NodeType;
  options?: NodeOption[];
  allowFiles?: boolean;
  nextRules?: NextRule[];
  position?: number;
};
export type UpdateNode = Partial<CreateNode>;

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

  validate: (id: string) =>
    request<{ issues: Array<{ code: string; message: string; nodeId?: string }> }>(
      `/templates/${id}/validate`,
      { method: 'POST' },
    ),
};

// ── Engagements (sales-facing) ──────────────────────────────────────────────

export interface EngagementSummary {
  id: string;
  templateId: string;
  templateName: string;
  clientEmail: string;
  status: string;
  createdAt: string;
  submittedAt: string | null;
}

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

export const engagements = {
  list: () => request<EngagementSummary[]>('/engagements'),
  get: (id: string) =>
    request<EngagementSummary & { thread: ThreadEventRow[] }>(`/engagements/${id}`),
  issue: (dto: { templateId: string; clientEmail: string; expiresInDays?: number }) =>
    request<IssuedLink>('/engagements', { method: 'POST', body: JSON.stringify(dto) }),
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

export interface GatheringStateResponse {
  engagementId: string;
  templateName: string;
  status: string;
  currentNode: TemplateNode | null;
  answers: Record<string, unknown>;
  files: Record<string, Array<{ id: string; filename: string; sizeBytes: number }>>;
}

export const gathering = {
  state: (token: string) => gFetch<GatheringStateResponse>(token, '/state'),
  answer: (token: string, dto: { nodeId: string; answer: unknown }) =>
    gFetch<{ next: { kind: 'node'; node: TemplateNode } | { kind: 'end' } }>(
      token,
      '/answers',
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
