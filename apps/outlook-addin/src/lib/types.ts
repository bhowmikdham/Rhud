// Shared types for the Rhud Outlook task pane.

/** A cached Rhud session — JWT + the user claims we keep for display. */
export interface CachedAuth {
  token: string;
  user: { sub: string; tid: string; role: string; email: string };
}

/** What we read off the open Outlook message (via Office.js). */
export interface MessageContext {
  subject: string;
  fromEmail: string;
  fromName: string;
  bodyText: string;
  bodyHtml: string;
  /** RFC822 Message-Id — used server-side for idempotency. */
  messageId: string;
  /** Human-readable received date, best-effort. */
  dateLabel: string;
}

/** The client the server extracted from the email (LLM, or heuristic
 *  fallback). Any field may be null when not present / not found. */
export interface ExtractedClient {
  company: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  website: string | null;
}

/** An external intermediary (channel partner / distributor) that forwarded
 *  the RFP on behalf of the end client. Null for direct deals. */
export interface ExtractedPartner {
  company: string | null;
  contactName: string | null;
  email: string | null;
}

/** Partner role on the deal — matches the engagements partner_role CHECK. */
export type PartnerRole = 'partner' | 'distributor';

/** Server preview response — POST /opportunities/preview-from-email. */
export interface PreviewResponse {
  client: ExtractedClient;
  partner: ExtractedPartner | null;
  isForwarded: boolean;
  /** The internal forwarder's address, when the real client was traced
   *  through a forward. Surfaced as a "forwarded by …" note. */
  forwardedFrom: string | null;
  structuredFields: Array<{ label: string; value: string }>;
  /** 'llm' when a model produced this, 'heuristic' on regex fallback. */
  source: 'llm' | 'heuristic';
}

/** A template option for the optional follow-up scoping link. */
export interface TemplateOption {
  id: string;
  name: string;
  status: 'draft' | 'published' | 'archived';
}

/** Result of creating the opportunity — POST /opportunities/from-email-ingest. */
export interface CreateResponse {
  engagementId: string;
  artifactIds: string[];
}

/** Result of minting a gathering link — POST /opportunities/:id/links. */
export interface IssuedLinkResponse {
  engagementId: string;
  token: string;
  url: string;
  expiresAt: string;
}

/**
 * A field shown in the Review step.
 *
 * The backend extracts flat `{label, value}` pairs from the email's HTML
 * tables (no semantic confidence / grouping yet — that's future AI work,
 * per product direction). We derive a lightweight status client-side:
 *   - 'detected'  — extraction found a non-empty value
 *   - 'missing'   — extraction found the row but the value cell was blank
 *   - 'edited'    — the rep typed/changed the value (treated as resolved)
 *   - 'na'        — the rep marked it Not Applicable
 */
export type FieldStatus = 'detected' | 'missing' | 'edited' | 'na';

export interface ReviewField {
  id: number;
  label: string;
  value: string;
  status: FieldStatus;
}

/** Which path the rep chose on the Confirm step. */
export type CreateAction = 'opportunity-only' | 'with-link';
