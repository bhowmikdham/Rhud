import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IMAGE_CONTENT_TYPES } from '../storage/media.js';

export class LoginDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class RequestMagicLinkDto {
  @IsEmail()
  email!: string;
}

export class ConsumeMagicLinkDto {
  @IsString()
  token!: string;
}

/** Self-serve signup: creates a new tenant + admin user atomically. */
export class SignupDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(200)
  password!: string;

  /** Workspace/company name. Becomes the tenant's `name`. */
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  tenantName!: string;

  /** Optional human display name for the admin user. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  userName?: string;

  /** Optional industry-template slug for the tenant's starting taxonomy.
   *  Defaults to 'cybersecurity' for back-compat — existing signup
   *  callers (UI today) don't pass this and stay on the legacy seed.
   *  Validated server-side: must match a row in `industry_templates`. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  industryTemplateSlug?: string;
}

export class VerifyEmailDto {
  @IsString()
  token!: string;
}

export class RequestPasswordResetDto {
  @IsEmail()
  email!: string;
}

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8, { message: 'password must be at least 8 characters' })
  @MaxLength(200)
  newPassword!: string;
}

/** PATCH /auth/me — user updates their own profile. `name` and the profile
 *  photo (`avatarKey`); email is the unique sign-in identity (so changing it
 *  warrants its own flow), and role is administered through the Team panel. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /** S3 object key returned by POST /auth/avatar/presign (after the client
   *  PUTs the image). The service verifies it sits under the caller's own
   *  avatar prefix before persisting. Pass null to remove the photo. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(512)
  avatarKey?: string | null;
}

/** POST /auth/avatar/presign — request a signed PUT url for a profile photo. */
export class AvatarPresignDto {
  @IsString()
  @IsIn(IMAGE_CONTENT_TYPES as unknown as string[])
  contentType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}
