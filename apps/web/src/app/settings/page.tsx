'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';
import { useAuth, useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { Toggle } from '@/components/toggle';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';
import {
  tenant as tenantApi,
  team,
  llm,
  describeError,
  type InviteSummary,
  type LlmConfig,
  type LlmProviderName,
  type Role,
  type UserSummary,
} from '@/lib/api';

const TABS = [
  { id: 'account',       label: 'Account',        icon: 'User' as const },
  { id: 'workspace',     label: 'Workspace',      icon: 'Globe' as const },
  { id: 'team',          label: 'Team',           icon: 'Users' as const },
  { id: 'ai',            label: 'AI',             icon: 'Sparkles' as const },
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
  const { tenant } = useAuth();
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
            <p className="page-subtitle">
              Manage your account, workspace, and how Rhud works
              {tenant?.name ? ` for ${tenant.name}` : ''}.
            </p>
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
            {tab === 'workspace' && <WorkspacePanel isAdmin={user.role === 'admin'} />}
            {tab === 'team' && <TeamPanel currentUserId={user.sub} isAdmin={user.role === 'admin'} />}
            {tab === 'ai' && <AiPanel isAdmin={user.role === 'admin'} />}
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

function WorkspacePanel({ isAdmin }: { isAdmin: boolean }) {
  const { tenant, refreshTenant } = useAuth();
  // Local form state mirrors the cached tenant; on Save we PATCH and
  // the auth context refresh broadcasts the new name to AppShell.
  const [name, setName] = useState(tenant?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(tenant?.name ?? '');
  }, [tenant?.name]);

  const dirty = name.trim() !== (tenant?.name ?? '').trim();

  async function save() {
    if (!dirty || busy) return;
    setBusy(true); setErr(null); setSaved(false);
    try {
      await tenantApi.update({ name: name.trim() });
      await refreshTenant();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const initial = (tenant?.name ?? 'W').slice(0, 1).toUpperCase();

  return (
    <>
      {!isAdmin && (
        <div className="card" style={{
          padding: '10px 14px', fontSize: 12, color: 'var(--fg-muted)',
          marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
          background: 'var(--bg-sunk)',
        }}>
          <Icon.Lock size={12} style={{ color: 'var(--fg-subtle)' }} />
          Read-only — only admins can edit workspace settings.
        </div>
      )}

      <SectionCard
        title="Workspace"
        desc={tenant?.name ? `Visible to everyone in ${tenant.name}.` : 'Visible to everyone in this workspace.'}
      >
        <Row label="Logo" sub="Coming soon — file uploads aren't wired yet.">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="workspace-avatar" style={{ width: 48, height: 48, fontSize: 18, borderRadius: 10 }}>{initial}</div>
            <button className="btn sm" disabled>Upload</button>
          </div>
        </Row>
        <Row label="Workspace name" sub="Shown in the sidebar, on invites, and on client-facing links.">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!isAdmin || busy}
            maxLength={120}
            style={{ maxWidth: 360 }}
          />
        </Row>
        <Row label="Plan" sub="Contact sales to change.">
          <span className="chip outline" style={{ fontSize: 11 }}>{tenant?.plan ?? '—'}</span>
        </Row>
        <Row label="Workspace id" sub="Reference this if you ever need to contact support." last>
          <code style={{ fontSize: 12, padding: '6px 10px', background: 'var(--bg-sunk)', borderRadius: 6 }}>
            {tenant?.id ?? '—'}
          </code>
        </Row>
      </SectionCard>

      {err && (
        <div className="card" style={{
          padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
          background: 'var(--danger-tint)',
          borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
        }}>{err}</div>
      )}

      {isAdmin && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12, alignItems: 'center' }}>
          {saved && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Icon.Check size={12} /> Saved</span>}
          <button className="btn ghost" disabled={!dirty || busy} onClick={() => setName(tenant?.name ?? '')}>
            Reset
          </button>
          <button className="btn accent" disabled={!dirty || busy || !name.trim()} onClick={save}>
            {busy ? <span className="spin" /> : <><Icon.Check size={12} /> Save changes</>}
          </button>
        </div>
      )}
    </>
  );
}

// ─── Team ─────────────────────────────

const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  sales_manager: 'Sales manager',
  sales_employee: 'Sales rep',
  tech_team: 'Tech team',
};

