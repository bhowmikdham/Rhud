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
}
