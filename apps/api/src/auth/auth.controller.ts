import { Body, Controller, Get, HttpCode, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import {
  AvatarPresignDto,
  ConsumeMagicLinkDto,
  LoginDto,
  RequestMagicLinkDto,
  RequestPasswordResetDto,
  ResetPasswordDto,
  SignupDto,
  UpdateMeDto,
  VerifyEmailDto,
} from './dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { AuthedRequest, JwtPayload, MeResponse } from './auth.types.js';

@Controller('auth')
// Rate-limit the whole auth surface per client IP. The unauthenticated and
// token-consuming routes get tighter per-route overrides below — this is the
// brute-force / account-enumeration / token-flood mitigation (auth-3).
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async login(@Body() dto: LoginDto): Promise<{ token: string; user: JwtPayload }> {
    return this.auth.loginWithPassword(dto.email, dto.password);
  }

  /**
   * Always returns `{ ok: true }` regardless of whether the email matched —
   * prevents user enumeration. In production the returned token is NEVER
   * sent in the response; it's emailed. For sprint 1 dev ergonomics we return
   * the plaintext token only when NODE_ENV !== 'production'.
   */
  @Post('magic-link/request')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestMagicLink(
    @Body() dto: RequestMagicLinkDto,
  ): Promise<{ ok: true; devToken?: string }> {
    const token = await this.auth.requestMagicLink(dto.email);
    if (process.env.NODE_ENV !== 'production' && token) {
      return { ok: true, devToken: token };
    }
    return { ok: true };
  }

  @Post('magic-link/consume')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async consumeMagicLink(
    @Body() dto: ConsumeMagicLinkDto,
  ): Promise<{ token: string; user: JwtPayload }> {
    return this.auth.consumeMagicLink(dto.token);
  }

  /**
   * Self-serve signup. Creates tenant + admin user (email_verified=false)
   * and emails the verification link. The user must click the link before
   * loginWithPassword will grant a session. Returns devToken in dev.
   */
  @Post('signup')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async signup(@Body() dto: SignupDto): Promise<{ ok: true; devToken?: string }> {
    return this.auth.signup({
      email: dto.email,
      password: dto.password,
      tenantName: dto.tenantName,
      ...(dto.userName !== undefined ? { userName: dto.userName } : {}),
      ...(dto.industryTemplateSlug !== undefined
        ? { industryTemplateSlug: dto.industryTemplateSlug }
        : {}),
    });
  }

  /**
   * Consume the verification token from /auth/verify-email?token=...
   * On success returns a JWT so the user lands straight in the dashboard.
   */
  @Post('verify-email')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async verifyEmail(@Body() dto: VerifyEmailDto): Promise<{ token: string; user: JwtPayload }> {
    return this.auth.verifyEmail(dto.token);
  }

  /**
   * Issue a password-reset token. Same enumeration protection as magic-link:
   * always returns 202 regardless of whether the email exists.
   */
  @Post('password/reset/request')
  @HttpCode(202)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  async requestPasswordReset(
    @Body() dto: RequestPasswordResetDto,
  ): Promise<{ ok: true; devToken?: string }> {
    const token = await this.auth.requestPasswordReset(dto.email);
    if (process.env.NODE_ENV !== 'production' && token) {
      return { ok: true, devToken: token };
    }
    return { ok: true };
  }

  /**
   * Consume a password-reset token and set the new password. Issues a JWT
   * so the user is signed in immediately after a successful reset.
   */
  @Post('password/reset/consume')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
  ): Promise<{ token: string; user: JwtPayload }> {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthedRequest): Promise<MeResponse> {
    return this.auth.getMyProfile(req.user);
  }

  /** Update the signed-in user's own profile (display name + profile
   *  photo). Returns the same shape as GET /me so the client can swap
   *  state without a re-fetch. */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  updateMe(
    @Req() req: AuthedRequest,
    @Body() dto: UpdateMeDto,
  ): Promise<MeResponse> {
    return this.auth.updateMyProfile(req.user, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.avatarKey !== undefined ? { avatarKey: dto.avatarKey } : {}),
    });
  }

  /** Get a signed PUT url to upload a new profile photo. The client PUTs
   *  the image to `uploadUrl`, then PATCHes /auth/me with the returned
   *  `key` to persist it. */
  @Post('avatar/presign')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  presignAvatar(
    @Req() req: AuthedRequest,
    @Body() dto: AvatarPresignDto,
  ): Promise<{ uploadUrl: string; key: string; expiresAt: string }> {
    return this.auth.presignAvatar(req.user, {
      contentType: dto.contentType,
      ...(dto.filename !== undefined ? { filename: dto.filename } : {}),
    });
  }
}