function TeamPanel({ currentUserId, isAdmin }: { currentUserId: string; isAdmin: boolean }) {
  const confirm = useConfirm();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [invites, setInvites] = useState<InviteSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setErr(null);
    Promise.all([team.listUsers(), team.listInvites()])
      .then(([u, i]) => { setUsers(u); setInvites(i); })
      .catch((e) => setErr(describeError(e)));
  }, []);

  useEffect(() => {
    if (!isAdmin) {
      setUsers([]);
      setInvites([]);
      return;
    }
    refresh();
  }, [isAdmin, refresh]);

  async function changeRole(id: string, role: Role) {
    setBusyId(id);
    setErr(null);
    try {
      await team.updateUserRole(id, role);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function removeUser(id: string, email: string) {
    const ok = await confirm({
      title: `Remove ${email}?`,
      body: `They lose access immediately. If they have open engagements assigned, the removal will fail and you'll need to reassign first.`,
      tone: 'danger',
      confirmLabel: 'Remove user',
    });
    if (!ok) return;
    setBusyId(id);
    setErr(null);
    try {
      await team.removeUser(id);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function resendInvite(id: string) {
    setBusyId(id);
    setErr(null);
    try {
      const res = await team.resendInvite(id);
      if (res.devToken) {
        setDevLink(`${window.location.origin}/accept-invite?token=${res.devToken}`);
      }
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  async function revokeInvite(id: string, email: string) {
    const ok = await confirm({
      title: `Revoke pending invite?`,
      body: <>The invite link sent to <b>{email}</b> will stop working. You can re-invite them later.</>,
      tone: 'warn',
      confirmLabel: 'Revoke invite',
    });
    if (!ok) return;
    setBusyId(id);
    setErr(null);
    try {
      await team.revokeInvite(id);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusyId(null);
    }
  }

  const pending = invites?.filter((i) => i.status === 'pending') ?? [];

  return (
    <>
      {!isAdmin && (
        <div className="card" style={{ padding: '12px 16px', marginBottom: 16, fontSize: 12.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-sunk)' }}>
          <Icon.Lock size={12} style={{ color: 'var(--fg-subtle)' }} />
          Read-only — only admins can manage the team.
        </div>
      )}

      {err && (
        <div className="card" style={{
          padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
          background: 'var(--danger-tint)',
          borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
        }}>{err}</div>
      )}

      {devLink && (
        <div className="card" style={{
          padding: 12, fontSize: 12, marginBottom: 16,
          background: 'var(--accent-tint)',
          borderColor: 'color-mix(in oklch, var(--accent) 22%, transparent)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          <div style={{ fontWeight: 600 }}>Dev mode — invite link (email transport is console)</div>
          <code style={{ fontSize: 11.5, padding: '6px 8px', background: 'var(--bg)', borderRadius: 6, wordBreak: 'break-all' }}>{devLink}</code>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn sm" onClick={() => navigator.clipboard.writeText(devLink)}>
              <Icon.Copy size={11} /> Copy
            </button>
            <button className="btn sm ghost" onClick={() => setDevLink(null)}>Dismiss</button>
          </div>
        </div>
      )}

      <SectionCard
        title="Members"
        desc={users === null ? 'Loading…' : `${users.length} member${users.length === 1 ? '' : 's'} in this workspace.`}
        actions={isAdmin ? <button className="btn accent" onClick={() => setShowInvite(true)}><Icon.Plus size={12} />Invite</button> : null}
      >
        <div style={{ padding: '4px 0 0' }}>
          {users === null ? (
            <div className="empty" style={{ padding: 24 }}>Loading…</div>
          ) : users.length === 0 ? (
            <div className="empty" style={{ padding: 24 }}>No members yet.</div>
          ) : users.map((u, i) => {
            const initials = u.email.slice(0, 2).toUpperCase();
            const isSelf = u.id === currentUserId;
            return (
              <div
                key={u.id}
                style={{
                  display: 'grid', gridTemplateColumns: '32px 1fr 200px 32px', gap: 14,
                  padding: '12px 0', alignItems: 'center',
                  borderBottom: i === users.length - 1 ? 'none' : '1px solid var(--divider)',
                  opacity: busyId === u.id ? 0.5 : 1,
                }}
              >
                <div className="avatar" style={{ background: roleColor(u.role) }}>{initials}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {u.email.split('@')[0]}
                    {isSelf && <span className="chip outline" style={{ fontSize: 10 }}>You</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{u.email}</div>
                </div>
                {isAdmin ? (
                  <select
                    className="input"
                    value={u.role}
                    disabled={busyId === u.id}
                    onChange={(e) => changeRole(u.id, e.target.value as Role)}
                    style={{ height: 28, fontSize: 12, padding: '0 8px' }}
                  >
                    {(['admin', 'sales_manager', 'sales_employee', 'tech_team'] as Role[]).map((r) => (
                      <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                    ))}
                  </select>
                ) : (
                  <span className={'chip ' + (u.role === 'admin' ? 'accent' : u.role === 'sales_manager' ? 'warn' : 'outline')}>
                    {ROLE_LABELS[u.role]}
                  </span>
                )}
                {isAdmin && !isSelf ? (
                  <button
                    type="button"
                    onClick={() => removeUser(u.id, u.email)}
                    disabled={busyId === u.id}
                    title="Remove user"
                    style={{ appearance: 'none', border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--fg-subtle)', padding: 4 }}
                  >
                    <Icon.X size={14} />
                  </button>
                ) : <span />}
              </div>
            );
          })}
        </div>
      </SectionCard>

      {isAdmin && (
        <SectionCard title="Pending invites" desc={pending.length === 0 ? 'No invites awaiting acceptance.' : `${pending.length} awaiting acceptance.`}>
          {pending.length === 0 ? (
            <div style={{ padding: 18, fontSize: 12, color: 'var(--fg-subtle)' }}>
              When you invite someone, they appear here until they sign up.
            </div>
          ) : pending.map((p, i, arr) => (
            <Row
              key={p.id}
              label={p.email}
              sub={`Invited ${new Date(p.createdAt).toLocaleDateString()} · ${ROLE_LABELS[p.role]} · expires ${new Date(p.expiresAt).toLocaleDateString()}`}
              last={i === arr.length - 1}
            >
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn sm ghost" disabled={busyId === p.id} onClick={() => resendInvite(p.id)}>
                  Resend
                </button>
                <button className="btn sm ghost" disabled={busyId === p.id} onClick={() => revokeInvite(p.id, p.email)}>
                  Revoke
                </button>
              </div>
            </Row>
          ))}
        </SectionCard>
      )}

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onCreated={(devToken) => {
            if (devToken) setDevLink(`${window.location.origin}/accept-invite?token=${devToken}`);
            refresh();
          }}
        />
      )}
    </>
  );
}

function InviteModal({ onClose, onCreated }: { onClose(): void; onCreated(devToken?: string): void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('sales_employee');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await team.createInvite({ email, role });
      onCreated(res.devToken);
      onClose();
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  return (
    <Portal>
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div className="card" style={{ width: '100%', maxWidth: 440, background: 'var(--bg)' }}>
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Invite a teammate</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              They&apos;ll get an email with a link to set a password.
            </div>
          </div>
          <button onClick={onClose} disabled={busy} className="btn sm ghost"><Icon.X size={11} /></button>
        </header>
        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Email</span>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@yourcompany.com"
              autoFocus
              style={{ height: 32, padding: '0 10px', fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Role</span>
            <select
              className="input"
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              style={{ height: 32, padding: '0 10px', fontSize: 13 }}
            >
              <option value="sales_employee">Sales rep — can issue links and create opportunities</option>
              <option value="tech_team">Tech team — can adjust the predicted price before manager approval</option>
              <option value="sales_manager">Sales manager — adds approvals, edits templates</option>
              <option value="admin">Admin — manages team, rate cards, integrations</option>
            </select>
          </label>
          {err && (
            <div style={{
              padding: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8, fontSize: 12,
            }}>{err}</div>
          )}
        </div>
        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} disabled={busy} className="btn sm ghost">Cancel</button>
          <button onClick={submit} disabled={busy || !email} className="btn sm accent">
            {busy ? <span className="spin" /> : <><Icon.Send size={11} /> Send invite</>}
          </button>
        </footer>
      </div>
    </div>
    </Portal>
  );
}

// ─── AI ─────────────────────────────

interface ProviderPreset {
  value: LlmProviderName;
  label: string;
  blurb: string;
  defaultModel: string;
  /** When false, baseUrl input is hidden (provider has a fixed default). */
  baseUrlEditable: boolean;
  baseUrlPlaceholder?: string;
  /** False for self-hosted (Ollama) — no key needed. */
  apiKeyRequired: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'manual',
    label: 'Manual — use any AI you already have',
    blurb: 'No API, no setup. We compose the prompt, you paste it into ChatGPT / Claude / Gemini, paste the answer back. Works with any subscription you already pay for.',
    defaultModel: 'manual',
    baseUrlEditable: false,
    apiKeyRequired: false,
  },
  {
    value: 'anthropic',
    label: 'Anthropic — Claude',
    blurb: 'Highest narrative quality, best tool use. Bring an Anthropic API key.',
    defaultModel: 'claude-sonnet-4-6',
    baseUrlEditable: false,
    apiKeyRequired: true,
  },
  {
    value: 'openai',
    label: 'OpenAI — GPT',
    blurb: 'GPT-4o family. Bring an OpenAI API key.',
    defaultModel: 'gpt-4o-mini',
    baseUrlEditable: false,
    apiKeyRequired: true,
  },
  {
    value: 'ollama',
    label: 'Ollama (self-hosted)',
    blurb: 'Run a local model on your own machine. No API key — your data never leaves the host.',
    defaultModel: 'llama3.1:8b',
    baseUrlEditable: true,
    baseUrlPlaceholder: 'http://localhost:11434/v1',
    apiKeyRequired: false,
  },
  {
    value: 'openai_compat',
    label: 'OpenAI-compatible (BYO endpoint)',
    blurb: 'Azure OpenAI, Together, OpenRouter, vLLM, llama.cpp — anything that speaks the OpenAI chat API.',
    defaultModel: '',
    baseUrlEditable: true,
    baseUrlPlaceholder: 'https://your-endpoint.example.com/v1',
    apiKeyRequired: true,
  },
];

function AiPanel({ isAdmin }: { isAdmin: boolean }) {
  const confirm = useConfirm();
  const [config, setConfig] = useState<LlmConfig | null | 'unset'>(null);
  const [provider, setProvider] = useState<LlmProviderName>('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const preset = PROVIDER_PRESETS.find((p) => p.value === provider)!;

  useEffect(() => {
    if (!isAdmin) {
      setConfig('unset');
      return;
    }
    llm.get()
      .then((c) => {
        if (c) {
          setConfig(c);
          setProvider(c.provider);
          setModel(c.model);
          setBaseUrl(c.baseUrl ?? '');
          setEnabled(c.enabled);
        } else {
          setConfig('unset');
        }
      })
      .catch((e) => {
        setErr(describeError(e));
        // Don't strand the panel on "Loading…" if the read itself failed —
        // surface the form so the admin can still try to set a config.
        setConfig('unset');
      });
  }, [isAdmin]);

  function selectProvider(next: LlmProviderName) {
    setProvider(next);
    setTestResult(null);
    const p = PROVIDER_PRESETS.find((x) => x.value === next)!;
    // Only seed defaults when the form is fresh (no model chosen) or when
    // the previous provider wasn't this one — avoids stomping a user's
    // typed model when they switch back and forth.
    if (!model || model === '') setModel(p.defaultModel);
    if (!p.baseUrlEditable) setBaseUrl('');
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setTestResult(null);
    try {
      const dto = {
        provider,
        model: model.trim(),
        baseUrl: preset.baseUrlEditable ? (baseUrl.trim() || null) : null,
        enabled,
        // undefined = leave existing key alone; non-empty = update
        ...(apiKey.trim().length > 0 && { apiKey: apiKey.trim() }),
      };
      const updated = await llm.upsert(dto);
      setConfig(updated);
      setApiKey('');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (busy) return;
    setBusy(true);
    setTestResult(null);
    try {
      const r = await llm.test();
      if (r.ok) setTestResult({ ok: true, message: `Reply: "${r.sample ?? ''}"` });
      else setTestResult({ ok: false, message: r.error ?? 'unknown error' });
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('llm_key_decryption_failed')) {
        setTestResult({
          ok: false,
          message: 'The stored API key can\'t be decrypted (the server\'s master key changed). Paste the key in the API key field above and click Save.',
        });
      } else {
        setTestResult({ ok: false, message: msg });
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    const ok = await confirm({
      title: 'Clear the stored API key?',
      body: `You'll need to re-enter it before any AI feature works again. The encrypted bytes are wiped from disk.`,
      tone: 'danger',
      confirmLabel: 'Clear key',
    });
    if (!ok) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await llm.upsert({ provider, model, baseUrl: baseUrl || null, apiKey: '' });
      setConfig(updated);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <div className="card" style={{ padding: '12px 16px', fontSize: 12.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg-sunk)' }}>
        <Icon.Lock size={12} style={{ color: 'var(--fg-subtle)' }} />
        Read-only — only admins can configure AI.
      </div>
    );
  }

  if (config === null) return <div className="empty" style={{ padding: 40 }}>Loading…</div>;

  return (
    <>
      {err && (
        <div className="card" style={{
          padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
          background: 'var(--danger-tint)',
          borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
        }}>{err}</div>
      )}

      {config === 'unset' && (
        <div className="card" style={{
          padding: '14px 18px', marginBottom: 16,
          background: 'var(--accent-tint)',
          borderColor: 'color-mix(in oklch, var(--accent) 22%, transparent)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            <Icon.Sparkles size={13} /> No API? We got you.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
            Use any AI you already pay for — ChatGPT, Claude, Gemini, Perplexity. We compose the prompt,
            you paste it in, paste the answer back. <b>That&apos;s it.</b>{' '}
            Want hands-off automation instead? Bring an API key (Anthropic, OpenAI, OpenRouter)
            or run a local model with Ollama.
          </div>
        </div>
      )}

      <SectionCard
        title="AI provider"
        desc="Pick how Rhud talks to a language model. Manual mode (recommended for non-technical teams) needs nothing but the AI you already use."
      >
        <div style={{ padding: '14px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {PROVIDER_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => selectProvider(p.value)}
              style={{
                appearance: 'none', cursor: 'pointer', textAlign: 'left',
                padding: '12px 14px', borderRadius: 10,
                border: '1.5px solid ' + (provider === p.value ? 'var(--accent)' : 'var(--border)'),
                background: provider === p.value ? 'var(--accent-tint)' : 'var(--bg)',
                display: 'flex', flexDirection: 'column', gap: 4,
                transition: 'border-color .15s, background .15s',
              }}
            >
              <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                {provider === p.value && <Icon.Check size={11} style={{ color: 'var(--accent)' }} />}
                {p.label}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.4 }}>
                {p.blurb}
              </div>
            </button>
          ))}
        </div>

        {provider !== 'manual' && (
          <Row label="Model" sub="Provider-specific model id.">
            <input
              className="input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={preset.defaultModel || 'model-name'}
              style={{ maxWidth: 360, fontSize: 13 }}
            />
          </Row>
        )}

        {preset.baseUrlEditable && (
          <Row
            label="Base URL"
            sub={
              preset.value === 'ollama'
                ? 'Ollama\'s OpenAI-compatible endpoint. Default works if Ollama is on the same host.'
                : 'Full base URL up to /v1, e.g. https://api.example.com/v1.'
            }
          >
            <input
              className="input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrlPlaceholder}
              style={{ maxWidth: 480, fontSize: 13 }}
            />
          </Row>
        )}

        {preset.apiKeyRequired && (
          <Row
            label="API key"
            sub={
              config !== 'unset' && config?.apiKeySet
                ? 'A key is on file (encrypted at rest). Leave blank to keep it; type a new value to replace.'
                : 'Required for this provider. Stored encrypted at rest with envelope encryption.'
            }
          >
            <div style={{ display: 'flex', gap: 6, maxWidth: 480, alignItems: 'center' }}>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={config !== 'unset' && config?.apiKeySet ? '••••••••• (unchanged)' : 'sk-…'}
                autoComplete="new-password"
                style={{ flex: 1, fontSize: 13 }}
              />
              {config !== 'unset' && config?.apiKeySet && (
                <button type="button" className="btn sm ghost" onClick={clearKey} disabled={busy}>
                  Clear
                </button>
              )}
            </div>
          </Row>
        )}

        <Row label="Enabled" sub="Master switch — when off, AI features fail closed." last>
          <Toggle value={enabled} onChange={setEnabled} />
        </Row>
      </SectionCard>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 }}>
        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
          {config !== 'unset' && (
            <>Last updated {new Date(config.updatedAt).toLocaleString()}</>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {provider !== 'manual' && (
            <button className="btn ghost" disabled={busy} onClick={test}>
              <Icon.Zap size={12} />
              {busy ? 'Working…' : 'Test connection'}
            </button>
          )}
          <button className="btn accent" disabled={busy || !model.trim()} onClick={save}>
            {busy ? <span className="spin" /> : <><Icon.Check size={12} /> Save</>}
          </button>
        </div>
      </div>

      {testResult && (
        <div
          className="card"
          style={{
            marginTop: 12, padding: 12, fontSize: 12.5,
            background: testResult.ok ? 'var(--ok-tint)' : 'var(--danger-tint)',
            color: testResult.ok ? 'var(--ok)' : 'var(--danger)',
            borderColor: testResult.ok
              ? 'color-mix(in oklch, var(--ok) 22%, transparent)'
              : 'color-mix(in oklch, var(--danger) 22%, transparent)',
          }}
        >
          <b>{testResult.ok ? 'Connection OK.' : 'Connection failed.'}</b>{' '}
          <span style={{ wordBreak: 'break-word' }}>{testResult.message}</span>
        </div>
      )}
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
    case 'tech_team':      return 'oklch(0.6 0.13 180)';
    default:               return 'var(--fg)';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
