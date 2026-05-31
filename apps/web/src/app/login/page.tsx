'use client';

import './login.css';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { auth } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icon';

/**
 * When the login page is opened by the Outlook add-in's sign-in dialog,
 * we don't redirect to /dashboard on success. Instead, the page redirects
 * to a hardcoded callback URL on addin.rhud.net with the JWT in the URL
 * fragment, which the add-in's bridge page reads and hands back to the
 * task pane via Office.context.ui.messageParent.
 *
 * Hardcoded (not from a query param) on purpose — otherwise an attacker
 * could craft /login?return=https://evil.example/ to siphon tokens.
 */
const ADDIN_CALLBACK_URL = process.env.NEXT_PUBLIC_ADDIN_CALLBACK_URL
  ?? 'https://addin.rhud.net/auth-callback.html';

type Status = 'idle' | 'submitting' | 'success';

/**
 * Default export is the Suspense wrapper. `useSearchParams()` (used in
 * LoginInner to detect the `?return=addin` flag from the Outlook add-in's
 * sign-in dialog) makes the route dynamic; Next 14 fails the static
 * prerender unless a Suspense boundary is present. Mirrors the same fix
 * applied to /auth/magic in 43aad75. The fallback is intentionally blank
 * — the page renders within milliseconds, so a flash of nothing is less
 * jarring than half a login form.
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, signIn } = useAuth();

  // `?return=addin` is set by apps/outlook-addin when it opens this page
  // inside an Office dialog. Triggers the alternate redirect path that
  // hands the token back to the add-in instead of going to /dashboard.
  const isAddinFlow = searchParams.get('return') === 'addin';

  const [mode, setMode] = useState<'password' | 'magic'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [remember, setRemember] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [magicStatus, setMagicStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [magicNote, setMagicNote] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    if (isAddinFlow) {
      // Already signed in to rhud.net — hand the existing session token
      // straight back to the add-in instead of forcing a needless re-login.
      const stored =
        typeof window !== 'undefined' ? window.localStorage.getItem('rhud.token') : null;
      if (stored) redirectToAddinCallback(stored, user);
      return;
    }
    router.replace('/dashboard');
    // redirectToAddinCallback closes over no reactive state — safe to omit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user, router, isAddinFlow]);

  /**
   * Hand the JWT back to the Outlook add-in by redirecting to the
   * addin-hosted callback page with token + user in the URL fragment
   * (fragments aren't sent to servers, so the JWT doesn't show up in
   * access logs). The callback page reads the fragment and calls
   * Office.context.ui.messageParent to deliver it to the task pane.
   */
  function redirectToAddinCallback(token: string, userPayload: object): void {
    const userB64 = btoa(JSON.stringify(userPayload));
    const target = `${ADDIN_CALLBACK_URL}#token=${encodeURIComponent(token)}&user=${encodeURIComponent(userB64)}`;
    // Hard navigation rather than router.replace — we're leaving the
    // Next.js app for the add-in's static origin.
    window.location.replace(target);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status !== 'idle') return;
    if (!email || !password) {
      setError('Enter your email and password');
      return;
    }
    setError(null);
    setStatus('submitting');
    try {
      const r = await auth.login(email, password);
      setStatus('success');
      setTimeout(() => {
        if (isAddinFlow) {
          // Skip signIn() — we don't want the add-in's sign-in to also
          // affect the user's main rhud.net browser tab. The add-in
          // keeps its own JWT in its own localStorage (different origin).
          redirectToAddinCallback(r.token, r.user);
          return;
        }
        signIn(r.token, r.user);
        router.replace('/dashboard');
      }, 600);
    } catch {
      setError('Invalid email or password.');
      setStatus('idle');
    }
  }

  async function submitMagic(e: React.FormEvent) {
    e.preventDefault();
    if (magicStatus !== 'idle') return;
    if (!email) {
      setMagicNote('Enter your email first.');
      return;
    }
    setMagicNote(null);
    setMagicStatus('submitting');
    try {
      const r = await auth.requestMagicLink(email);
      setMagicStatus('success');
      // Dev convenience: when the api echoes back the token (NODE_ENV !==
      // production), surface it inline so dev can click straight through
      // without an inbox.
      if (r.devToken) {
        setMagicNote(`DEV link: /auth/magic?token=${r.devToken}`);
      } else {
        setMagicNote('Check your inbox for the sign-in link.');
      }
    } catch {
      setMagicNote('Something went wrong. Try again.');
      setMagicStatus('idle');
    }
  }

  function fillDemo(seed: { email: string }) {
    setEmail(seed.email);
    setPassword('password-dev-only-12');
    setError(null);
  }

  return (
    <div className="login-shell">
      <LoginVisual />

      <div className="login-pane">
        <div className="login-form-wrap">
          <header className="login-brand">
            <div className="login-mark"><span>r</span></div>
            <span className="login-wordmark">rhud</span>
          </header>

          <div className="login-head">
            <h1>Sign in to your account</h1>
            <p>Continue scoping with Rhud.</p>
          </div>

          <div className="login-tabs">
            <button type="button" className={mode === 'password' ? 'active' : ''} onClick={() => setMode('password')}>
              Password
            </button>
            <button type="button" className={mode === 'magic' ? 'active' : ''} onClick={() => setMode('magic')}>
              <Icon.Sparkles size={11} /> Magic link
            </button>
            <span className="login-tabs-thumb" data-mode={mode} aria-hidden />
          </div>

          {mode === 'password' ? (
            <form className="login-form" onSubmit={submit} noValidate>
              <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
              <Field
                label="Password"
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={setPassword}
                trailing={
                  <button
                    type="button"
                    className="field-trail-btn"
                    onClick={() => setShowPw((s) => !s)}
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    <Icon.Eye size={13} />
                  </button>
                }
                hint={<a className="login-link" href="/forgot-password">Forgot your password?</a>}
              />
              <label className="login-checkbox">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span className="login-checkbox-box" />
                Remember me on this device
              </label>
              {error && <div className="login-error">{error}</div>}
              <SubmitButton status={status} label="Sign in" successLabel="Welcome back" />
            </form>
          ) : (
            <form className="login-form" onSubmit={submitMagic}>
              <Field label="Email" type="email" value={email} onChange={setEmail} autoFocus />
              <p className="login-helper">
                We&apos;ll email you a one-tap sign-in link. No password needed.
              </p>
              {magicNote && <div className="login-error">{magicNote}</div>}
              <SubmitButton status={magicStatus} label="Send magic link" successLabel="Check your inbox" />
            </form>
          )}

          <div className="login-divider"><span>Or sign in with</span></div>

          <div className="alt-auth-grid">
            <button type="button" className="alt-tile" disabled>
              <GoogleGlyph /><span>Google</span>
            </button>
            <button type="button" className="alt-tile" disabled>
              <PasskeyGlyph /><span>Passkey</span>
            </button>
            <button type="button" className="alt-tile" disabled>
              <Icon.Shield size={14} /><span>SSO</span>
            </button>
          </div>

          {/* DEV-only demo signin panel. process.env.NODE_ENV is inlined by
              Next at build time — in a prod build (`next build`) webpack
              dead-code-eliminates this entire JSX subtree. */}
          {process.env.NODE_ENV !== 'production' && (
            <div className="login-demo">
              <div className="login-demo-label">Dev · sign in as</div>
              <div className="login-demo-row">
                {DEMO_USERS.map((u) => (
                  <button key={u.email} type="button" className="login-demo-card" onClick={() => fillDemo(u)}>
                    <div className="avatar sm" style={{ background: u.color }}>{u.initials}</div>
                    <div>
                      <div className="login-demo-name">{u.firstName}</div>
                      <div className="login-demo-role">{u.role}</div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="login-foot">
            New to Rhud? <a href="/signup" className="login-link">Create an account</a>
          </div>
        </div>

        <footer className="login-pane-foot">
          <div>
            <span className="dot dot-ok" />
            <span>All systems normal</span>
          </div>
          <div className="login-pane-foot-links">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="#">Status</a>
            <span>EN</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

const DEMO_USERS = [
  { email: 'maya@everlane.test', firstName: 'Maya', role: 'employee', initials: 'MB', color: 'oklch(0.62 0.14 250)' },
  { email: 'oren@everlane.test', firstName: 'Oren', role: 'manager', initials: 'OT', color: 'oklch(0.58 0.12 50)' },
  { email: 'admin@everlane.test', firstName: 'Admin', role: 'admin', initials: 'AD', color: 'oklch(0.6 0.12 340)' },
];

interface FieldProps {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  trailing?: React.ReactNode;
  hint?: React.ReactNode;
}

function Field({ label, type, value, onChange, autoFocus, trailing, hint }: FieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <div className="field-block">
      <div className="field-label-row">
        <label className="field-label">{label}</label>
        {hint}
      </div>
      <div className={'field-stripe ' + (focus ? 'focus' : '')}>
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          autoFocus={autoFocus}
          autoComplete={type === 'password' ? 'current-password' : 'email'}
          spellCheck={false}
        />
        {trailing && <span className="field-trail">{trailing}</span>}
      </div>
    </div>
  );
}

function SubmitButton({ status, label, successLabel }: { status: Status; label: string; successLabel: string }) {
  return (
    <button type="submit" className={'login-submit status-' + status} disabled={status !== 'idle'}>
      <span className="login-submit-label">
        {status === 'idle' && (<>{label}<Icon.ArrowRight size={14} /></>)}
        {status === 'submitting' && (<><Spinner /> Signing in…</>)}
        {status === 'success' && (<><Icon.Check size={14} /> {successLabel}</>)}
      </span>
    </button>
  );
}

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" className="spinner-svg" aria-hidden>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function GoogleGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 18 18" aria-hidden>
      <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.7H9v3.3h4.8c-.2 1.1-.8 2-1.8 2.6v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.4z" />
      <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.5-1.8.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3C2.4 15.9 5.5 18 9 18z" />
      <path fill="#FBBC05" d="M3.9 10.7c-.2-.5-.3-1.1-.3-1.7s.1-1.2.3-1.7V5H.9C.3 6.2 0 7.6 0 9s.3 2.8.9 4l3-2.3z" />
      <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.5 1.3l2.6-2.6C13.5.9 11.4 0 9 0 5.5 0 2.4 2.1.9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
    </svg>
  );
}

function PasskeyGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="9" cy="10" r="3.5" />
      <path d="M12.5 10h7.5" />
      <path d="M17 10v2.5" />
      <path d="M20 10v1.6" />
    </svg>
  );
}

function LoginVisual() {
  const phrases = [
    'A scope link → a priced proposal → a signed deal.',
    'Everything that happens to a deal lives in one thread.',
    'Rhud predicts the price. You stay in control.',
    'From client form to Odoo in one continuous flow.',
  ];
  const [phraseIdx, setPhraseIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPhraseIdx((i) => (i + 1) % phrases.length), 4200);
    return () => clearInterval(t);
  }, [phrases.length]);

  const events = [
    { who: 'Maya',  msg: 'Generated scoping link · Northwind',     color: 'oklch(0.62 0.14 250)' },
    { who: 'Alex',  msg: 'Submitted scope · 8 answers · 2 files',  color: 'oklch(0.6 0.12 340)' },
    { who: 'Rhud',  msg: 'Predicted $102,000 ± 8% · 94% conf.',    color: 'oklch(0.52 0.14 265)' },
    { who: 'Oren',  msg: 'Approved at $102,000',                   color: 'oklch(0.58 0.12 50)' },
    { who: 'Gamma', msg: 'Drafted 14-page proposal',               color: 'oklch(0.42 0.04 270)' },
    { who: 'Rhud',  msg: 'Sent to client · synced to Odoo',        color: 'oklch(0.52 0.14 265)' },
  ];

  return (
    <div className="login-visual" aria-hidden>
      <div className="visual-mesh" />
      <div className="visual-grid" />
      <div className="visual-orb visual-orb-a" />
      <div className="visual-orb visual-orb-b" />
      <div className="visual-orb visual-orb-c" />
      <div className="visual-noise" />

      <div className="visual-top">
        <div className="login-mark mark-on-dark"><span>r</span></div>
        <div className="visual-status">
          <span className="dot dot-ok" /> v4.2 — model serving
        </div>
      </div>

      <div className="visual-stage">
        <div className="visual-card">
          <div className="visual-card-head">
            <div className="visual-card-id">ENG-2419</div>
            <div className="visual-card-stage">
              <span className="dot dot-pulse" /> Live thread
            </div>
          </div>
          <div className="visual-thread">
            {events.map((e, i) => (
              <div key={i} className="visual-thread-row" style={{ animationDelay: `${i * 0.6}s` }}>
                <span className="visual-thread-node" style={{ background: e.color }} />
                <span className="visual-thread-who">{e.who}</span>
                <span className="visual-thread-msg">{e.msg}</span>
              </div>
            ))}
          </div>
          <svg className="visual-thread-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
            <line x1="14" y1="0" x2="14" y2="100" stroke="currentColor" strokeWidth="0.4" strokeDasharray="0.6 1.4" />
          </svg>
        </div>

        <div className="visual-chip visual-chip-a">
          <span className="visual-chip-dot" />
          <span>Predicted $102K</span>
          <span className="visual-chip-meta">±8% · 1,284 comps</span>
        </div>
        <div className="visual-chip visual-chip-b">
          <span className="visual-chip-tick">✓</span>
          <span>Approved by Oren</span>
        </div>
        <div className="visual-chip visual-chip-c">
          <svg width="10" height="10" viewBox="0 0 24 24" stroke="currentColor" fill="none" strokeWidth="2.5">
            <path d="M21 3 10 14M21 3l-7 18-4-8-8-4 18-7Z" />
          </svg>
          <span>Synced to Odoo</span>
        </div>
      </div>

      <div className="visual-bottom">
        <div className="visual-tagline">
          {phrases.map((p, i) => (
            <span key={i} className={i === phraseIdx ? 'on' : ''}>{p}</span>
          ))}
        </div>
        <div className="visual-meta">
          <div><span className="num">2,841</span> threads delivered this quarter</div>
          <div className="visual-meta-sep" />
          <div>SOC 2 Type II · ISO 27001</div>
        </div>
      </div>
    </div>
  );
}
