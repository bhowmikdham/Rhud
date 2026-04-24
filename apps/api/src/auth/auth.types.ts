import type { Role } from '@rhud/shared';

export interface JwtPayload {
  sub: string;        // user id
  tid: string;        // tenant id
  role: Role;
  email: string;
}

export interface AuthedRequest {
  user: JwtPayload;
  tenantId: string;
}
