// Direct-ingest pipeline types — see docs/direct-ingest.md.
//
// Every engagement carries a `source` indicating how it entered Rhud.
// `manual_form` is the existing link-share path; everything else is a
// direct-ingest variant (artifact landed → engagement created without
// a gathering token).

export const ENGAGEMENT_SOURCES = [
  /// Existing default — link-share wizard. Backfilled onto all
  /// pre-direct-ingest rows by the migration.
  'manual_form',
  /// Rep dropped a file in the "I have it" UI mode.
  'direct_upload',
  /// Rep pasted email body / WhatsApp transcript / call notes.
  'paste_text',
  /// Voice / audio note → STT → text. Sprint 2.
  'voice_note',
  /// Email arrived via inbound webhook (SES, Postmark) or the future
  /// Outlook extension's "Export to Rhud" action.
  'email_import',
  /// WhatsApp Cloud API webhook delivered an inbound message.
  'whatsapp_import',
  /// Direct-upload file the document-type classifier identified as
  /// a tender / RFP. Sprint 2 sets this automatically.
  'rfp_import',
  /// Direct-upload file the document-type classifier identified as
  /// an SOW. Sprint 2 sets this automatically.
  'sow_import',
  /// Existing Odoo sync path — replaces the deprecated boolean
  /// `engagements.importedFromOdoo`. New code reads this enum.
  'odoo_import',
  /// Catch-all for programmatic ingestion (CLI, integration test
  /// harness, third-party automation). Not user-facing.
  'api',
] as const;

export type EngagementSource = (typeof ENGAGEMENT_SOURCES)[number];

/// Shape of the raw input that produced an engagement. One engagement
/// may have multiple artifacts (e.g., an email body + N attachments).
export const ARTIFACT_KINDS = [
  /// rawText only. Paste-text, transcripts, body of an inbound email.
  'text',
  /// s3Key + contentType. PDF, DOCX, XLSX, etc.
  'file',
  /// s3Key + contentType, with rawText populated post-STT.
  'audio',
  /// Email metadata block + rawText body. Attachments live as separate
  /// `file` artifacts that point back to the email artifact's id.
  'email',
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/// Lifecycle of an IngestionArtifact row. Artifacts arrive from
/// webhooks before any engagement exists, so the lifecycle is decoupled
/// from `engagements.status`.
export const INGESTION_STATUSES = [
  /// Landed in the DB; not yet processed.
  'received',
  /// Extraction running.
  'processing',
  /// engagementId set; the engagement has taken ownership of the
  /// artifact's content. Terminal in the happy path.
  'promoted',
  /// Extraction or promotion errored. `failureReason` populated.
  'failed',
] as const;

export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

/// Display labels for the source chip on the opportunities list /
/// detail pages. Web app imports this map directly.
export const ENGAGEMENT_SOURCE_LABELS: Record<EngagementSource, string> = {
  manual_form: 'Link',
  direct_upload: 'Upload',
  paste_text: 'Notes',
  voice_note: 'Voice',
  email_import: 'Email',
  whatsapp_import: 'WhatsApp',
  rfp_import: 'RFP',
  sow_import: 'SOW',
  odoo_import: 'Odoo',
  api: 'API',
};
