import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './auth.types.js';
import { UnscopedDb } from '../db/unscoped-db.js';
import { isRole } from '@rhud/shared';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly unscoped: UnscopedDb,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { user?: JwtPayload; tenantId?: string }>();
    const header = req.headers.authorization;
    if (!header || !header.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException('missing_bearer');
    }
    const token = header.slice(7).trim();
    let payload: JwtPayload;
    try {
      payload = this.jwt.verify<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('invalid_token');
    }
    if (!payload.sub || !payload.tid || !isRole(payload.role)) {
      throw new UnauthorizedException('malformed_token');
    }
    // Revocation check: the user must still exist and the token's version must
    // match the live row. token_version is bumped on role change / password
    // reset, and a deactivated user is hard-deleted (no row). Without this a
    // demoted/deleted user keeps full access until the token naturally expires.
    // Tokens issued before this feature carry no `tv` claim → treated as 0,
    // which matches the default column value, so they stay valid until a bump.
    const authState = await this.unscoped.findUserAuthState(payload.sub);
    if (!authState) throw new UnauthorizedException('user_not_found');
    if ((payload.tv ?? 0) !== authState.tokenVersion) {
      throw new UnauthorizedException('token_revoked');
    }
    req.user = payload;
    req.tenantId = payload.tid;
    return true;
  }
}
