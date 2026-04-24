import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import type { JwtPayload } from './auth.types.js';
import { isRole } from '@rhud/shared';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  canActivate(ctx: ExecutionContext): boolean {
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
    req.user = payload;
    req.tenantId = payload.tid;
    return true;
  }
}
