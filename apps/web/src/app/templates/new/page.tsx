'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { templates, describeError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';

export default function NewTemplatePage() {
  const user = useRequireAuth();
  const router = useRouter();
  const [name, setName] = useState('');
  const [serviceLine, setServiceLine] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!user) return null;
  const canEdit = ['admin', 'sales_manager'].includes(user.role);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const t = await templates.create({ name, serviceLine });
      router.push(`/templates/${t.id}`);
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  if (!canEdit) {
    return (
      <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: 'New' }]}>
        <div className="page-inner" style={{ maxWidth: 520 }}>
          <div className="page-header">
            <div>
              <h1 className="page-title">New template</h1>
              <p className="page-subtitle">Decision-tree authoring is restricted to admins and sales managers.</p>
            </div>
          </div>
          <div
            className="card"
            style={{
              padding: 22, display: 'flex', alignItems: 'flex-start', gap: 14,
            }}
          >
            <div
              style={{
                width: 40, height: 40, borderRadius: 10,
                background: 'var(--warn-tint)', color: 'var(--warn)',
                display: 'grid', placeItems: 'center', flexShrink: 0,
              }}
            >
              <Icon.Lock size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Need a higher role</h3>
              <p style={{ margin: '6px 0 12px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                You&apos;re signed in as <b style={{ color: 'var(--fg)', fontWeight: 500 }}>{user.email}</b> ({user.role.replace('_', ' ')}).
                Sales employees can browse and use templates but can&apos;t create or edit them. Ask an admin or sales manager
                to author the template, or have your role updated in Settings.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <Link href="/templates" className="btn">
                  <Icon.ChevronLeft size={12} /> Back to templates
                </Link>
                <Link href="/settings?tab=team" className="btn ghost">
                  Open Team settings
                </Link>
              </div>
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: 'New' }]}>
      <div className="page-inner" style={{ maxWidth: 520 }}>
        <div className="page-header">
          <div>
            <h1 className="page-title">New template</h1>
            <p className="page-subtitle">Create a service-line-specific decision tree. Add nodes after the template exists.</p>
          </div>
        </div>

        {err && (
          <div
            className="card"
            style={{
              padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
              background: 'var(--danger-tint)',
              borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
            }}
          >
            {err}
          </div>
        )}

        <div className="card" style={{ padding: 22 }}>
          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Service line" hint="e.g. Web App Dev, Cloud Migration">
              <input
                required
                className="input"
                value={serviceLine}
                onChange={(e) => setServiceLine(e.target.value)}
                placeholder="Web App Dev"
              />
            </Field>
            <Field label="Template name" hint="Visible to admins; never to clients">
              <input
                required
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Greenfield SaaS scoping"
              />
            </Field>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
              <button type="button" className="btn" onClick={() => router.push('/templates')}>Cancel</button>
              <button type="submit" className="btn accent" disabled={busy}>
                {busy ? <><span className="spin" /> Creating…</> : <><Icon.Plus size={12} /> Create</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AppShell>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-muted)', marginBottom: 6 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>{hint}</div>}
    </label>
  );
}
