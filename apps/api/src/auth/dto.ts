import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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

/** PATCH /auth/me — user updates their own profile. Currently just name;
 *  email is the unique sign-in identity (so changing it warrants its own
 *  flow), and role is administered through the Team panel. */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}
