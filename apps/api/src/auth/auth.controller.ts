import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import { ConsumeMagicLinkDto, LoginDto, RequestMagicLinkDto } from './dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthedRequest, JwtPayload } from './auth.types.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
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
  async consumeMagicLink(
    @Body() dto: ConsumeMagicLinkDto,
  ): Promise<{ token: string; user: JwtPayload }> {
    return this.auth.consumeMagicLink(dto.token);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@Req() req: AuthedRequest): JwtPayload {
    return req.user;
  }
}
