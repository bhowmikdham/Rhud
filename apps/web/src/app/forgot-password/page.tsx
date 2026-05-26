'use client';

/**
 * Forgot-password page.
 *
 * POST /auth/password/reset/request always returns `{ ok: true }` regardless
 * of whether the email is registered — we mirror that intent in the UI by
 * showing the success state unconditionally on submit, never confirming
 * whether the address exists.
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { auth, describeError } from '@/lib/api';
import { AuthBrand, AuthShell, AuthField, AuthSubmit, authStyles as S } from '@/components/auth-form';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!email) {
      setError('Enter your email.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await auth.requestPasswordReset(email);
      setSent(true);
      if (r.devToken) setDevLink(`/auth/reset-password?token=${r.devToken}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <AuthBrand />
      {sent ? (
        <>
          <h1 style={S.h1}>Check your email</h1>
          <p style={S.p}>
            If <strong>{email}</strong> matches an account, a password-reset link is on its way. The link expires in 60 minutes.
          </p>
          {devLink && (
            <p style={S.dev}>
              DEV shortcut: <a href={devLink} style={{ color: '#444' }}>{devLink}</a>
            </p>
          )}
          <p style={{ ...S.p, marginTop: 16, fontSize: 13 }}>
            <Link href="/login" style={S.link}>Back to sign in</Link>
          </p>
        </>
      ) : (
        <>
          <h1 style={S.h1}>Reset your password</h1>
          <p style={S.p}>Enter your work email and we&apos;ll send you a reset link.</p>
          <form onSubmit={submit}>
            <AuthField label="Email" type="email" value={email} onChange={setEmail} autoFocus placeholder="you@company.com" />
            {error && <div style={S.err}>{error}</div>}
            <AuthSubmit submitting={submitting} idleLabel="Send reset link" submittingLabel="Sending…" />
          </form>
          <p style={{ ...S.p, marginTop: 16, fontSize: 13 }}>
            Remembered it? <Link href="/login" style={S.link}>Sign in</Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
