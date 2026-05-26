'use client';

/**
 * Magic-link consume page.
 *
 * Reached when a user clicks the link in their sign-in email. The URL is
 * shaped `https://rhud.net/auth/magic?token=...`. We hand the token to the
 * api, store the returned JWT via the auth context, then redirect to the
 * dashboard. On invalid/expired we show a clear message with a way back to
 * /login.
 *
 * Implementation note: `useSearchParams()` makes a route dynamic. Next 14
 * requires the component that calls it to be wrapped in <Suspense>, or the
 * production build fails on the prerender pass. The default export is the
 * Suspense wrapper; the inner component does the actual work.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { AuthBrand } from '@/components/auth-form';

type Phase = 'verifying' | 'success' | 'error';

export default function MagicLinkConsumePage() {
  return (
    <Suspense fallback={<ConsumeShell phase="verifying" />}>
      <ConsumeInner />
    </Suspense>
  );
}

function ConsumeInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn } = useAuth();

  const [phase, setPhase] = useState<Phase>('verifying');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setErrorMsg('Missing token in URL.');
      setPhase('error');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await auth.consumeMagicLink(token);
        if (cancelled) return;
        signIn(res.token, res.user);
        setPhase('success');
        // Brief pause so the user perceives the success state, then redirect.
        setTimeout(() => router.replace('/dashboard'), 500);
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(describeError(err));
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
    };
    // run-once on mount; params is stable for the lifetime of this page render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <ConsumeShell phase={phase} errorMsg={errorMsg} />;
}

function ConsumeShell({ phase, errorMsg }: { phase: Phase; errorMsg?: string | null }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#f5f5f5',
        fontFamily:
          '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
        color: '#111',
      }}
    >
      <div
        style={{
          background: '#fff',
          padding: '32px 40px',
          borderRadius: 12,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          minWidth: 360,
          maxWidth: 460,
          textAlign: 'center',
        }}
      >
        <AuthBrand align="center" />
        {phase === 'verifying' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Signing you in…</div>
            <div style={{ color: '#666', fontSize: 13 }}>
              Hold on while we verify your link.
            </div>
          </>
        )}
        {phase === 'success' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Welcome back</div>
            <div style={{ color: '#666', fontSize: 13 }}>Redirecting to your dashboard…</div>
          </>
        )}
        {phase === 'error' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8, color: '#b00020' }}>
              We couldn&apos;t sign you in
            </div>
            <div style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
              {errorMsg ?? 'Invalid or expired link.'}
            </div>
            <a
              href="/login"
              style={{
                display: 'inline-block',
                background: '#111',
                color: '#fff',
                padding: '10px 20px',
                borderRadius: 8,
                textDecoration: 'none',
                fontWeight: 600,
                fontSize: 14,
              }}
            >
              Back to sign in
            </a>
          </>
        )}
      </div>
    </div>
  );
}
