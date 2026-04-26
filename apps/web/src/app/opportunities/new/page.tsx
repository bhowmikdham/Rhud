'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { opportunities, templates, type IssuedLink, type Template } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { Toggle } from '@/components/toggle';

const TTL_OPTIONS: Array<[string, string, number]> = [
  ['24h', '24 hours', 1],
  ['7d', '7 days', 7],
  ['14d', '14 days', 14],
  ['30d', '30 days', 30],
];

export default function NewOpportunityPage() {
  const user = useRequireAuth();
  const router = useRouter();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [list, setList] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Step 1
  const [clientEmail, setClientEmail] = useState('');
  const [companyHint, setCompanyHint] = useState('');
  const [title, setTitle] = useState('');

  // Step 2
  const [templateId, setTemplateId] = useState('');
  const [ttlKey, setTtlKey] = useState<string>('7d');
  const [singleUse, setSingleUse] = useState(true);
  const [requireOtp, setRequireOtp] = useState(true);
  const [watermarkPii, setWatermarkPii] = useState(false);
  const [notifyEmail, setNotifyEmail] = useState(true);
  const [notifySlack, setNotifySlack] = useState(false);

  // Step 3
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    templates.list().then((all) => {
      const published = all.filter((t) => t.status === 'published');
      setList(published);
      if (published[0]) setTemplateId(published[0].id);
    }).catch((e) => setErr(String(e)));
  }, [user]);

  async function generate() {
    setErr(null);
    setBusy(true);
    try {
      const ttl = TTL_OPTIONS.find((t) => t[0] === ttlKey)?.[2] ?? 7;
      const r = await opportunities.issue({
        templateId,
        clientEmail,
        ...(title.trim() ? { name: title.trim() } : {}),
        expiresInDays: ttl,
      });
      setIssued(r);
      setStep(3);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'New' }]}>
      <div className="page-inner" style={{ maxWidth: 720 }}>
        <div style={{ marginBottom: 24 }}>
          <button className="btn ghost sm" onClick={() => router.push('/opportunities')}>
            <Icon.ChevronLeft size={13} /> Back
          </button>
        </div>

        <div className="page-header">
          <div>
            <h1 className="page-title">New opportunity</h1>
            <p className="page-subtitle">
              Issue a secure, single-use scoping link. The client opens it — no account required.
            </p>
          </div>
        </div>

        <Stepper step={step} />

        {err && (
          <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5, marginTop: 16 }}>
            {err}
          </div>
        )}

        {step === 1 && (
          <div className="card" style={{ padding: 28 }}>
            <div style={{ display: 'grid', gap: 16 }}>
              <Field label="Client company" hint="Surfaces prior opportunities with this company automatically.">
                <input className="input" value={companyHint} onChange={(e) => setCompanyHint(e.target.value)} placeholder="Northwind Analytics" />
              </Field>
              <Field label="Primary contact email" hint="The link will be scoped to this email on first open.">
                <input className="input" type="email" required value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} placeholder="alex@northwind.io" />
              </Field>
              <Field label="Opportunity name" hint="Short, internal — shown in the thread and dashboard.">
                <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Acme Q3 Security Assessment" />
              </Field>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 24 }}>
              <button className="btn" onClick={() => router.push('/opportunities')}>Cancel</button>
              <button className="btn accent" disabled={!clientEmail} onClick={() => setStep(2)}>
                Continue <Icon.ArrowRight size={12} />
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="card" style={{ padding: 28 }}>
            <div className="section-label" style={{ marginBottom: 12 }}>Scope template</div>
            <div style={{ display: 'grid', gap: 8 }}>
              {list === null && (
                <div style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>Loading templates…</div>
              )}
              {list !== null && list.length === 0 && (
                <div style={{
                  padding: '12px 14px', borderRadius: 8,
                  background: 'var(--warn-tint)', fontSize: 12.5, color: 'var(--fg-muted)',
                }}>
                  No published templates yet. <Link href="/templates" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>Publish one first</Link>.
                </div>
              )}
              {list?.map((t, i) => (
                <div key={t.id}
                  className={'choice ' + (templateId === t.id ? 'selected' : '')}
                  onClick={() => setTemplateId(t.id)}
                >
                  <div className="bullet" />
                  <div className="body">
                    <div className="label">
                      {t.name}
                      {i === 0 && (
                        <span className="chip accent" style={{ marginLeft: 8 }}>
                          <Icon.Sparkle size={9} /> Suggested
                        </span>
                      )}
                    </div>
                    <div className="desc">{t.serviceLine} · v{t.version}</div>
                  </div>
                </div>
              ))}
            </div>

            <hr className="hr" style={{ margin: '24px 0' }} />

            <div className="section-label" style={{ marginBottom: 12 }}>Security</div>
            <div style={{ display: 'grid', gap: 14 }}>
              <Field label="Link expiry" inline>
                <div className="persona-switcher" style={{
                  display: 'flex', alignItems: 'center', gap: 2, padding: 2,
                  background: 'var(--bg-sunk)', borderRadius: 7, border: '1px solid var(--border)',
                }}>
                  {TTL_OPTIONS.map(([v, l]) => (
                    <button key={v} type="button" onClick={() => setTtlKey(v)}
                      style={{
                        border: 0, background: ttlKey === v ? 'var(--bg-elev)' : 'transparent',
                        color: ttlKey === v ? 'var(--fg)' : 'var(--fg-muted)',
                        fontSize: 11.5, fontWeight: 500,
                        height: 22, padding: '0 10px', borderRadius: 5, cursor: 'pointer',
                        boxShadow: ttlKey === v ? 'var(--shadow-xs)' : 'none',
                      }}>
                      {l}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Single-use" inline hint="Link auto-revokes after first submission.">
                <Toggle value={singleUse} onChange={setSingleUse} />
              </Field>
              <Field label="Require email verification" inline hint="Client receives a 6-digit code (sprint 5+).">
                <Toggle value={requireOtp} onChange={setRequireOtp} />
              </Field>
              <Field label="Watermark PII in files" inline hint="Visible audit trail on downloaded docs.">
                <Toggle value={watermarkPii} onChange={setWatermarkPii} />
              </Field>
            </div>

            <hr className="hr" style={{ margin: '24px 0' }} />

            <div className="section-label" style={{ marginBottom: 12 }}>Notify on activity</div>
            <div style={{ display: 'grid', gap: 10 }}>
              <Field label={`Email me (${user.email})`} inline>
                <Toggle value={notifyEmail} onChange={setNotifyEmail} />
              </Field>
              <Field label="Slack #sales (when configured)" inline>
                <Toggle value={notifySlack} onChange={setNotifySlack} />
              </Field>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
              <button className="btn" onClick={() => setStep(1)}>
                <Icon.ChevronLeft size={12} /> Back
              </button>
              <button className="btn accent" onClick={generate} disabled={busy || !templateId}>
                {busy ? <span className="spin" /> : <Icon.Zap size={13} />}
                {busy ? 'Generating…' : 'Generate link'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && issued && (
          <div className="card" style={{ padding: 28 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
              <span className="chip ok"><Icon.Check size={10} />Live</span>
              <span className="chip"><Icon.Lock size={10} />AES-256 · scoped to {clientEmail}</span>
              <span className="chip"><Icon.Clock size={10} />Expires {new Date(issued.expiresAt).toLocaleDateString()}</span>
            </div>
            <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', margin: '12px 0 4px' }}>
              Link ready for {companyHint || clientEmail}
            </h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>
              A thread has been opened. Every event will land here, in your inbox, and (when configured) in Slack.
            </p>

            <div style={{
              marginTop: 20, padding: '14px 16px',
              border: '1px solid var(--border)', borderRadius: 10,
              background: 'var(--bg-sunk)',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
              <Icon.Link size={15} style={{ color: 'var(--fg-subtle)', flexShrink: 0 }} />
              <span className="mono" style={{ flex: 1, color: 'var(--fg)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {issued.url}
              </span>
              <button
                className="btn sm"
                onClick={() => {
                  navigator.clipboard.writeText(issued.url);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
              >
                {copied ? <><Icon.Check size={11} />Copied</> : <><Icon.Copy size={11} />Copy</>}
              </button>
            </div>

            <div style={{
              marginTop: 14, padding: '10px 12px',
              background: 'var(--warn-tint)',
              border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
              borderRadius: 8, fontSize: 12, color: 'var(--fg-muted)',
              display: 'flex', alignItems: 'flex-start', gap: 8,
            }}>
              <Icon.Lock size={12} style={{ color: 'var(--warn)', marginTop: 2, flexShrink: 0 }} />
              <span>The token is shown <b style={{ color: 'var(--fg)', fontWeight: 500 }}>only once</b>. We store an argon2id hash — if you lose the URL, revoke and reissue.</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginTop: 16 }}>
              <button className="btn" style={{ height: 36, justifyContent: 'center' }}>
                <Icon.Mail size={13} />Email to client
              </button>
              <button className="btn" style={{ height: 36, justifyContent: 'center' }} disabled>
                <Icon.Slack size={13} />Post to Slack
              </button>
              <button className="btn" style={{ height: 36, justifyContent: 'center' }}
                onClick={() => navigator.clipboard.writeText(`Hi — here's a secure link to scope ${title || 'your opportunity'}: ${issued.url}`)}
              >
                <Icon.Copy size={13} />Copy rich message
              </button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24 }}>
              <Link href={`/g/${issued.token}`} className="btn ghost" target="_blank">
                <Icon.Eye size={13} />Preview client view
              </Link>
              <Link href={`/opportunities/${issued.engagementId}`} className="btn accent">
                Open opportunity thread <Icon.ArrowRight size={12} />
              </Link>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const labels = ['Client', 'Scope template', 'Share link'] as const;
  return (
    <div style={{ display: 'flex', gap: 0, marginBottom: 24, alignItems: 'center' }}>
      {labels.map((s, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = step > n;
        const active = step === n;
        return (
          <div key={s} style={{ display: 'flex', alignItems: 'center', flex: i < 2 ? 1 : 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 22, height: 22, borderRadius: 999,
                background: done ? 'var(--fg)' : active ? 'var(--accent)' : 'var(--bg-sunk)',
                border: '1px solid ' + (done ? 'var(--fg)' : active ? 'var(--accent)' : 'var(--border)'),
                color: done || active ? 'var(--bg)' : 'var(--fg-subtle)',
                display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600,
              }}>
                {done ? <Icon.Check size={11} /> : n}
              </div>
              <span style={{
                fontSize: 12.5, fontWeight: active ? 600 : 500,
                color: active || done ? 'var(--fg)' : 'var(--fg-muted)',
                whiteSpace: 'nowrap',
              }}>{s}</span>
            </div>
            {i < 2 && <div style={{ flex: 1, height: 1, background: 'var(--border)', margin: '0 12px' }} />}
          </div>
        );
      })}
    </div>
  );
}

function Field({
  label, hint, inline, children,
}: { label: string; hint?: string; inline?: boolean; children: React.ReactNode }) {
  if (inline) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
          {hint && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>{hint}</div>}
        </div>
        {children}
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 5 }}>{hint}</div>}
    </div>
  );
}
