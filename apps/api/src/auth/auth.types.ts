import type { Role } from '@rhud/shared';

export interface JwtPayload {
  sub: string;        // user id
  tid: string;        // tenant id
  role: Role;
  email: string;
  tv: number;         // token version — must match users.token_version (revocation)
}

/**
 * Enriched user representation returned by GET/PATCH /auth/me. Mirrors the
 * JWT payload but adds DB-only fields (currently just `name`) the JWT
 * doesn't carry. Frontend uses this to render the user's display name in
 * the sidebar and topbar.
 */
export interface MeResponse extends Omit<JwtPayload, 'tv'> {
  // The /me response intentionally omits the token-version claim (`tv`); it's
  // an internal revocation detail, not something the frontend needs.
  name: string | null;
  /** Short-lived signed GET url for the profile photo, or null when the
   *  user hasn't uploaded one. The frontend renders this in the sidebar /
   *  topbar / Settings → Account, falling back to initials when null. */
  avatarUrl: string | null;
}

export interface AuthedRequest {
  user: JwtPayload;
  tenantId: string;
}
