'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { Toggle } from '@/components/toggle';

const TABS = [
  { id: 'account',       label: 'Account',        icon: 'User' as const },
  { id: 'workspace',     label: 'Workspace',      icon: 'Globe' as const },
  { id: 'team',          label: 'Team',           icon: 'Users' as const },
  { id: 'notifications', label: 'Notifications',  icon: 'Bell' as const },
  { id: 'security',      label: 'Security',       icon: 'Shield' as const },
  { id: 'billing',       label: 'Billing',        icon: 'CreditCard' as const },
  { id: 'api',           label: 'API & webhooks', icon: 'Code' as const },
] as const;

type TabId = (typeof TABS)[number]['id'];

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsInner />
    </Suspense>
  );
}

function SettingsInner() {
  const user = useRequireAuth();
  const search = useSearchParams();
  const router = useRouter();
  const initialTab = (search.get('tab') as TabId | null) ?? 'account';
  const [tab, setTab] = useState<TabId>(initialTab);

  useEffect(() => {
    const next = search.get('tab') as TabId | null;
    if (next && next !== tab) setTab(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  function selectTab(t: TabId) {
    setTab(t);
    router.replace(`/settings?tab=${t}`);
  }

  if (!user) return null;

  return (
    <AppShell crumbs={[{ label: 'Settings' }]}>
      <div className="page-inner wide">
        <div className="page-header">
          <div>
            <h1 className="page-title">Settings</h1>
            <p className="page-subtitle">Manage your account, workspace, and how Rhud works for Everlane.</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 28, alignItems: 'start' }}>
          <aside style={{ position: 'sticky', top: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {TABS.map((t) => {
              const I = Icon[t.icon];
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => selectTab(t.id)}
                  style={{
                    appearance: 'none', cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 10px',
                    background: active ? 'var(--bg-sunk)' : 'transparent',
                    color: active ? 'var(--fg)' : 'var(--fg-muted)',
                    border: 0, borderRadius: 6,
                    fontSize: 12.5, fontWeight: active ? 500 : 400,
                    textAlign: 'left',
                    transition: 'background .15s, color .15s',
                  }}
                >
                  <span style={{ color: active ? 'var(--fg)' : 'var(--fg-subtle)' }}>
                    <I size={14} />
                  </span>
                  {t.label}
                </button>
              );
            })}
          </aside>

          <div style={{ minWidth: 0 }}>
            {tab === 'account' && <AccountPanel email={user.email} role={user.role} />}
            {tab === 'workspace' && <WorkspacePanel />}
            {tab === 'team' && <TeamPanel />}
            {tab === 'notifications' && <NotificationsPanel />}
            {tab === 'security' && <SecurityPanel />}
            {tab === 'billing' && <BillingPanel />}
            {tab === 'api' && <ApiPanel />}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

// ─── Section helpers ─────────────────────────────

function Row({ label, sub, children, last }: {
  label: React.ReactNode;
  sub?: React.ReactNode;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <div
      style={{
        display: 'grid', gridTemplateColumns: '240px 1fr', gap: 32,
        padding: '16px 0',
        borderBottom: last ? 'none' : '1px solid var(--divider)',
        alignItems: 'flex-start',
      }}
    >
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {sub && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.4 }}>{sub}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SectionCard({ title, desc, children, actions }: {
  title: string;
  desc?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="card" style={{ padding: '4px 22px 22px', marginBottom: 20 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '18px 0 14px', borderBottom: '1px solid var(--divider)',
      }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, letterSpacing: '-0.005em' }}>{title}</h3>
          {desc && <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 3 }}>{desc}</div>}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

// ─── Account ─────────────────────────────

function AccountPanel({ email, role }: { email: string; role: string }) {
  const initials = email.slice(0, 2).toUpperCase();
  const firstName = capitalize(email.split('@')[0]?.split('.')[0] ?? '');
  return (
    <>
      <SectionCard title="Profile" desc="How you appear to teammates and clients.">
        <Row label="Photo" sub="PNG or JPG, max 2 MB.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="avatar lg" style={{ background: roleColor(role), width: 52, height: 52, fontSize: 16 }}>
              {initials}
            </div>
            <button className="btn sm">Upload</button>
            <button className="btn sm ghost">Remove</button>
          </div>
        </Row>
        <Row label="Full name">
          <input className="input" defaultValue={firstName} style={{ maxWidth: 360 }} />
        </Row>
        <Row label="Email" sub="Used for sign-in and notifications.">
          <input className="input" defaultValue={email} style={{ maxWidth: 360 }} />
        </Row>
        <Row label="Role" sub="Permissions scoped to this role.">
          <select className="input" defaultValue={role} style={{ maxWidth: 220 }}>
            <option value="sales_employee">Sales employee</option>
            <option value="sales_manager">Sales manager</option>
            <option value="admin">Admin</option>
          </select>
        </Row>
        <Row label="Timezone" last>
          <select className="input" defaultValue="Europe/Berlin" style={{ maxWidth: 220 }}>
            <option>Europe/Berlin (UTC+1)</option>
            <option>America/New_York (UTC-5)</option>
            <option>Asia/Singapore (UTC+8)</option>
            <option>Australia/Melbourne (UTC+11)</option>
          </select>
        </Row>
      </SectionCard>

      <SectionCard title="Active sessions" desc="Sign out of devices you don't recognise.">
        {[
          { device: 'MacBook Pro · Chrome', where: 'Berlin, DE', when: 'Now · This device', current: true },
          { device: 'iPhone 15 · Rhud app', where: 'Berlin, DE', when: '2 hours ago', current: false },
          { device: 'Windows · Firefox', where: 'Munich, DE', when: '3 days ago', current: false },
        ].map((s, i, arr) => (
          <Row key={i} label={s.device} sub={`${s.where} · ${s.when}`} last={i === arr.length - 1}>
            {s.current ? (
              <span className="chip ok"><Icon.Check size={10} />Current session</span>
            ) : (
              <button className="btn sm ghost">Sign out</button>
            )}
          </Row>
        ))}
      </SectionCard>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn ghost">Cancel</button>
        <button className="btn accent">Save changes</button>
      </div>
    </>
  );
}

// ─── Workspace ─────────────────────────────

function WorkspacePanel() {
  return (
    <>
      <SectionCard title="Workspace" desc="Visible to everyone in Everlane.">
        <Row label="Logo">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="workspace-avatar" style={{ width: 48, height: 48, fontSize: 18, borderRadius: 10 }}>E</div>
            <button className="btn sm">Upload</button>
          </div>
        </Row>
        <Row label="Workspace name">
          <input className="input" defaultValue="Everlane Consulting" style={{ maxWidth: 360 }} />
        </Row>
        <Row label="Primary domain" sub="Clients will see this in email signatures.">
          <input className="input" defaultValue="everlane.test" style={{ maxWidth: 360 }} />
        </Row>
        <Row label="Default currency">
          <select className="input" defaultValue="USD" style={{ maxWidth: 160 }}>
            <option>USD — US Dollar</option>
            <option>EUR — Euro</option>
            <option>GBP — British Pound</option>
            <option>AUD — Australian Dollar</option>
          </select>
        </Row>
        <Row label="Fiscal year start" last>
          <select className="input" defaultValue="January" style={{ maxWidth: 160 }}>
            <option>January</option><option>April</option><option>July</option><option>October</option>
          </select>
        </Row>
      </SectionCard>

      <SectionCard title="Branding" desc="Applied to client-facing links and proposal documents.">
        <Row label="Accent color">
          <div style={{ display: 'flex', gap: 8 }}>
            {['oklch(0.52 0.14 265)', 'oklch(0.56 0.18 155)', 'oklch(0.58 0.2 30)', 'oklch(0.58 0.2 350)', '#111'].map((c, i) => (
              <button
                key={i}
                type="button"
                style={{
                  width: 28, height: 28, borderRadius: 999,
                  background: c,
                  border: i === 0 ? '2px solid var(--fg)' : '2px solid transparent',
                  outline: '1px solid var(--border)',
                  cursor: 'pointer',
                }}
              />
            ))}
          </div>
        </Row>
        <Row label="Proposal footer" sub="Appears on every generated proposal.">
          <textarea className="input" defaultValue="Everlane Consulting · Confidential · www.everlane.test" style={{ maxWidth: 480, minHeight: 60 }} />
        </Row>
        <Row label="Link preview domain" sub="Tokenised scope-gathering links are served from this host." last>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <code style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-sunk)', borderRadius: 6 }}>
              scope.everlane.test
            </code>
            <button className="btn sm ghost">Change</button>
          </div>
        </Row>
      </SectionCard>
    </>
  );
}

// ─── Team ─────────────────────────────

function TeamPanel() {
  const members = [
    { name: 'Maya Bernal',    role: 'Sales employee', email: 'maya@everlane.test',  initials: 'MB', color: 'oklch(0.62 0.14 250)', last: 'Active now' },
    { name: 'Oren Takeda',    role: 'Sales manager',  email: 'oren@everlane.test',  initials: 'OT', color: 'oklch(0.58 0.12 50)',  last: '8m ago' },
    { name: 'Priya Shah',     role: 'Sales employee', email: 'priya@everlane.test', initials: 'PS', color: 'oklch(0.62 0.16 180)', last: '1h ago' },
    { name: 'Jens Larsson',   role: 'Sales employee', email: 'jens@everlane.test',  initials: 'JL', color: 'oklch(0.6 0.14 90)',   last: 'Yesterday' },
    { name: 'Chloe Nakamura', role: 'Admin',          email: 'chloe@everlane.test', initials: 'CN', color: 'oklch(0.58 0.14 310)', last: '2 days ago' },
  ];
  return (
    <>
      <SectionCard
        title="Members"
        desc="5 of 15 seats used on the Business plan."
        actions={<button className="btn accent"><Icon.Plus size={12} />Invite</button>}
      >
        <div style={{ padding: '4px 0 0' }}>
          {members.map((m, i) => (
            <div
              key={m.email}
              style={{
                display: 'grid', gridTemplateColumns: '32px 1fr 140px 140px 24px', gap: 14,
                padding: '14px 0', alignItems: 'center',
                borderBottom: i === members.length - 1 ? 'none' : '1px solid var(--divider)',
              }}
            >
              <div className="avatar" style={{ background: m.color }}>{m.initials}</div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.email}</div>
              </div>
              <div>
                <span className={'chip ' + (m.role === 'Admin' ? 'accent' : m.role === 'Sales manager' ? 'warn' : 'outline')}>
                  {m.role}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>{m.last}</div>
              <button
                type="button"
                style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--fg-subtle)', padding: 4 }}
              >
                <Icon.MoreHorizontal size={14} />
              </button>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="Pending invites" desc="These people haven't accepted yet.">
        {[
          { email: 'olivia@everlane.test', sent: 'Yesterday', role: 'Sales employee' },
          { email: 'marco@everlane.test', sent: '3 days ago', role: 'Sales employee' },
        ].map((p, i, arr) => (
          <Row key={p.email} label={p.email} sub={`Invited ${p.sent} · ${p.role}`} last={i === arr.length - 1}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn sm ghost">Resend</button>
              <button className="btn sm ghost">Revoke</button>
            </div>
          </Row>
        ))}
      </SectionCard>
    </>
  );
}

// ─── Notifications ─────────────────────────────

function NotificationsPanel() {
  const groups: Array<{ title: string; rows: Array<[string, 'email' | 'slack', boolean]> }> = [
    { title: 'Engagement activity', rows: [
      ['Client submits a scope form', 'email', true],
      ['Client submits a scope form', 'slack', true],
      ['Rhud finishes a price prediction', 'email', false],
      ['Rhud finishes a price prediction', 'slack', true],
      ['Proposal drafted by Gamma', 'email', true],
      ['Proposal drafted by Gamma', 'slack', false],
      ['Client opens a proposal link', 'email', true],
      ['Client opens a proposal link', 'slack', false],
    ]},
    { title: 'Approvals', rows: [
      ['Your approval is requested', 'email', true],
      ['Your approval is requested', 'slack', true],
      ['Approval SLA at risk (>8h pending)', 'email', true],
      ['Approval SLA at risk (>8h pending)', 'slack', true],
    ]},
    { title: 'Digests', rows: [
      ['Daily morning digest', 'email', true],
      ['Weekly pipeline summary (Mondays)', 'email', true],
    ]},
  ];
  return (
    <>
      {groups.map((g) => (
        <SectionCard key={g.title} title={g.title}>
          {g.rows.map((r, i, arr) => (
            <NotificationRow key={i} label={r[0]} channel={r[1]} initial={r[2]} last={i === arr.length - 1} />
          ))}
        </SectionCard>
      ))}
    </>
  );
}

function NotificationRow({ label, channel, initial, last }: {
  label: string;
  channel: 'email' | 'slack';
  initial: boolean;
  last: boolean;
}) {
  const [v, setV] = useState(initial);
  return (
    <Row label={label} sub={channel === 'email' ? 'Email' : 'Slack — #sales-rhud'} last={last}>
      <Toggle value={v} onChange={setV} />
    </Row>
  );
}

// ─── Security ─────────────────────────────

function SecurityPanel() {
  return (
    <>
      <SectionCard title="Authentication">
        <Row label="Password" sub="Last changed 3 months ago.">
          <button className="btn sm">Change password</button>
        </Row>
        <Row label="Two-factor authentication" sub="Using Authenticator app.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="chip ok"><Icon.Check size={10} />Enabled</span>
            <button className="btn sm ghost">Manage</button>
          </div>
        </Row>
        <Row label="SSO" sub="Single sign-on with Okta, Google Workspace, or Azure AD." last>
          <button className="btn sm">Configure SSO</button>
        </Row>
      </SectionCard>

      <SectionCard title="Tokenised scope links" desc="Controls the security envelope Rhud uses when generating client links.">
        <Row label="Default expiry">
          <select className="input" defaultValue="7 days" style={{ maxWidth: 160 }}>
            <option>24 hours</option><option>3 days</option><option>7 days</option><option>14 days</option><option>30 days</option>
          </select>
        </Row>
        <SecurityToggle label="Require access code" sub="Client must enter a 6-digit code emailed separately." initial={true} />
        <SecurityToggle label="Single-use links" sub="Link invalidates after first submission." initial={false} />
        <SecurityToggle label="PII watermarking" sub="Client-downloaded files carry invisible audit watermarks." initial={false} last />
      </SectionCard>

      <SectionCard
        title="Audit log"
        desc="Every mutation in your workspace — searchable for 365 days."
        actions={<button className="btn sm"><Icon.Download size={12} />Export CSV</button>}
      >
        {[
          { who: 'Oren Takeda',     what: 'Approved ENG-2411 · $186,000',                       when: '14m ago',   ip: '194.44.*.*' },
          { who: 'Maya Bernal',     what: 'Generated tokenised link for Northwind Analytics',   when: '1h ago',    ip: '194.44.*.*' },
          { who: 'Rhud (agent)',    what: 'Ran price prediction · model v4.2',                  when: '1h ago',    ip: '—' },
          { who: 'Chloe Nakamura',  what: 'Rotated API key · rhk_live_***a29f',                 when: 'Yesterday', ip: '81.12.*.*' },
        ].map((l, i, arr) => (
          <Row key={i} label={l.what} sub={`${l.who} · ${l.ip}`} last={i === arr.length - 1}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', fontVariantNumeric: 'tabular-nums' }}>{l.when}</span>
          </Row>
        ))}
      </SectionCard>
    </>
  );
}

function SecurityToggle({ label, sub, initial, last = false }: { label: string; sub: string; initial: boolean; last?: boolean }) {
  const [v, setV] = useState(initial);
  return (
    <Row label={label} sub={sub} last={last}>
      <Toggle value={v} onChange={setV} />
    </Row>
  );
}

// ─── Billing ─────────────────────────────

function BillingPanel() {
  return (
    <>
      <SectionCard title="Plan" desc="You're on Business · annual.">
        <div style={{ padding: '16px 0', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
          {[
            { label: 'Monthly price', value: '$1,200', sub: 'per month, billed annually' },
            { label: 'Seats',         value: '5 / 15', sub: '10 seats available' },
            { label: 'Renews',        value: 'Feb 14, 2027', sub: '9 months away' },
          ].map((m) => (
            <div key={m.label} style={{ padding: 16, background: 'var(--bg-sunk)', borderRadius: 10 }}>
              <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>{m.label}</div>
              <div className="num" style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 6 }}>{m.value}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 2 }}>{m.sub}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
          <button className="btn">Change plan</button>
          <button className="btn ghost">Cancel subscription</button>
        </div>
      </SectionCard>

      <SectionCard title="Payment method">
        <Row label="Card on file" last>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{
              width: 42, height: 28, borderRadius: 4,
              background: 'linear-gradient(135deg, #1a1f71, #3e52c4)',
              color: '#fff', display: 'grid', placeItems: 'center',
              fontSize: 9, fontWeight: 700, letterSpacing: '0.05em',
            }}>VISA</div>
            <div>
              <div className="num" style={{ fontSize: 13 }}>•••• •••• •••• 4242</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>Expires 08/28 · Chloe Nakamura</div>
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn sm">Update</button>
          </div>
        </Row>
      </SectionCard>

      <SectionCard
        title="Invoices"
        actions={<button className="btn sm"><Icon.Download size={12} />Download all</button>}
      >
        {[
          { id: 'INV-2026-04', date: 'Apr 14, 2026', amount: '$1,200.00',  status: 'Paid' },
          { id: 'INV-2026-03', date: 'Mar 14, 2026', amount: '$1,200.00',  status: 'Paid' },
          { id: 'INV-2026-02', date: 'Feb 14, 2026', amount: '$14,400.00', status: 'Paid · Annual renewal' },
        ].map((inv, i, arr) => (
          <div
            key={inv.id}
            style={{
              display: 'grid', gridTemplateColumns: '120px 1fr 120px 1fr 24px', gap: 14,
              padding: '12px 0', alignItems: 'center',
              borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--divider)',
              fontSize: 12.5,
            }}
          >
            <span className="cell-mono">{inv.id}</span>
            <span style={{ color: 'var(--fg-muted)' }}>{inv.date}</span>
            <span className="num">{inv.amount}</span>
            <span><span className="chip ok"><Icon.Check size={10} />{inv.status}</span></span>
            <button
              type="button"
              style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--fg-subtle)' }}
            >
              <Icon.Download size={13} />
            </button>
          </div>
        ))}
      </SectionCard>
    </>
  );
}

// ─── API & webhooks ─────────────────────────────

function ApiPanel() {
  return (
    <>
      <SectionCard
        title="API keys"
        desc="Use these to call the Rhud API from your services."
        actions={<button className="btn accent"><Icon.Plus size={12} />New key</button>}
      >
        {[
          { name: 'Production', key: 'rhk_live_••••••••••••a29f', created: 'Feb 14, 2026', last: '4m ago' },
          { name: 'Staging',    key: 'rhk_test_••••••••••••7b01', created: 'Feb 14, 2026', last: 'Yesterday' },
        ].map((k, i, arr) => (
          <Row key={k.name} label={k.name} sub={`Created ${k.created} · Last used ${k.last}`} last={i === arr.length - 1}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <code style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-sunk)', borderRadius: 6 }}>{k.key}</code>
              <button className="btn sm ghost">Reveal</button>
              <button className="btn sm ghost">Rotate</button>
            </div>
          </Row>
        ))}
      </SectionCard>

      <SectionCard
        title="Webhooks"
        desc="We'll POST events to these endpoints."
        actions={<button className="btn sm"><Icon.Plus size={12} />Add endpoint</button>}
      >
        {[
          { url: 'https://ops.everlane.test/rhud/hooks',       events: 'engagement.created · engagement.approved · engagement.sent', status: 'Healthy' },
          { url: 'https://analytics.everlane.test/ingest',     events: 'engagement.won · engagement.rejected',                       status: 'Healthy' },
        ].map((w, i, arr) => (
          <Row
            key={w.url}
            label={<code style={{ fontSize: 12 }}>{w.url}</code>}
            sub={w.events}
            last={i === arr.length - 1}
          >
            <span className="chip ok"><Icon.Check size={10} />{w.status}</span>
          </Row>
        ))}
      </SectionCard>
    </>
  );
}

function roleColor(role?: string): string {
  switch (role) {
    case 'sales_employee': return 'oklch(0.62 0.14 250)';
    case 'sales_manager':  return 'oklch(0.58 0.12 50)';
    case 'admin':          return 'oklch(0.6 0.12 340)';
    default:               return 'var(--fg)';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
