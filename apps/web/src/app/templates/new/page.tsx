'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { templates } from '@/lib/api';
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

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const t = await templates.create({ name, serviceLine });
      router.push(`/templates/${t.id}`);
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: 'New' }]}>
      <div className="page-inner" style={{ maxWidth: 520 }}>
        <div className="page-header">
          <div>
            <h1 className="page-title">New template</h1>
            <p className="page-subtitle">Create a service-line-specific decision tree. Add nodes after the template exists.</p>
          </div>
        </div>

        {err && <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16 }}>{err}</div>}

        <div className="card" style={{ padding: 22 }}>
          <form onSubmit={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="Service line" hint="e.g. Web App Dev, Cloud Migration">
              <input required className="input" value={serviceLine} onChange={(e) => setServiceLine(e.target.value)} placeholder="Web App Dev" />
            </Field>
            <Field label="Template name" hint="Visible to admins; never to clients">
              <input required className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Greenfield SaaS scoping" />
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
