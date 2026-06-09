'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';
import {
  describeError,
  gamma,
  integrations,
  type GammaConfig,
  type OutlookConnectionStatus,
  type OdooConnectionStatus,
} from '@/lib/api';
import { GammaConnectModal } from './gamma-modal';
import { OutlookSetupModal } from './outlook-modal';
import { OdooConnectModal } from './odoo-modal';

const INTEGRATIONS = [
  {
    key: 'gamma',
    name: 'Gamma',
    desc: 'Generates client-ready proposal decks from approved scope + price.',
    color: 'oklch(0.55 0.18 320)',
    glyph: 'G',
  },
  {
    key: 'outlook',
    name: 'Microsoft Outlook',
    desc: 'Send proposals from your own mailbox, with the PDF attached. One-click send from any opportunity.',
    color: '#0078d4',
    glyph: 'O',
  },
  {
    key: 'gmail',
    name: 'Gmail',
    desc: 'Same as Outlook, different provider. Coming next.',
    color: '#ea4335',
    glyph: 'G',
  },
  {
    key: 'odoo',
    name: 'Odoo',
    desc: 'Pulls historical quotes for ML training; pushes finalised engagements.',
    color: 'oklch(0.5 0.16 270)',
    glyph: 'O',
  },
  {
    key: 'slack',
    name: 'Slack',
    desc: 'Approval cards + thread fan-out to channels you choose.',
    color: 'oklch(0.6 0.2 30)',
    glyph: 'S',
  },
  {
    key: 'teams',
    name: 'Microsoft Teams',
    desc: 'Incoming-webhook rich cards (inline actions in v1.1).',
    color: 'oklch(0.5 0.16 280)',
    glyph: 'T',
  },
  {
    key: 'postmark',
    name: 'Postmark',
    desc: 'Transactional email for thread events + proposal delivery.',
    color: 'oklch(0.58 0.16 50)',
    glyph: 'P',
  },
  {
    key: 's3',
    name: 'AWS S3 / MinIO',
    desc: 'Per-tenant encrypted storage for client-uploaded files.',
    color: 'oklch(0.4 0.05 50)',
    glyph: 'S3',
  },
] as const;

type IntegrationKey = (typeof INTEGRATIONS)[number]['key'];

export default function IntegrationsPage() {
  return (
    <Suspense fallback={null}>
      <IntegrationsInner />
    </Suspense>
  );
}

