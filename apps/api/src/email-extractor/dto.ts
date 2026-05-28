import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * POST /opportunities/preview-from-email body.
 *
 * The Outlook add-in calls this on pane open, before "Create", so it can
 * show the rep the real client + scope fields. The server runs an LLM
 * extraction (falling back to the regex heuristic when no model is
 * configured). Read-only — no DB writes beyond the per-(tenant,messageId)
 * result cache.
 */
export class PreviewFromEmailDto {
  /** Apparent From address (often the internal forwarder; the extractor
   *  resolves the real external client). */
  @IsEmail()
  fromEmail!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fromName?: string;

  @IsString()
  @MaxLength(500)
  subject!: string;

  /** Plain-text body — what the LLM reads. */
  @IsString()
  @MaxLength(20000)
  bodyText!: string;

  /** HTML body — only used by the heuristic fallback's table parser.
   *  Generous cap; runaway HTML is still rejected at the Express limit. */
  @IsOptional()
  @IsString()
  @MaxLength(200_000)
  bodyHtml?: string;

  /** RFC822 Message-Id — the cache key. Optional: without it the preview
   *  still works, it just recomputes (no read-through / write). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  messageId?: string;
}
