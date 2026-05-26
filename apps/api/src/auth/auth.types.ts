import type { Role } from '@rhud/shared';

export interface JwtPayload {
  sub: string;        // user id
  tid: string;        // tenant id
  role: Role;
  email: string;
}

/**
 * Enriched user representation returned by GET/PATCH /auth/me. Mirrors the
 * JWT payload but adds DB-only fields (currently just `name`) the JWT
 * doesn't carry. Frontend uses this to render the user's display name in
 * the sidebar and topbar.
 */
export interface MeResponse extends JwtPayload {
  name: string | null;
}

export interface AuthedRequest {
  user: JwtPayload;
  tenantId: string;
}