function IntegrationsInner() {
  const user = useRequireAuth();
  const search = useSearchParams();
  const router = useRouter();
  const confirm = useConfirm();

  const [gammaCfg, setGammaCfg] = useState<GammaConfig | null | 'unset'>(null);
  const [showGamma, setShowGamma] = useState(false);

  const [outlook, setOutlook] = useState<OutlookConnectionStatus | null>(null);
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [showOutlookSetup, setShowOutlookSetup] = useState(false);
  const [odoo, setOdoo] = useState<OdooConnectionStatus | null>(null);
  const [showOdooSetup, setShowOdooSetup] = useState(false);
  const [banner, setBanner] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);

  // Pick up the OAuth round-trip result.
  useEffect(() => {
    const flag = search.get('outlook');
    if (!flag) return;
    if (flag === 'connected') {
      const mailbox = search.get('mailbox');
      setBanner({
        tone: 'ok',
        text: mailbox
          ? `Outlook connected — proposals will send from ${mailbox}.`
          : 'Outlook connected.',
      });
    } else if (flag === 'error') {
      const reason = search.get('reason') ?? 'Unknown error';
      setBanner({ tone: 'danger', text: `Outlook connect failed: ${reason}` });
    }
    router.replace('/integrations');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const refreshOutlook = useCallback(() => {
    integrations.outlook.status().then(setOutlook).catch(() => setOutlook(null));
  }, []);

  const refreshOdoo = useCallback(() => {
    integrations.odoo.status().then(setOdoo).catch(() => setOdoo(null));
  }, []);

  useEffect(() => {
    if (!user) return;
    gamma.get().then((c) => setGammaCfg(c ?? 'unset')).catch(() => setGammaCfg('unset'));
    refreshOutlook();
    refreshOdoo();
  }, [user, refreshOutlook, refreshOdoo]);

  if (!user) return null;
  const isAdmin = user.role === 'admin';
  // Template-library mutate actions are open to admins + sales managers
  // (the panel gates the manage controls on this flag); everyone else views.
  const canManageGamma = user.role === 'admin' || user.role === 'sales_manager';

  async function connectOutlook() {
    if (outlookBusy) return;
    setOutlookBusy(true);
    try {
      const { url } = await integrations.outlook.authorizeUrl();
      window.location.href = url;
    } catch (e) {
      setBanner({ tone: 'danger', text: describeError(e) });
      setOutlookBusy(false);
    }
  }

  async function disconnectOutlook() {
    if (outlookBusy) return;
    const ok = await confirm({
      title: 'Disconnect Outlook?',
      body: 'Proposals will fall back to opening your default mail app. You can reconnect any time.',
      tone: 'warn',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    setOutlookBusy(true);
    try {
      await integrations.outlook.disconnect();
      refreshOutlook();
    } catch (e) {
      setBanner({ tone: 'danger', text: describeError(e) });
    } finally {
      setOutlookBusy(false);
    }
  }

  function statusFor(key: IntegrationKey): { tone: 'connected' | 'configured' | 'pending'; label: string } {
    if (key === 'gamma') {
      if (gammaCfg === null) return { tone: 'pending', label: '…' };
      if (gammaCfg === 'unset') return { tone: 'pending', label: 'Not connected' };
      if (gammaCfg.apiKeySet && gammaCfg.enabled) {
        return { tone: 'connected', label: gammaCfg.proposalDriver === 'gamma' ? 'Connected — drafting' : 'Connected' };
      }
      return { tone: 'pending', label: 'Configured but disabled' };
    }
    if (key === 'outlook') {
      if (outlook == null) return { tone: 'pending', label: '…' };
      if (!outlook.available) {
        // Workspace admin hasn't set up the Microsoft app yet.
        // Customers see "Not yet set up"; admins see a Set up button
        // (rendered by actionFor) that opens the setup wizard.
        return { tone: 'pending', label: isAdmin ? 'Not set up yet' : 'Ask your admin to set this up' };
      }
      if (outlook.connected) {
        return {
          tone: 'connected',
          label: outlook.accountEmail ? `Connected — ${outlook.accountEmail}` : 'Connected',
        };
      }
      return { tone: 'pending', label: 'Not connected' };
    }
    if (key === 'odoo') {
      if (odoo == null) return { tone: 'pending', label: '…' };
      if (!odoo.configured) return { tone: 'pending', label: 'Not connected' };
      if (odoo.connected) {
        return {
          tone: 'connected',
          label: odoo.host ? `Connected — ${odoo.host}` : 'Connected',
        };
      }
      return { tone: 'pending', label: odoo.lastErrorMessage ? 'Connection error' : 'Configured' };
    }
    if (key === 'postmark') return { tone: 'configured', label: 'Console transport (dev)' };
    if (key === 's3') return { tone: 'connected', label: 'Connected' };
    return { tone: 'pending', label: 'Coming soon' };
  }

  function actionFor(key: IntegrationKey): React.ReactNode {
    if (key === 'gamma') {
      if (!isAdmin) {
        return <button className="btn sm" disabled style={{ opacity: 0.6 }}>Admin only</button>;
      }
      const isSet = gammaCfg && gammaCfg !== 'unset' && gammaCfg.apiKeySet;
      return <button className="btn sm" onClick={() => setShowGamma(true)}>{isSet ? 'Manage' : 'Connect'}</button>;
    }
    if (key === 'outlook') {
      if (outlook == null) return <button className="btn sm" disabled style={{ opacity: 0.6 }}>…</button>;
      if (!outlook.available) {
        // Setup is admin-only. Non-admins see a quiet placeholder.
        if (!isAdmin) {
          return <button className="btn sm" disabled style={{ opacity: 0.6 }}>Admin only</button>;
        }
        return (
          <button className="btn sm accent" onClick={() => setShowOutlookSetup(true)}>
            <Icon.Sparkle size={11} /> Set up
          </button>
        );
      }
      if (outlook.connected) {
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm ghost" disabled={outlookBusy} onClick={disconnectOutlook}>
              Disconnect
            </button>
            {isAdmin && (
              <button
                className="btn sm ghost"
                onClick={() => setShowOutlookSetup(true)}
                title="Update Microsoft app credentials for this workspace"
              >
                <Icon.Settings size={11} />
              </button>
            )}
          </div>
        );
      }
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm accent" disabled={outlookBusy} onClick={connectOutlook}>
            {outlookBusy ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Connect</>}
          </button>
          {isAdmin && (
            <button
              className="btn sm ghost"
              onClick={() => setShowOutlookSetup(true)}
              title="Update Microsoft app credentials for this workspace"
            >
              <Icon.Settings size={11} />
            </button>
          )}
        </div>
      );
    }
    if (key === 'odoo') {
      if (odoo == null) return <button className="btn sm" disabled style={{ opacity: 0.6 }}>…</button>;
      if (!isAdmin) {
        if (!odoo.configured) {
          return <button className="btn sm" disabled style={{ opacity: 0.6 }}>Admin only</button>;
        }
        return (
          <a className="btn sm ghost" href="/integrations/odoo">
            <Icon.Settings size={11} /> View
          </a>
        );
      }
      return (
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className={odoo.configured ? 'btn sm ghost' : 'btn sm accent'}
            onClick={() => setShowOdooSetup(true)}
          >
            {odoo.configured
              ? <><Icon.Settings size={11} /> Manage</>
              : <><Icon.ArrowUpRight size={11} /> Connect</>}
          </button>
          {odoo.configured && (
            <a className="btn sm ghost" href="/integrations/odoo" title="Field mapping + Odoo browser">
              <Icon.ArrowUpRight size={11} />
            </a>
          )}
        </div>
      );
    }
    return <button className="btn sm" disabled style={{ opacity: 0.6 }}>—</button>;
  }

  return (
    <AppShell crumbs={[{ label: 'Connections' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Connections</h1>
            <p className="page-subtitle">
              External services Rhud talks to. Manage Gamma + Outlook below; the rest light up as customers need them.
            </p>
          </div>
        </div>

        {banner && (
          <div className="card" style={{
            padding: 12, fontSize: 12.5, marginBottom: 16,
            background: banner.tone === 'ok' ? 'var(--ok-tint)' : 'var(--danger-tint)',
            color: banner.tone === 'ok' ? 'var(--ok)' : 'var(--danger)',
            borderColor: banner.tone === 'ok'
              ? 'color-mix(in oklch, var(--ok) 22%, transparent)'
              : 'color-mix(in oklch, var(--danger) 22%, transparent)',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            {banner.tone === 'ok' ? <Icon.Check size={12} /> : <Icon.X size={12} />}
            <span style={{ flex: 1 }}>{banner.text}</span>
            <button className="btn sm ghost" onClick={() => setBanner(null)}><Icon.X size={11} /></button>
          </div>
        )}

        <div className="integ-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
          {INTEGRATIONS.map((it) => {
            const st = statusFor(it.key);
            return (
              <div key={it.key} className="integ" style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: '16px 18px',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-lg)',
              }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 10,
                  background: it.color, color: '#fff',
                  display: 'grid', placeItems: 'center', flexShrink: 0,
                  fontWeight: 700, fontSize: 14,
                }}>
                  {it.glyph}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{it.name}</div>
                  <div style={{ color: 'var(--fg-muted)', fontSize: 12, marginTop: 2 }}>{it.desc}</div>
                  <div style={{ marginTop: 6, display: 'inline-flex', gap: 6 }}>
                    <StatusChip tone={st.tone} label={st.label} />
                  </div>
                </div>
                {actionFor(it.key)}
              </div>
            );
          })}
        </div>

        {showGamma && <GammaConnectModal canManage={canManageGamma} onClose={() => {
          setShowGamma(false);
          gamma.get().then((c) => setGammaCfg(c ?? 'unset')).catch(() => undefined);
        }} />}

        {showOutlookSetup && (
          <OutlookSetupModal
            onClose={() => setShowOutlookSetup(false)}
            onChanged={refreshOutlook}
          />
        )}

        {showOdooSetup && (
          <OdooConnectModal
            onClose={() => setShowOdooSetup(false)}
            onChanged={refreshOdoo}
          />
        )}
      </div>
    </AppShell>
  );
}

function StatusChip({ tone, label }: { tone: 'connected' | 'configured' | 'pending'; label: string }) {
  if (tone === 'connected') return <span className="chip ok"><Icon.Check size={10} />{label}</span>;
  if (tone === 'configured') return <span className="chip ok"><Icon.Check size={10} />{label}</span>;
  return <span className="chip warn"><Icon.Clock size={10} />{label}</span>;
}
