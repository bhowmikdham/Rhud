'use client';

/**
 * Lightweight auth context for the web. Reads the JWT from localStorage,
 * fetches `/auth/me` once, and exposes `{ user, loading, signOut }` to any
 * component. Routes that require auth use `useRequireAuth()` which redirects
 * to /login if no user is loaded.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth, tenant as tenantApi, ApiError, type AuthMe, type TenantInfo } from './api';

export interface AuthUser {
  sub: string;
  tid: string;
  role: string;
  email: string;
  /** Optional display name. Null when the user hasn't set one — sidebar
   *  / topbar fall back to the email local-part. */
  name?: string | null;
}

interface AuthContextValue {
  user: AuthUser | null;
  /** Current workspace identity. `null` until /tenant/me resolves. */
  tenant: TenantInfo | null;
  loading: boolean;
  signIn: (token: string, user: AuthUser) => void;
  signOut: () => void;
  /** Refresh the cached tenant after an admin renames it. */
  refreshTenant: () => Promise<void>;
  /** Refresh the cached user (e.g. after Settings → Account save). */
  refreshUser: () => Promise<void>;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenant, setTenant] = useState<TenantInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('rhud.token') : null;
    if (!token) {
      setLoading(false);
      return;
    }
    Promise.all([auth.me() as Promise<AuthMe>, tenantApi.me().catch(() => null)])
      .then(([u, t]) => {
        setUser(u as AuthUser);
        setTenant(t);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          window.localStorage.removeItem('rhud.token');
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const signIn = useCallback((token: string, u: AuthUser) => {
    window.localStorage.setItem('rhud.token', token);
    setUser(u);
    // Fetch the tenant in the background — non-blocking so the post-login
    // redirect happens immediately.
    tenantApi.me().then(setTenant).catch(() => setTenant(null));
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem('rhud.token');
    setUser(null);
    setTenant(null);
    router.push('/login');
  }, [router]);

  const refreshTenant = useCallback(async () => {
    try {
      const t = await tenantApi.me();
      setTenant(t);
    } catch {
      // Stale tenant beats no tenant in the UI.
    }
  }, []);

  const refreshUser = useCallback(async () => {
    try {
      const u = await auth.me();
      setUser(u as AuthUser);
    } catch {
      // Stale user beats no user in the UI.
    }
  }, []);

  return (
    <Ctx.Provider value={{ user, tenant, loading, signIn, signOut, refreshTenant, refreshUser }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Hook for pages that require auth. Redirects to /login if not signed in. */
export function useRequireAuth(): AuthUser | null {
  const { user, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [loading, user, router]);
  return user;
}
