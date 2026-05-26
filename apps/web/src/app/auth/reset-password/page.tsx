'use client';

/**
 * Password-reset consume page.
 *
 * Reached from /auth/reset-password?token=... in the reset email. Shows a
 * form to choose a new password; on submit posts to the consume endpoint,
 * the api issues a JWT, and we redirect to /dashboard.
 */

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { auth, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Shell, Field, Submit } from '../../signup/page';

type Phase = 'idle' | 'submitting' | 'success' | 'error';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Shell><div>Loading…</div></Shell>}>
      <Inner />
    </Suspense>
  );
}

function Inner() {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn } = useAuth();

  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  const token = params.get('token');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase === 'submitting') return;
    setError(null);
    if (!token) {
      setError('Missing token in URL.');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPhase('submitting');
    try {
      const r = await auth.resetPassword(token, newPassword);
      signIn(r.token, r.user);
      setPhase('success');
      setTimeout(() => router.replace('/dashboard'), 500);
    } catch (err) {
      setError(describeError(err));
      setPhase('idle');
    }
  }

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 24 }}>rhud</div>

      {!token ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: '#b00020' }}>Missing reset token</div>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
            Open this page from the link in your reset email.
          </div>
          <Link href="/forgot-password" style={{ color: '#111', fontWeight: 600, textDecoration: 'underline' }}>
            Request a new link
          </Link>
        </>
      ) : phase === 'success' ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Password reset</div>
          <div style={{ color: '#666', fontSize: 13 }}>Signing you in…</div>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 8px' }}>Choose a new password</h1>
          <p style={{ color: '#444', margin: '0 0 24px', lineHeight: 1.5, fontSize: 14 }}>
            Pick something strong. You&apos;ll be signed in after setting it.
          </p>
          <form onSubmit={submit}>
            <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} autoFocus placeholder="At least 8 characters" />
            <Field label="Confirm password" type="password" value={confirm} onChange={setConfirm} placeholder="Same again" />
            {error && (
              <div
                style={{
                  background: '#fef2f2',
                  color: '#b00020',
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  margin: '8px 0 16px',
                }}
              >
                {error}
              </div>
            )}
            <Submit phase={phase === 'submitting' ? 'submitting' : 'idle'} idleLabel="Set new password" submittingLabel="Setting…" />
          </form>
        </>
      )}
    </Shell>
  );
}
