'use client';

import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';

const INTEGRATIONS = [
  {
    name: 'Gamma',
    desc: 'AI-drafts proposals from approved scope + price.',
    status: 'pending' as const,
    sprint: 'sprint 7',
    color: 'oklch(0.55 0.18 320)',
    glyph: 'G',
  },
  {
    name: 'Odoo',
    desc: 'Pulls historical quotes for ML training; pushes finalised engagements.',
    status: 'pending' as const,
    sprint: 'sprint 8',
    color: 'oklch(0.5 0.16 270)',
    glyph: 'O',
  },
  {
    name: 'Slack',
    desc: 'Approval cards + thread fan-out to channels you choose.',
    status: 'pending' as const,
    sprint: 'sprint 6',
    color: 'oklch(0.6 0.2 30)',
    glyph: 'S',
  },
  {
    name: 'Microsoft Teams',
    desc: 'Incoming-webhook rich cards (inline actions in v1.1).',
    status: 'pending' as const,
    sprint: 'sprint 8',
    color: 'oklch(0.5 0.16 280)',
    glyph: 'T',
  },
  {
    name: 'Postmark',
    desc: 'Transactional email for thread events + proposal delivery.',
    status: 'configured' as const,
    sprint: 'sprint 4',
    color: 'oklch(0.58 0.16 50)',
    glyph: 'P',
  },
  {
    name: 'AWS S3 / MinIO',
    desc: 'Per-tenant encrypted storage for client-uploaded files.',
    status: 'connected' as const,
    sprint: 'sprint 3',
    color: 'oklch(0.4 0.05 50)',
    glyph: 'S3',
  },
];

export default function IntegrationsPage() {
  const user = useRequireAuth();
  if (!user) return null;
  return (
    <AppShell crumbs={[{ label: 'Connections' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Connections</h1>
            <p className="page-subtitle">External services Rhud talks to. Each one is a real OAuth-or-API integration; the indicator reflects today&apos;s state.</p>
          </div>
        </div>

        <div className="integ-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {INTEGRATIONS.map((it) => (
            <div key={it.name} className="integ" style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '16px 18px',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
            }}>
              <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: it.color, color: '#fff',
                display: 'grid', placeItems: 'center',
                flexShrink: 0,
                fontWeight: 700, fontSize: 14,
              }}>
                {it.glyph}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13.5 }}>{it.name}</div>
                <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>{it.desc}</div>
                <div style={{ marginTop: 6, display: 'inline-flex', gap: 6 }}>
                  <StatusChip status={it.status} sprint={it.sprint} />
                </div>
              </div>
              <button className="btn sm">
                {it.status === 'connected' || it.status === 'configured' ? 'Manage' : 'Connect'}
              </button>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}

function StatusChip({ status, sprint }: { status: 'connected' | 'configured' | 'pending'; sprint: string }) {
  if (status === 'connected') {
    return <span className="chip ok"><Icon.Check size={10} />Connected</span>;
  }
  if (status === 'configured') {
    return <span className="chip ok"><Icon.Check size={10} />Configured</span>;
  }
  return <span className="chip warn"><Icon.Clock size={10} />{sprint}</span>;
}
