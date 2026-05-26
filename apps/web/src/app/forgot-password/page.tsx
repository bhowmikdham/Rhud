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
import { Shell, Field, Submit } from '../signup/page';

type Phase = 'idle' | 'submitting' | 'sent';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase === 'submitting') return;
    setError(null);
    if (!email) {
      setError('Enter your email.');
      return;
    }
    setPhase('submitting');
    try {
      const r = await auth.requestPasswordReset(email);
      setPhase('sent');
      if (r.devToken) {
        setDevLink(`/auth/reset-password?token=${r.devToken}`);
      }
    } catch (err) {
      setError(describeError(err));
      setPhase('idle');
    }
  }

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 18, marginBottom: 24 }}>rhud</div>

      {phase === 'sent' ? (
        <>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 8px' }}>Check your email</h1>
          <p style={{ color: '#444', margin: '0 0 24px', lineHeight: 1.5, fontSize: 14 }}>
            If <strong>{email}</strong> matches an account, a password-reset link is on its way. The link expires in 60 minutes.
          </p>
          {devLink && (
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 16px' }}>
              DEV shortcut: <a href={devLink} style={{ color: '#444' }}>{devLink}</a>
            </p>
          )}
          <Link href="/login" style={{ color: '#111', fontWeight: 600, textDecoration: 'underline' }}>
            Back to sign in
          </Link>
        </>
      ) : (
        <>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 8px' }}>Reset your password</h1>
          <p style={{ color: '#444', margin: '0 0 24px', lineHeight: 1.5, fontSize: 14 }}>
            Enter your work email and we&apos;ll send you a reset link.
          </p>
          <form onSubmit={submit}>
            <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus placeholder="you@company.com" />
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
            <Submit phase={phase} idleLabel="Send reset link" submittingLabel="Sending…" />
          </form>
          <p style={{ color: '#444', marginTop: 16, fontSize: 13 }}>
            Remembered it? <Link href="/login" style={{ color: '#111', fontWeight: 600, textDecoration: 'underline' }}>Sign in</Link>
          </p>
        </>
      )}
    </Shell>
  );
}
