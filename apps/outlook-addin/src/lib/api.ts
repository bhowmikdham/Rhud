// Rhud backend client. All calls are cross-origin to rhud.net; the API
// allowlists addin.rhud.net via CORS. A 401 means the JWT expired — callers
// clear the cache and reprompt.

import type {
  CreateResponse,
  IssuedLinkResponse,
  MessageContext,
  PreviewResponse,
  TemplateOption,
} from './types';

const RHUD_API = import.meta.env.VITE_RHUD_API ?? 'https://rhud.net';
/** Used only for the post-create "Open in Rhud" deep link. */
export const RHUD_WEB = import.meta.env.VITE_RHUD_WEB ?? 'https://rhud.net';

export class AuthExpiredError extends Error {
  constructor() {
    super('session_expired');
    this.name = 'AuthExpiredError';
  }
}

async function call<T>(path: string, jwt: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${RHUD_API}/api/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401) throw new AuthExpiredError();
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body.slice(0, 200)}`);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

/** Stateless preview — resolves the forwarded sender + extracts table fields. */
export function preview(jwt: string, msg: MessageContext): Promise<PreviewResponse> {
  return call<PreviewResponse>('/opportunities/preview-from-email', jwt, {
    method: 'POST',
    body: JSON.stringify({
      fromEmail: msg.fromEmail,
      fromName: msg.fromName || undefined,
      subject: msg.subject,
      bodyText: msg.bodyText,
      // Cap HTML well under the server's 200K DTO limit.
      bodyHtml: msg.bodyHtml.slice(0, 180_000),
    }),
  });
}

/** Create the opportunity via the direct-ingest pipeline (no template). */
export function createOpportunity(
  jwt: string,
  args: { msg: MessageContext; fromEmail: string; fromName?: string; clientNameOverride?: string },
): Promise<CreateResponse> {
  return call<CreateResponse>('/opportunities/from-email-ingest', jwt, {
    method: 'POST',
    body: JSON.stringify({
      fromEmail: args.fromEmail,
      fromName: args.fromName || undefined,
      clientNameOverride: args.clientNameOverride || undefined,
      subject: args.msg.subject,
      bodyText: args.msg.bodyText,
      messageId: args.msg.messageId,
      source: 'outlook',
    }),
  });
}

/** Published templates for the optional follow-up link. */
export async function loadTemplates(jwt: string): Promise<TemplateOption[]> {
  const all = await call<TemplateOption[]>('/templates', jwt, {});
  return all.filter((t) => t.status === 'published');
}

/** Mint a gathering link against the freshly-created opportunity. */
export function issueLink(jwt: string, engagementId: string, templateId: string): Promise<IssuedLinkResponse> {
  return call<IssuedLinkResponse>(`/opportunities/${engagementId}/links`, jwt, {
    method: 'POST',
    body: JSON.stringify({ templateId }),
  });
}
