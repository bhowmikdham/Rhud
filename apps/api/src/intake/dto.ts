/**
 * Phase E — DTOs for the partner-token admin CRUD and the public
 * partner-intake POST. Class-validator decorators match the existing
 * style used across the API (see team/dto.ts, engagements/dto.ts).
 */

import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  Min,
} from 'class-validator';

export class CreatePartnerTokenDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /** Optional cutoff in days. Omit / null = no expiry. */
  @IsOptional()
  @IsInt()
  @Min(1)
  expiresInDays?: number;

  /** Per-token template override. Falls back to tenant default. */
  @IsOptional()
  @IsUUID()
  defaultTemplateId?: string;

  /** Per-token sales-owner override. Falls back to tenant default. */
  @IsOptional()
  @IsUUID()
  defaultSalesOwnerId?: string;
}

/**
 * Multipart form-data body for `POST /partner-intake/:token`. Files
 * arrive via FileFieldsInterceptor; this only declares the text fields.
 */
export class PartnerIntakeDto {
  @IsEmail()
  clientEmail!: string;

  /** Subject / label. Becomes the engagement.name. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  /** Free-text brief. When no files are uploaded, this is persisted as
   *  a synthetic `partner-brief.txt` and fed through the extraction
   *  pipeline so we get structured points either way. */
  @IsOptional()
  @IsString()
  @MaxLength(8000)
  bodyText?: string;

  /** Optional override of partner's default template. */
  @IsOptional()
  @IsUUID()
  templateId?: string;

  // Phase C client metadata, all optional.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  clientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  clientAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPhone?: string;
}
