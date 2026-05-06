'use client';

/**
 * Public invite-acceptance page. Reads the token from `?token=…`, previews
 * who the invite is for + which workspace they're joining, then collects
 * a password to create the account. On success the JWT is stored and we
 * redirect to /dashboard — same flow as a fresh login.
 */

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { invitesPublic, describeError } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icon';

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  sales_manager: 'Sales manager',
  sales_employee: 'Sales rep',
  tech_team: 'Tech team',
};

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={null}>
      <AcceptInviteInner />
    </Suspense>
  );
}

function AcceptInviteInner() {
  const search = useSearchParams();
  const router = useRouter();
  const { signIn } = useAuth();
  const token = search.get('token') ?? '';

  const [preview, setPreview] = useState<
    { email: string; role: string; tenantName: string } | null | 'invalid'
  >(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setPreview('invalid');
      return;
    }
    invitesPublic
      .preview(token)
      .then((p) => setPreview(p ?? 'invalid'))
      .catch(() => setPreview('invalid'));
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) {
      setErr('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setErr('Passwords don\'t match.');
      return;
    }
    setBusy(true);
    try {
      const res = await invitesPublic.accept(token, password);
      signIn(res.token, res.user);
      router.replace('/dashboard');
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'grid', placeItems: 'center',
      padding: 24, background: 'var(--bg-sunk)',
    }}>
      <div className="card" style={{ width: '100%', maxWidth: 420, background: 'var(--bg)', padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 8,
            background: 'var(--accent)', color: 'var(--accent-fg)',
            display: 'grid', placeItems: 'center', fontWeight: 700,
          }}>r</div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>rhud</div>
        </div>

        {preview === null ? (
          <div className="empty" style={{ padding: 40 }}>
            <span className="spin" />
          </div>
        ) : preview === 'invalid' ? (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 8px' }}>Invite no longer valid</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 20px' }}>
              This invite link is invalid, expired, or has already been used. Ask whoever invited you for a fresh link.
            </p>
            <Link href="/login" className="btn">Go to sign in</Link>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 18, fontWeight: 600, margin: '0 0 6px' }}>Join {preview.tenantName}</h1>
            <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 20px' }}>
              You&apos;re joining as <b style={{ color: 'var(--fg)' }}>{ROLE_LABELS[preview.role] ?? preview.role}</b>.
            </p>

            <div style={{
              padding: 12, background: 'var(--bg-sunk)', borderRadius: 8,
              fontSize: 12.5, marginBottom: 18,
            }}>
              <span style={{ color: 'var(--fg-subtle)' }}>Email</span>
              <div style={{ fontWeight: 500, marginTop: 2 }}>{preview.email}</div>
            </div>

            <form onSubmit={submit} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Set a password</span>
                <input
                  className="input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                  autoFocus
                  style={{ height: 34, padding: '0 10px', fontSize: 13 }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Confirm password</span>
                <input
                  className="input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={8}
                  required
                  style={{ height: 34, padding: '0 10px', fontSize: 13 }}
                />
              </label>

              {err && (
                <div style={{
                  padding: 10,
                  background: 'var(--danger-tint)', color: 'var(--danger)',
                  border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                  borderRadius: 8, fontSize: 12,
                }}>{err}</div>
              )}

              <button type="submit" disabled={busy} className="btn accent lg" style={{ marginTop: 4, width: '100%' }}>
                {busy ? <span className="spin" /> : <><Icon.ArrowRight size={13} /> Create account &amp; sign in</>}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
