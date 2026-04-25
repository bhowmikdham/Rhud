'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { templates, type Template } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';

export default function TemplatesListPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    templates.list().then(setItems).catch((e) => setErr(String(e)));
  }, [user]);

  return (
    <AppShell crumbs={[{ label: 'Templates' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Templates</h1>
            <p className="page-subtitle">Decision-tree forms your sales team uses to gather scope. Branch by answer, attach files at any step.</p>
          </div>
          <div className="page-actions">
            <Link href="/templates/new" className="btn accent">
              <Icon.Plus size={13} />
              New template
            </Link>
          </div>
        </div>

        {err && <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16 }}>{err}</div>}

        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Service line</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 80 }}>Version</th>
                <th style={{ width: 160 }}>Updated</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {items === null && !err && <tr><td colSpan={6}><div className="empty">Loading…</div></td></tr>}
              {items?.length === 0 && (
                <tr><td colSpan={6}>
                  <div className="empty">
                    No templates yet. <Link href="/templates/new" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>Create one</Link>.
                  </div>
                </td></tr>
              )}
              {items?.map((t) => (
                <tr key={t.id} onClick={() => location.assign(`/templates/${t.id}`)}>
                  <td className="cell-strong">{t.name}</td>
                  <td className="cell-muted">{t.serviceLine}</td>
                  <td>
                    <span className={'chip ' + (t.status === 'published' ? 'ok' : t.status === 'archived' ? '' : 'warn')}>
                      <Icon.Dot size={8} />
                      {t.status}
                    </span>
                  </td>
                  <td className="cell-mono">v{t.version}</td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>{new Date(t.updatedAt).toLocaleString()}</td>
                  <td><Icon.ChevronRight size={14} style={{ color: 'var(--fg-faint)' }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}
