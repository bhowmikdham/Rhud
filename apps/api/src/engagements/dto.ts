import { IsEmail, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

// UUID-shape match. `@IsUUID()` requires version 1-5; some of our seed
// fixtures use version 0 ("nil-ish") UUIDs for stable references, so we
// permit any properly-formatted UUID here. Real production IDs from
// gen_random_uuid() are v4 and pass either way.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class CreateEngagementDto {
  @Matches(UUID_RE, { message: 'templateId must be UUID-formatted' })
  templateId!: string;

  @IsEmail()
  clientEmail!: string;

  /** Free-text label ("Acme Q3 Security Assessment"). Optional but recommended. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** Days until the link expires. Default: 7 (per design doc §3.1). */
  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInDays?: number;

  @IsOptional()
  @Matches(UUID_RE, { message: 'salesManagerId must be UUID-formatted' })
  salesManagerId?: string;

  // ── Phase C — client metadata captured at issuance ────────────
  @IsOptional() @IsString() @MaxLength(200) clientName?: string;
  @IsOptional() @IsString() @MaxLength(1000) clientAddress?: string;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string;
  @IsOptional() @IsString() @MaxLength(50)  contactPhone?: string;
}

/** PATCH body for /opportunities/:id/client. All fields optional;
 *  passing null/empty clears the stored value. */
export class UpdateClientInfoDto {
  @IsOptional() @IsString() @MaxLength(200) clientName?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) clientAddress?: string | null;
  @IsOptional() @IsString() @MaxLength(200) contactName?: string | null;
  @IsOptional() @IsString() @MaxLength(50)  contactPhone?: string | null;
}

/**
 * POST /opportunities/from-email body.
 *
 * Used by the Outlook add-in (and future Gmail add-on) — the client-side
 * task pane has already pulled the selected message's fields out of
 * Office.js, so the API just needs structured input rather than a raw
 * RFC822 blob. We deliberately don't accept the full MIME — keeping the
 * surface narrow means we don't have to maintain a MIME parser server-side.
 *
 * Idempotency: `messageId` is the email's RFC822 Message-Id. The service
 * dedupes on (tenantId, messageId) so clicking the add-in's button twice
 * doesn't create two opportunities.
 */
export class CreateOpportunityFromEmailDto {
  @Matches(UUID_RE, { message: 'templateId must be UUID-formatted' })
  templateId!: string;

  /** From: header — used as the opportunity's clientEmail. */
  @IsEmail()
  fromEmail!: string;

  @IsString()
  @MaxLength(500)
  subject!: string;

  /** Plain-text body. Capped at 20K — large enough for any real proposal
   *  brief, small enough that a runaway email can't blow request limits. */
  @IsString()
  @MaxLength(20000)
  bodyText!: string;

  /** RFC822 Message-Id. Required because we dedupe on it. */
  @IsString()
  @MaxLength(500)
  messageId!: string;

  /** From: display name ("Acme Procurement <buyer@acme.com>"). Optional
   *  because some clients only have the address. Used as contactName. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  fromName?: string;

  /** Salesperson can override the auto-derived client name in the task
   *  pane before submitting (e.g. "Acme Procurement" → "Acme Corp"). */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientNameOverride?: string;

  /** Which add-in / channel this came from. Recorded in the thread event
   *  payload for audit; doesn't affect any business logic today. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  source?: 'outlook' | 'gmail' | 'manual_paste';
}
