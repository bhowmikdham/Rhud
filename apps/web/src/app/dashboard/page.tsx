'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { opportunities, type EngagementSummary } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

const FUNNEL_STAGES = [
  { id: 'in_progress',      label: 'Scope gathering',   color: 'var(--accent)' },
  { id: 'pending_approval', label: 'Awaiting approval', color: 'var(--warn)' },
  { id: 'drafting',         label: 'Drafting',          color: 'var(--fg-muted)' },
  { id: 'sent',             label: 'Delivered',         color: 'var(--ok)' },
] as const;

export default function DashboardPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<EngagementSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    opportunities.list().then(setItems).catch((e) => setErr(String(e)));
  }, [user]);

  const firstName = user ? user.email.split('@')[0]?.split('.')[0] ?? '' : '';

  const open = items?.filter((e) => !['sent', 'closed', 'rejected', 'expired'].includes(e.status)) ?? [];
  const awaitingApproval = items?.filter((e) => e.status === 'pending_approval') ?? [];
  const submittedThisWeek = items?.filter((e) => {
    if (!e.submittedAt) return false;
    const now = Date.now();
    return now - new Date(e.submittedAt).getTime() < 7 * 86_400_000;
  }) ?? [];
  const recent = items?.slice(0, 5) ?? [];

  const funnelCounts = FUNNEL_STAGES.map((s) => {
    if (s.id === 'sent') return { ...s, count: items?.filter((e) => ['sent', 'closed'].includes(e.status)).length ?? 0 };
    return { ...s, count: items?.filter((e) => e.status === s.id).length ?? 0 };
  });
  const funnelMax = Math.max(...funnelCounts.map((f) => f.count), 1);

  return (
    <AppShell crumbs={[{ label: 'Dashboard' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Good {timeOfDay()}{firstName && `, ${capitalize(firstName)}`}</h1>
            <p className="page-subtitle">
              You have <b style={{ color: 'var(--fg)' }}>{open.length} open opportunit{open.length === 1 ? 'y' : 'ies'}</b>
              {awaitingApproval.length > 0 && (
                <>
                  , <b style={{ color: 'var(--warn)' }}>{awaitingApproval.length} waiting on approval</b>
                </>
              )}
              .
            </p>
          </div>
          <div className="page-actions">
            <Link href="/opportunities/new" className="btn accent">
              <Icon.Plus size={13} />
              New opportunity
            </Link>
          </div>
        </div>

        {err && (
          <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>
        )}

        <div className="stat-grid">
          <Stat label="Open opportunities" value={items === null ? '…' : String(open.length)} />
          <Stat label="Awaiting approval" value={items === null ? '…' : String(awaitingApproval.length)} tone={awaitingApproval.length > 0 ? 'warn' : 'default'} />
          <Stat label="Submitted this week" value={items === null ? '…' : String(submittedThisWeek.length)} />
          <Stat label="Total opportunities" value={items === null ? '…' : String(items.length)} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 12, marginBottom: 24 }}>
          <div className="card" style={{ padding: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>Pipeline by stage</h3>
                <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                  {items?.length ?? 0} total opportunities
                </div>
              </div>
              <Link href="/opportunities" className="btn sm ghost">
                View all <Icon.ArrowUpRight size={12} />
              </Link>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {funnelCounts.map((f) => (
                <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '140px 1fr 36px', alignItems: 'center', gap: 12 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>{f.label}</div>
                  <div style={{ height: 8, background: 'var(--bg-sunk)', borderRadius: 999, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.max(4, (f.count / funnelMax) * 100)}%`,
                      background: f.color,
                      borderRadius: 999,
                      transition: 'width .6s cubic-bezier(.22,.8,.3,1)',
                    }} />
                  </div>
                  <div className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: 'right' }}>{f.count}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="card" style={{ padding: 0 }}>
            <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--border)' }}>
              <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>Awaiting your action</h3>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>From across the workspace</div>
            </div>
            <div style={{ padding: '4px 0', minHeight: 100 }}>
              {awaitingApproval.length === 0 ? (
                <div style={{ padding: '24px', color: 'var(--fg-subtle)', fontSize: 12.5, textAlign: 'center' }}>
                  Nothing waiting — you&apos;re all caught up.
                </div>
              ) : (
                awaitingApproval.slice(0, 5).map((e) => (
                  <Link key={e.id} href={`/opportunities/${e.id}`} style={{
                    display: 'grid', gridTemplateColumns: '1fr auto', gap: 10,
                    padding: '10px 18px', alignItems: 'center', textDecoration: 'none',
                  }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)' }}>{e.clientEmail}</div>
                      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}>{e.templateName}</div>
                    </div>
                    <Icon.ArrowUpRight size={12} style={{ color: 'var(--fg-subtle)' }} />
                  </Link>
                ))
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Recent opportunities</h2>
          <Link href="/opportunities" className="btn sm ghost">
            View all {items?.length ?? 0} <Icon.ArrowUpRight size={12} />
          </Link>
        </div>

        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Template</th>
                <th style={{ width: 180 }}>Stage</th>
                <th style={{ width: 140 }}>Updated</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {recent.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      No opportunities yet.{' '}
                      <Link href="/opportunities/new" style={{ color: 'var(--fg)' }}>Issue your first link →</Link>
                    </div>
                  </td>
                </tr>
              ) : recent.map((e) => (
                <tr key={e.id} onClick={() => location.assign(`/opportunities/${e.id}`)}>
                  <td className="cell-strong">{e.clientEmail}</td>
                  <td className="cell-muted" style={{ fontSize: 12.5 }}>{e.templateName}</td>
                  <td><StageChip stage={e.status} /></td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {new Date(e.submittedAt ?? e.createdAt).toLocaleString()}
                  </td>
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

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={tone === 'warn' && value !== '0' ? { color: 'var(--warn)' } : undefined}>{value}</div>
    </div>
  );
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 5) return 'evening';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
