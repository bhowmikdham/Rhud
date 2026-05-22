import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ROLES, type Role } from '@rhud/shared';

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

  /** Phase D — tenant proposal-template defaults (methodology, tools,
   *  team, T&C). Passed as a partial; we merge with the stored object
   *  so individual fields can be updated without clobbering others. */
  @IsOptional()
  proposalDefaults?: Record<string, unknown>;
}
