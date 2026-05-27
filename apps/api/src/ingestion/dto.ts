import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  Matches,
} from 'class-validator';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * POST /ingest/text — direct-ingest from a pasted text body.
 *
 * The body lands as an `IngestionArtifact` (kind=text, source=paste_text)
 * AND is promoted to an Engagement in one atomic call. The rep is in
 * the UI; they want an opportunity now.
 *
 * Client metadata fields mirror the `New opportunity` link-share form
 * so the UI can share the same component below the artifact area.
 */
export class IngestTextDto {
  /// Required — the body the rep pasted. Cap at 256KB; longer paste
  /// is almost always a sign the rep should drop a file instead.
  @IsString()
  @MaxLength(256 * 1024)
  rawText!: string;

  /// Required — client email is the canonical engagement identifier.
  /// The form prefilled this from LLM extraction when possible; rep
  /// confirms before submit.
  @IsEmail()
  clientEmail!: string;

  /// Optional engagement label ("Northwind Q3 VAPT").
  @IsOptional() @IsString() @MaxLength(200) name?: string;

  // ── Phase C — client metadata, mirrors CreateEngagementDto. ────────
  @IsOptional() @IsString() @MaxLength(200) clientName?: string;
  @IsOptional() @IsString() @MaxLength(1000) clientAddress?: string;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @IsOptional() @IsString() @MaxLength(50)  contactPhone?: string;
}

/**
 * POST /ingest/file/presign — step 1 of two-step file ingestion.
 *
 * Server creates the IngestionArtifact row (status='received', s3Key
 * pre-set) and returns a presigned PUT URL the client uploads to.
 * Once the upload finishes, the client calls POST /opportunities/from-ingest
 * with the returned artifactId to promote the artifact into an
 * engagement.
 *
 * Cap at 50MB (matches the existing gathering flow). For larger files
 * the rep can split or compress upstream.
 */
export class IngestFilePresignDto {
  @IsString()
  @MaxLength(255)
  filename!: string;

  @IsString()
  @MaxLength(200)
  contentType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

/**
 * POST /opportunities/from-ingest — promote existing artifact(s) into
 * a fresh engagement. Lives on the EngagementsController (mounted at
 * /opportunities) because the resource produced is an engagement, but
 * the DTO sits here next to its sibling shapes.
 */
export class PromoteIngestDto {
  @IsArray()
  @Matches(UUID_RE, { each: true, message: 'each artifact id must be UUID-formatted' })
  artifactIds!: string[];

  /// Rep-confirmed client email. When the artifact already carries a
  /// `from` (email artifacts), the UI prefills this with that value
  /// but the rep can override. Required so we never create an
  /// orphaned engagement without a canonical identifier.
  @IsEmail()
  clientEmail!: string;

  @IsOptional() @IsString() @MaxLength(200) name?: string;

  // Client metadata — same fields the link-share wizard captures.
  @IsOptional() @IsString() @MaxLength(200)  clientName?: string;
  @IsOptional() @IsString() @MaxLength(1000) clientAddress?: string;
  @IsOptional() @IsString() @MaxLength(200)  contactName?: string;
  @IsOptional() @IsString() @MaxLength(50)   contactPhone?: string;
}

/**
 * POST /opportunities/:id/links — mint a gathering link against an
 * existing engagement. Replaces the old inline mint-on-create logic
 * so direct-ingest opportunities can issue links after the fact
 * (and link-share opportunities can re-scope). See
 * docs/direct-ingest.md §4.2.
 */
export class IssueLinkForExistingDto {
  @Matches(UUID_RE, { message: 'templateId must be UUID-formatted' })
  templateId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInDays?: number;

  /// Optional rep note — surfaced in the link_reissued event payload
  /// ("client asked for more detail on access scope"). Audit / display
  /// only; not shown to the client.
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
