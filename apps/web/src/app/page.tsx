'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

/**
 * Index — bounce to /dashboard if signed in, /login otherwise.
 */
export default function IndexRedirect() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [loading, user, router]);

  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', color: 'var(--fg-muted)' }}>
      <span className="spin" />
    </div>
  );
}
