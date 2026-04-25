'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icon';

export default function LoginPage() {
  const router = useRouter();
  const { user, loading, signIn } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loading && user) router.replace('/dashboard');
  }, [loading, user, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await auth.login(email, password);
      signIn(r.token, r.user);
      router.replace('/dashboard');
    } catch (e) {
      setErr('Invalid email or password.');
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: 'var(--bg-sunk)',
      display: 'grid', placeItems: 'center', padding: 24,
    }}>
      <div style={{
        width: '100%', maxWidth: 380,
        background: 'var(--bg-elev)', border: '1px solid var(--border)',
        borderRadius: 16, boxShadow: 'var(--shadow-md)',
        padding: '32px 32px 28px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div className="logo-mark" aria-hidden />
          <div>
            <div className="logo-wordmark" style={{ fontSize: 16 }}>rhud</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Sign in to your workspace</div>
          </div>
        </div>

        <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Field label="Email">
            <input
              type="email" required autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input"
              placeholder="you@company.com"
            />
          </Field>
          <Field label="Password">
            <input
              type="password" required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input"
              placeholder="••••••••"
            />
          </Field>

          {err && (
            <div style={{
              fontSize: 12, color: 'var(--danger)',
              padding: '8px 10px', borderRadius: 6,
              background: 'var(--danger-tint)',
              border: '1px solid color-mix(in oklch, var(--danger) 20%, transparent)',
            }}>{err}</div>
          )}

          <button type="submit" disabled={busy} className="btn accent lg" style={{ justifyContent: 'center', marginTop: 8 }}>
            {busy ? <span className="spin" /> : <Icon.ArrowRight size={13} />}
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div style={{
          marginTop: 24, paddingTop: 16,
          borderTop: '1px solid var(--divider)',
          fontSize: 11.5, color: 'var(--fg-subtle)',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon.Lock size={11} /> End-to-end encrypted · single tenant per session
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-muted)', marginBottom: 6 }}>{label}</div>
      {children}
    </label>
  );
}
