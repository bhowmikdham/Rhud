'use client';

/**
 * Self-serve signup page.
 *
 * Creates a tenant + admin user. After submit the user sees a "check your
 * email" success state — they cannot log in until they click the
 * verification link. Once verified the consume page (/auth/verify-email)
 * issues a JWT and redirects to /dashboard.
 */

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { auth, describeError } from '@/lib/api';
import { AuthShell, AuthField, AuthSubmit, authStyles as S } from '@/components/auth-form';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    if (!email || !password || !tenantName) {
      setError('All fields are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setSubmitting(true);
    try {
      const r = await auth.signup({ email, password, tenantName });
      setSent(true);
      if (r.devToken) setDevLink(`/auth/verify-email?token=${r.devToken}`);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div style={S.brand}>rhud</div>
      {sent ? (
        <>
          <h1 style={S.h1}>Check your email</h1>
          <p style={S.p}>
            We sent a verification link to <strong>{email}</strong>. Click it to activate{' '}
            <strong>{tenantName}</strong> and sign in. The link expires in 24 hours.
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
          <h1 style={S.h1}>Create your Rhud workspace</h1>
          <p style={S.p}>Spin up a new tenant. You&apos;ll be the admin.</p>
          <form onSubmit={submit}>
            <AuthField label="Workspace name" value={tenantName} onChange={setTenantName} placeholder="Acme Consulting" autoFocus />
            <AuthField label="Work email" type="email" value={email} onChange={setEmail} placeholder="you@company.com" />
            <AuthField label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" />
            {error && <div style={S.err}>{error}</div>}
            <AuthSubmit submitting={submitting} idleLabel="Create workspace" submittingLabel="Creating…" />
          </form>
          <p style={{ ...S.p, marginTop: 16, fontSize: 13 }}>
            Already have an account? <Link href="/login" style={S.link}>Sign in</Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
