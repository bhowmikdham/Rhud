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
import { AuthShell, AuthField, AuthSubmit, authStyles as S } from '@/components/auth-form';

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <AuthShell>
          <div>Loading…</div>
        </AuthShell>
      }
    >
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
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const token = params.get('token');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
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
    setSubmitting(true);
    try {
      const r = await auth.resetPassword(token, newPassword);
      signIn(r.token, r.user);
      setSuccess(true);
      setTimeout(() => router.replace('/dashboard'), 500);
    } catch (err) {
      setError(describeError(err));
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div style={S.brand}>rhud</div>

      {!token ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8, color: '#b00020' }}>Missing reset token</div>
          <div style={{ color: '#666', fontSize: 13, marginBottom: 20 }}>
            Open this page from the link in your reset email.
          </div>
          <Link href="/forgot-password" style={S.link}>Request a new link</Link>
        </>
      ) : success ? (
        <>
          <div style={{ fontSize: 18, marginBottom: 8 }}>Password reset</div>
          <div style={{ color: '#666', fontSize: 13 }}>Signing you in…</div>
        </>
      ) : (
        <>
          <h1 style={S.h1}>Choose a new password</h1>
          <p style={S.p}>Pick something strong. You&apos;ll be signed in after setting it.</p>
          <form onSubmit={submit}>
            <AuthField label="New password" type="password" value={newPassword} onChange={setNewPassword} autoFocus placeholder="At least 8 characters" />
            <AuthField label="Confirm password" type="password" value={confirm} onChange={setConfirm} placeholder="Same again" />
            {error && <div style={S.err}>{error}</div>}
            <AuthSubmit submitting={submitting} idleLabel="Set new password" submittingLabel="Setting…" />
          </form>
        </>
      )}
    </AuthShell>
  );
}
