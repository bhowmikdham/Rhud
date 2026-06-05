import { IsEmail, IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { ROLES, type Role, type TenantNotificationConfig } from '@rhud/shared';
import { IMAGE_CONTENT_TYPES } from '../storage/media.js';

const ROLE_VALUES = ROLES as readonly string[];

export class CreateInviteDto {
  @IsEmail()
  email!: string;

  @IsIn(ROLE_VALUES)
  role!: Role;
}

export class UpdateUserRoleDto {
  @IsIn(ROLE_VALUES)
  role!: Role;
}

export class AcceptInviteDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /** Auto-generate the AI lead summary on every opportunity open
   *  when there's been new activity since the last generation.
   *  Default is true at row creation; admins can flip in /settings. */
  @IsOptional()
  leadSummaryAutoGenerate?: boolean;

  /** Phase C — multi-level approval thresholds (cents). Pass null to
   *  clear (= disable that escalation tier). */
  @IsOptional()
  requiresVpApprovalAboveCents?: number | null;

  @IsOptional()
  requiresCeoApprovalAboveCents?: number | null;

  /** Per-tenant notification routing override. Shape is deep-validated in
   *  the service (event keys ∈ THREAD_EVENT_TYPES, roles ∈ RECIPIENT_ROLES).
   *  Pass null to clear back to system defaults. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  notificationConfig?: TenantNotificationConfig | null;

  /** S3 object key for the workspace logo, returned by POST
   *  /tenant/logo/presign. Verified to sit under this tenant's prefix
   *  before persisting. Pass null to remove the logo. */
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(512)
  logoKey?: string | null;
}

/** POST /tenant/logo/presign — request a signed PUT url for the workspace logo. */
export class LogoPresignDto {
  @IsString()
  @IsIn(IMAGE_CONTENT_TYPES as unknown as string[])
  contentType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}
