'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth-context';
import { opportunities } from '@/lib/api';
import { Icon } from './icon';

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof Icon;
  match?: (pathname: string) => boolean;
  /** Optional dynamic badge — string or number. */
  badge?: string | number;
}

const PRIMARY_NAV_BASE: NavItem[] = [
  { href: '/dashboard',     label: 'Dashboard',     icon: 'Home' },
  { href: '/opportunities', label: 'Opportunities', icon: 'Thread',   match: (p) => p.startsWith('/opportunities') || p.startsWith('/engagements') },
  { href: '/clients',       label: 'Clients',       icon: 'Users' },
  { href: '/templates',     label: 'Templates',     icon: 'FileText', match: (p) => p.startsWith('/templates') },
];

const AGENT_NAV: NavItem[] = [
  { href: '/models',      label: 'Price models', icon: 'Brain' },
  { href: '/automations', label: 'Automations',  icon: 'Zap' },
  { href: '/audit',       label: 'Audit chain',  icon: 'Shield' },
];

const INTEGRATIONS_NAV: NavItem[] = [
  { href: '/integrations', label: 'Connections', icon: 'Globe' },
];

const SETTINGS_NAV: NavItem[] = [
  { href: '/settings', label: 'Settings', icon: 'Settings', match: (p) => p.startsWith('/settings') },
];

interface ShellProps {
  children: React.ReactNode;
  crumbs?: Array<{ label: string; href?: string }>;
  topbarActions?: React.ReactNode;
}

