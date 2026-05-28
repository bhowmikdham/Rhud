// JWT cache + sign-in orchestration.

import type { CachedAuth } from './types';
import { openSignInDialog } from './office';

const TOKEN_KEY = 'rhud_addin_token';
const USER_KEY = 'rhud_addin_user';

export function readCachedAuth(): CachedAuth | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const userRaw = localStorage.getItem(USER_KEY);
  if (!token || !userRaw) return null;
  // We don't verify expiry locally — the API returns 401 if it's expired,
  // and callers clear the cache + reprompt on that.
  try {
    return { token, user: JSON.parse(userRaw) };
  } catch {
    return null;
  }
}

export function cacheAuth(auth: CachedAuth): void {
  localStorage.setItem(TOKEN_KEY, auth.token);
  localStorage.setItem(USER_KEY, JSON.stringify(auth.user));
}

export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** Return a usable session — from cache if present, else open the dialog. */
export async function signIn(): Promise<CachedAuth> {
  const cached = readCachedAuth();
  if (cached) return cached;
  const auth = await openSignInDialog();
  cacheAuth(auth);
  return auth;
}
