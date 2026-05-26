'use client';

/**
 * Email-verification consume page.
 *
 * Reached from the link in the signup confirmation email
 * (https://rhud.net/auth/verify-email?token=...). Consumes the token,
 * signs the user in, redirects to /dashboard.
 *
 * Suspense pattern (same as /auth/magic) because useSearchParams forces
 * dynamic rendering — Next 14's prerender pass fails without a boundary.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { auth, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Shell } from '../../signup/page';

type Phase = 'verifying' | 'success' | 'error';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<View phase="verifying" />}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
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
        const r = await auth.verifyEmail(token);
        if (cancelled) return;
        signIn(r.token, r.user);
        setPhase('success');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <View phase={phase} errorMsg={errorMsg} />;
}

function View({ phase, errorMsg }: { phase: Phase; errorMsg?: string | null }) {
  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 24, textAlign: 'center' }}>rhud</div>
      <div style={{ textAlign: 'center' }}>
        {phase === 'verifying' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Confirming your email…</div>
            <div style={{ color: '#666', fontSize: 13 }}>This only takes a moment.</div>
          </>
        )}
        {phase === 'success' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8 }}>Email confirmed</div>
            <div style={{ color: '#666', fontSize: 13 }}>Taking you to your dashboard…</div>
          </>
        )}
        {phase === 'error' && (
          <>
            <div style={{ fontSize: 18, marginBottom: 8, color: '#b00020' }}>
              We couldn&apos;t confirm this link
            </div>
            <div style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
              {errorMsg ?? 'The link may be invalid or expired.'}
            </div>
            <Link
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
            </Link>
          </>
        )}
      </div>
    </Shell>
  );
}