export function AppShell({ children, crumbs = [], topbarActions }: ShellProps) {
  const pathname = usePathname() ?? '/';
  const { user } = useAuth();

  const initials = user ? user.email.slice(0, 2).toUpperCase() : '··';
  const firstName = user?.email.split('@')[0]?.split('.')[0] ?? '';
  const role = user?.role.replace('_', ' ') ?? '';
  const userColor = roleColor(user?.role);

  // Active opportunities badge — counts anything not closed/sent/rejected/expired.
  const [openCount, setOpenCount] = useState<number | null>(null);
  useEffect(() => {
    if (!user) return;
    opportunities
      .list()
      .then((items) => {
        const open = items.filter(
          (e) => !['sent', 'closed', 'rejected', 'expired'].includes(e.status),
        ).length;
        setOpenCount(open);
      })
      .catch(() => setOpenCount(null));
  }, [user, pathname]);

  const primaryNav: NavItem[] = PRIMARY_NAV_BASE.map((n) =>
    n.href === '/opportunities' && openCount != null && openCount > 0
      ? { ...n, badge: openCount }
      : n,
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-head">
          <div className="logo-mark" aria-hidden />
          <div className="logo-wordmark">rhud</div>
        </div>

        <div className="workspace-switcher" title="Workspace">
          <div className="workspace-avatar">E</div>
          <div className="workspace-name">Everlane</div>
          <Icon.ChevronDown size={12} />
        </div>

        <div className="nav-section">Workspace</div>
        {primaryNav.map((n) => <NavLink key={n.href} item={n} active={isActive(pathname, n)} />)}

        <div className="nav-section">Agent</div>
        {AGENT_NAV.map((n) => <NavLink key={n.href} item={n} active={isActive(pathname, n)} />)}

        <div className="nav-section">Integrations</div>
        {INTEGRATIONS_NAV.map((n) => <NavLink key={n.href} item={n} active={isActive(pathname, n)} />)}

        <div className="nav-section">Settings</div>
        {SETTINGS_NAV.map((n) => <NavLink key={n.href} item={n} active={isActive(pathname, n)} />)}

        <div className="sidebar-spacer" />

        <div className="sidebar-bottom">
          <Link href="/settings" className="sidebar-user" style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="avatar sm" style={{ background: userColor }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sidebar-user-name">{firstName ? capitalize(firstName) : 'Not signed in'}</div>
              <div className="sidebar-user-role">{role}</div>
            </div>
            <Icon.ChevronDown size={12} style={{ color: 'var(--fg-subtle)' }} />
          </Link>
        </div>
      </aside>

      <div className="main">
        <Topbar crumbs={crumbs} topbarActions={topbarActions} pathname={pathname} />
        {/* `key={pathname}` remounts the wrapper on every route change so the
             route-enter animation replays. */}
        <div className="page" key={pathname}>
          <div className="route-enter">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Topbar({
  crumbs,
  topbarActions,
  pathname,
}: {
  crumbs: Array<{ label: string; href?: string }>;
  topbarActions?: React.ReactNode;
  pathname: string;
}) {
  const router = useRouter();
  const { user, signOut } = useAuth();
  const [menu, setMenu] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target || !wrapRef.current?.contains(target)) setMenu(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menu]);

  const initials = user ? user.email.slice(0, 2).toUpperCase() : '··';
  const firstName = user?.email.split('@')[0]?.split('.')[0] ?? '';
  const userColor = roleColor(user?.role);
  const role = user?.role.replace('_', ' ') ?? '';

  return (
    <div className="topbar">
      {crumbs.length > 0 && (
        <div className="crumbs" key={pathname}>
          {crumbs.map((c, i) => {
            const isLast = i === crumbs.length - 1;
            return (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {i > 0 && (
                  <span className="sep">
                    <Icon.ChevronRight size={12} />
                  </span>
                )}
                {c.href && !isLast ? (
                  <Link href={c.href} className="crumb">{c.label}</Link>
                ) : (
                  <span className={'crumb' + (isLast ? ' current' : '')}>{c.label}</span>
                )}
              </span>
            );
          })}
        </div>
      )}
      <div className="topbar-spacer" />
      {topbarActions}

      <div style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />

      <button
        type="button"
        aria-label="Notifications"
        style={{
          appearance: 'none', border: 0, background: 'transparent',
          width: 30, height: 30, borderRadius: 6,
          display: 'grid', placeItems: 'center', color: 'var(--fg-muted)',
          cursor: 'pointer', position: 'relative',
          transition: 'background .15s, color .15s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon.Bell size={15} />
        <span style={{
          position: 'absolute', top: 6, right: 7,
          width: 6, height: 6, borderRadius: 999,
          background: 'var(--warn)', border: '1.5px solid var(--bg)',
        }} />
      </button>

      <div ref={wrapRef} style={{ position: 'relative' }}>
        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          style={{
            appearance: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 8px 3px 3px',
            background: menu ? 'var(--bg-sunk)' : 'var(--bg)',
            border: '1px solid ' + (menu ? 'var(--border-strong)' : 'var(--border)'),
            borderRadius: 999,
            transition: 'background .15s, border-color .15s',
          }}
        >
          <div className="avatar sm" style={{ background: userColor, width: 22, height: 22, fontSize: 9.5 }}>
            {initials}
          </div>
          <div style={{ textAlign: 'left', lineHeight: 1.15 }}>
            <div style={{ fontSize: 11.5, fontWeight: 500 }}>{firstName ? capitalize(firstName) : '—'}</div>
            <div style={{ fontSize: 9.5, color: 'var(--fg-subtle)' }}>{role}</div>
          </div>
          <Icon.ChevronDown size={11} style={{ color: 'var(--fg-subtle)' }} />
        </button>

        {menu && user && (
          <div
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0,
              width: 240,
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              boxShadow: '0 10px 30px rgba(0,0,0,.08), 0 2px 6px rgba(0,0,0,.04)',
              padding: 6,
              zIndex: 100,
            }}
          >
            <div style={{ padding: '10px 10px 8px', borderBottom: '1px solid var(--divider)', marginBottom: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="avatar" style={{ background: userColor }}>{initials}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {firstName ? capitalize(firstName) : user.email}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {user.email}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 4, alignItems: 'center' }}>
                <span className="chip outline" style={{ fontSize: 10 }}>{role}</span>
                <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>· Everlane</span>
              </div>
            </div>

            {[
              { icon: <Icon.User size={13} />,   label: 'Account settings', tab: 'account' },
              { icon: <Icon.Globe size={13} />,  label: 'Workspace',        tab: 'workspace' },
              { icon: <Icon.Bell size={13} />,   label: 'Notifications',    tab: 'notifications' },
              { icon: <Icon.Shield size={13} />, label: 'Security',         tab: 'security' },
            ].map((m) => (
              <button
                key={m.label}
                type="button"
                onClick={() => { setMenu(false); router.push(`/settings?tab=${m.tab}`); }}
                style={{
                  appearance: 'none', border: 0, cursor: 'pointer',
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 10px', background: 'transparent',
                  fontSize: 12.5, color: 'var(--fg)', textAlign: 'left',
                  borderRadius: 6,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                <span style={{ color: 'var(--fg-subtle)' }}>{m.icon}</span>
                {m.label}
              </button>
            ))}
            <div style={{ borderTop: '1px solid var(--divider)', margin: '4px 0' }} />
            <button
              type="button"
              onClick={signOut}
              style={{
                appearance: 'none', border: 0, cursor: 'pointer',
                width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                padding: '7px 10px', background: 'transparent',
                fontSize: 12.5, color: 'var(--danger)', textAlign: 'left',
                borderRadius: 6,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--danger-tint)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >
              <Icon.LogOut size={13} />Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const I = Icon[item.icon];
  return (
    <Link href={item.href} className={'nav-item' + (active ? ' active' : '')}>
      <I size={15} />
      <span>{item.label}</span>
      {item.badge != null && <span className="badge num">{item.badge}</span>}
    </Link>
  );
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match) return item.match(pathname);
  return pathname === item.href;
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
