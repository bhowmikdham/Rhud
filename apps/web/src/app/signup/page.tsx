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

type Phase = 'idle' | 'submitting' | 'sent';

export default function SignupPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantName, setTenantName] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (phase === 'submitting') return;
    setError(null);
    if (!email || !password || !tenantName) {
      setError('All fields are required.');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    setPhase('submitting');
    try {
      const r = await auth.signup({ email, password, tenantName });
      setPhase('sent');
      if (r.devToken) {
        setDevLink(`/auth/verify-email?token=${r.devToken}`);
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
          <h1 style={H1}>Check your email</h1>
          <p style={P}>
            We sent a verification link to <strong>{email}</strong>. Click it to activate{' '}
            <strong>{tenantName}</strong> and sign in. The link expires in 24 hours.
          </p>
          {devLink && (
            <p style={{ ...P, fontSize: 12, color: '#666', marginTop: 16 }}>
              DEV shortcut: <a href={devLink} style={{ color: '#444' }}>{devLink}</a>
            </p>
          )}
          <Link href="/login" style={LINK}>Back to sign in</Link>
        </>
      ) : (
        <>
          <h1 style={H1}>Create your Rhud workspace</h1>
          <p style={P}>Spin up a new tenant. You&apos;ll be the admin.</p>
          <form onSubmit={submit}>
            <Field label="Workspace name" value={tenantName} onChange={setTenantName} placeholder="Acme Consulting" autoFocus />
            <Field label="Work email" type="email" value={email} onChange={setEmail} placeholder="you@company.com" />
            <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="At least 8 characters" />
            {error && <div style={ERR}>{error}</div>}
            <Submit phase={phase} idleLabel="Create workspace" submittingLabel="Creating…" />
          </form>
          <p style={{ ...P, marginTop: 16, fontSize: 13 }}>
            Already have an account? <Link href="/login" style={LINK}>Sign in</Link>
          </p>
        </>
      )}
    </Shell>
  );
}

// ── shared shell + form bits (kept inline to avoid CSS churn for now) ──

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#f5f5f5',
        fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
        color: '#111',
        padding: '32px 16px',
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
          width: '100%',
        }}
      >
        {children}
      </div>
    </div>
  );
}

const H1: React.CSSProperties = { fontSize: 22, fontWeight: 600, margin: '0 0 8px' };
const P: React.CSSProperties = { color: '#444', margin: '0 0 24px', lineHeight: 1.5, fontSize: 14 };
const LINK: React.CSSProperties = { color: '#111', fontWeight: 600, textDecoration: 'underline' };
const ERR: React.CSSProperties = {
  background: '#fef2f2',
  color: '#b00020',
  padding: '8px 12px',
  borderRadius: 8,
  fontSize: 13,
  margin: '8px 0 16px',
};

export function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 6 }}>{props.label}</span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoComplete={
          props.type === 'password'
            ? 'new-password'
            : props.type === 'email'
              ? 'email'
              : 'off'
        }
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid #ddd',
          borderRadius: 8,
          fontSize: 14,
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}

export function Submit({ phase, idleLabel, submittingLabel }: { phase: Phase; idleLabel: string; submittingLabel: string }) {
  return (
    <button
      type="submit"
      disabled={phase !== 'idle'}
      style={{
        width: '100%',
        padding: '12px 16px',
        background: phase === 'idle' ? '#111' : '#666',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 14,
        cursor: phase === 'idle' ? 'pointer' : 'not-allowed',
        marginTop: 8,
      }}
    >
      {phase === 'submitting' ? submittingLabel : idleLabel}
    </button>
  );
}
