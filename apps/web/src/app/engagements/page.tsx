'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { engagements, type EngagementSummary } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

type FilterId = 'all' | 'open' | 'pending_approval' | 'drafting' | 'sent';

export default function EngagementsListPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<EngagementSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!user) return;
    engagements.list().then(setItems).catch((e) => setErr(String(e)));
  }, [user]);

  const tabs: Array<{ id: FilterId; label: string; count: number }> = useMemo(() => {
    const all = items ?? [];
    return [
      { id: 'all', label: 'All', count: all.length },
      { id: 'open', label: 'Open', count: all.filter((e) => !['sent', 'closed', 'rejected', 'expired'].includes(e.status)).length },
      { id: 'pending_approval', label: 'Awaiting approval', count: all.filter((e) => e.status === 'pending_approval').length },
      { id: 'drafting', label: 'Drafting', count: all.filter((e) => e.status === 'drafting' || e.status === 'draft_ready').length },
      { id: 'sent', label: 'Delivered', count: all.filter((e) => ['sent', 'closed'].includes(e.status)).length },
    ];
  }, [items]);

  const filtered = useMemo(() => {
    const all = items ?? [];
    return all.filter((e) => {
      if (filter === 'open' && ['sent', 'closed', 'rejected', 'expired'].includes(e.status)) return false;
      if (filter === 'pending_approval' && e.status !== 'pending_approval') return false;
      if (filter === 'drafting' && !['drafting', 'draft_ready'].includes(e.status)) return false;
      if (filter === 'sent' && !['sent', 'closed'].includes(e.status)) return false;
      if (query) {
        const q = query.toLowerCase();
        const hay = (e.clientEmail + e.templateName + e.id).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, filter, query]);

  return (
    <AppShell crumbs={[{ label: 'Engagements' }]}>
      <div className="page-inner wide">
        <div className="page-header">
          <div>
            <h1 className="page-title">Engagements</h1>
            <p className="page-subtitle">Every active and completed scoping thread.</p>
          </div>
          <div className="page-actions">
            <Link href="/engagements/new" className="btn accent">
              <Icon.Plus size={13} />
              New engagement
            </Link>
          </div>
        </div>

        {err && <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16 }}>{err}</div>}

        {/* Tab strip */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          marginBottom: 14,
          borderBottom: '1px solid var(--border)', paddingBottom: 0,
        }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              style={{
                appearance: 'none', border: 0, background: 'transparent',
                padding: '8px 14px', marginBottom: -1,
                borderBottom: '2px solid ' + (filter === tab.id ? 'var(--fg)' : 'transparent'),
                color: filter === tab.id ? 'var(--fg)' : 'var(--fg-muted)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                transition: 'color .15s, border-color .15s',
              }}
            >
              {tab.label}
              <span style={{
                fontSize: 11, fontVariantNumeric: 'tabular-nums',
                padding: '1px 6px', borderRadius: 999,
                background: 'var(--bg-sunk)', color: 'var(--fg-subtle)',
              }}>{tab.count}</span>
            </button>
          ))}
          <div style={{ flex: 1 }} />
          <div style={{ position: 'relative', marginBottom: 6 }}>
            <Icon.Search size={13} style={{ position: 'absolute', left: 8, top: 8, color: 'var(--fg-subtle)' }} />
            <input
              className="input"
              placeholder="Search…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ paddingLeft: 28, height: 28, width: 220, fontSize: 12.5 }}
            />
          </div>
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 90 }}>ID</th>
                <th>Engagement</th>
                <th style={{ width: 180 }}>Stage</th>
                <th style={{ width: 110 }}>Updated</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {items === null && !err && (
                <tr><td colSpan={5}><div className="empty">Loading…</div></td></tr>
              )}
              {filtered.length === 0 && items !== null && (
                <tr><td colSpan={5}><div className="empty">No engagements match.</div></td></tr>
              )}
              {filtered.map((e) => (
                <tr key={e.id} onClick={() => location.assign(`/engagements/${e.id}`)}>
                  <td><span className="cell-mono">{e.id.slice(0, 8)}</span></td>
                  <td>
                    <div className="cell-strong">{e.clientEmail}</div>
                    <div className="cell-muted" style={{ fontSize: 12 }}>{e.templateName}</div>
                  </td>
                  <td><StageChip stage={e.status} /></td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>{relativeTime(e.submittedAt ?? e.createdAt)}</td>
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

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}
