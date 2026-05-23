/**
 * Phase E — shared types for inbound ingestion (PM workflow stage 1).
 *
 * Both ingestion paths — Postmark email webhook and the public
 * `/partner-intake/:token` POST — produce the same shape and feed
 * `IntakeService.createFromInboundPayload()` on the API side. Keeping
 * the contract here means controllers, tests, and any future inbound
 * channel (WhatsApp, voice) all agree on the field names.
 */

/** A single attachment, already base64-decoded by the controller. */
export interface InboundAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Normalised payload both inbound controllers hand to IntakeService. */
export interface InboundIntakePayload {
  /** Which channel produced this payload — drives provenance + audit. */
  source: 'inbound_email' | 'partner_api';
  /** Required. From: header for email; explicit field for partner. */
  clientEmail: string;
  /** Email subject, or a name/label supplied by the partner. */
  subject?: string | null;
  /** Email TextBody (preferred) or HtmlBody, or partner's free-text brief.
   *  When present and no attachments are sent, the body is written to a
   *  synthetic `email-body.txt` / `partner-brief.txt` and run through the
   *  same extraction pipeline as PDFs. */
  bodyText?: string | null;
  /** Phase C client metadata, optional per channel.
   *  Email channel may leave these null and let the rep fill them later. */
  clientName?: string | null;
  clientAddress?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  /** All decoded files; capped at 10 entries / 50 MB total upstream. */
  attachments: InboundAttachment[];
  /** Per-source provenance. Mutually exclusive — exactly one is set. */
  postmarkMessageId?: string;
  partnerTokenId?: string;
  partnerName?: string;
  /** Source IP truncated to /24 (IPv4) or /48 (IPv6) — full IPs would
   *  be PII when persisted into the thread event payload. */
  sourceIp?: string;
}

/** Returned from IntakeService.createFromInboundPayload(). */
export interface IntakeResult {
  engagementId: string;
  /** Always null today — neither inbound channel issues a gathering
   *  link (the inbound payload IS the scoping data, so no client-side
   *  gathering walk is needed). Reserved for future "send the client a
   *  link to fill in missing fields" flows. */
  gatheringLink: null;
}
