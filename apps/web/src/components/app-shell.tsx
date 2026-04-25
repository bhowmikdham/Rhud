'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';
import { Icon } from './icon';

interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof Icon;
  match?: (pathname: string) => boolean;
}

const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: 'Home' },
  { href: '/engagements', label: 'Engagements', icon: 'Thread', match: (p) => p.startsWith('/engagements') },
  { href: '/templates', label: 'Templates', icon: 'FileText', match: (p) => p.startsWith('/templates') },
];

const AGENT_NAV: NavItem[] = [
  { href: '/audit', label: 'Audit chain', icon: 'Shield' },
];

const SETTINGS_NAV: NavItem[] = [
  { href: '/settings', label: 'Settings', icon: 'Settings' },
];

interface ShellProps {
  children: React.ReactNode;
  /**
   * Breadcrumb path for the topbar. The last entry is rendered as `current`.
   * Pages that have a complex header pass `crumbs={[]}` and render their own.
   */
  crumbs?: Array<{ label: string; href?: string }>;
  /** Right-side topbar actions (e.g. "New engagement" button). */
  topbarActions?: React.ReactNode;
}

export function AppShell({ children, crumbs = [], topbarActions }: ShellProps) {
  const pathname = usePathname() ?? '/';
  const { user, signOut } = useAuth();

  const initials = user ? user.email.slice(0, 2).toUpperCase() : '··';
  const role = user?.role.replace('_', ' ') ?? '';

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
        {PRIMARY_NAV.map((n) => (
          <NavLink key={n.href} item={n} active={isActive(pathname, n)} />
        ))}

        <div className="nav-section">Agent</div>
        {AGENT_NAV.map((n) => (
          <NavLink key={n.href} item={n} active={isActive(pathname, n)} />
        ))}

        <div className="nav-section">Settings</div>
        {SETTINGS_NAV.map((n) => (
          <NavLink key={n.href} item={n} active={isActive(pathname, n)} />
        ))}

        <div className="sidebar-spacer" />
        <div className="sidebar-bottom">
          <button
            type="button"
            className="sidebar-user"
            onClick={signOut}
            title="Sign out"
            style={{ width: '100%', appearance: 'none', border: 0, background: 'transparent', textAlign: 'left' }}
          >
            <div className="avatar sm">{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="sidebar-user-name">{user?.email ?? 'Not signed in'}</div>
              <div className="sidebar-user-role">{role}</div>
            </div>
            <Icon.ChevronDown size={12} style={{ color: 'var(--fg-subtle)' }} />
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          {crumbs.length > 0 && (
            <div className="crumbs">
              {crumbs.map((c, i) => {
                const isLast = i === crumbs.length - 1;
                const sep = i > 0 && (
                  <span className="sep">
                    <Icon.ChevronRight size={12} />
                  </span>
                );
                if (c.href && !isLast) {
                  return (
                    <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {sep}
                      <Link href={c.href} className="crumb">{c.label}</Link>
                    </span>
                  );
                }
                return (
                  <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    {sep}
                    <span className={'crumb' + (isLast ? ' current' : '')}>{c.label}</span>
                  </span>
                );
              })}
            </div>
          )}
          <div className="topbar-spacer" />
          {topbarActions}
        </div>

        <div className="page">{children}</div>
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
    </Link>
  );
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.match) return item.match(pathname);
  return pathname === item.href;
}
