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
}
