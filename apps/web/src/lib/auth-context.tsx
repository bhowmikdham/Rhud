'use client';

/**
 * Lightweight auth context for the web. Reads the JWT from localStorage,
 * fetches `/auth/me` once, and exposes `{ user, loading, signOut }` to any
 * component. Routes that require auth use `useRequireAuth()` which redirects
 * to /login if no user is loaded.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth, ApiError } from './api';

export interface AuthUser {
  sub: string;
  tid: string;
  role: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  signIn: (token: string, user: AuthUser) => void;
  signOut: () => void;
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const token = typeof window !== 'undefined' ? window.localStorage.getItem('rhud.token') : null;
    if (!token) {
      setLoading(false);
      return;
    }
    auth
      .me()
      .then((u) => setUser(u as AuthUser))
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
  }, []);

  const signOut = useCallback(() => {
    window.localStorage.removeItem('rhud.token');
    setUser(null);
    router.push('/login');
  }, [router]);

  return <Ctx.Provider value={{ user, loading, signIn, signOut }}>{children}</Ctx.Provider>;
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
