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

/** Server preview response — POST /opportunities/preview-from-email. */
export interface PreviewResponse {
  parsedSender: { email: string; name?: string } | null;
  isForwarded: boolean;
  structuredFields: Array<{ label: string; value: string }>;
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
