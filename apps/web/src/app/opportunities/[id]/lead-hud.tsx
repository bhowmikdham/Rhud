'use client';

/**
 * Lead HUD — a compact action-chip strip that lives in the opportunity
 * detail page's top bar. Each chip carries a glanceable signal
 * (risk level, open ticket count, next follow-up, Odoo sync state)
 * and opens a slide-in drawer with the full panel when clicked.
 *
 * Replaces the previous "stack four big cards in the body" layout —
 * vertical scroll drops dramatically and the workflow content
 * (pricing, approval, proposal) becomes the only thing competing
 * for the user's attention in the main column.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  describeError,
  followUps as followUpsApi,
  integrations,
  tickets as ticketsApi,
  type FollowUpRow,
  type OdooConnectionStatus,
  type OdooEntityLinkRow,
  type TicketRow,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { LeadManagementSection } from './lead-management';
import { OdooSyncCard } from './odoo-sync-card';
import { CategoryChip, ReviewerChip } from './classification-chips';

type Drawer = 'lead' | 'odoo' | null;
// Summary lives inline above the body now (LeadSummaryInline); the
// HUD only opens the operational lists (Tickets / Follow-ups) and
// the Odoo sync controls.
type LeadTab = 'tickets' | 'followups';

interface Props {
  engagementId: string;
  status: string;
  userRole: string;
  /** Phase B — current classification (from engagement detail). */
  classification?: {
    categorySlug: string | null;
    subCategorySlug: string | null;
    classifiedBy: 'llm' | 'manual' | null;
    classifiedAt: string | null;
  } | null;
  /** Phase B — current reviewer assignment. */
  assignedReviewerId?: string | null;
  /** Called when category or reviewer changes via the chips — let the
   *  parent refresh the engagement detail. */
  onClassificationChange?(): void;
}

export function LeadHud({
  engagementId, status, userRole,
  classification, assignedReviewerId,
  onClassificationChange,
}: Props) {
  // Compact glanceables for tickets / follow-ups / Odoo (summary
  // lives inline above the body — see LeadSummaryInline).
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpRow[] | null>(null);
  const [odoo, setOdoo] = useState<OdooConnectionStatus | null>(null);
  const [odooLink, setOdooLink] = useState<OdooEntityLinkRow | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [leadTab, setLeadTab] = useState<LeadTab>('tickets');

  const reload = useCallback(() => {
    ticketsApi.list(engagementId).then(setTickets).catch(() => setTickets([]));
    followUpsApi.list(engagementId).then(setFollowUps).catch(() => setFollowUps([]));
    integrations.odoo.status().then(setOdoo).catch(() => setOdoo(null));
    integrations.odoo.entityLinks(500).then((rows) => {
      const lead = rows.find(
        (r) => r.rhudEntity === 'engagement' && r.rhudId === engagementId && r.odooModel === 'crm.lead',
      );
      setOdooLink(lead ?? null);
    }).catch(() => setOdooLink(null));
  }, [engagementId]);

  useEffect(() => { reload(); }, [reload]);

  // Refetch on drawer close so any edits inside surface immediately
  // in the chips.
  function closeDrawer() {
    setDrawer(null);
    reload();
  }

  function openLeadDrawer(tab: LeadTab) {
    setLeadTab(tab);
    setDrawer('lead');
  }

  // Close drawer on Esc.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawer]);

  const openTickets = (tickets ?? []).filter((t) => t.status === 'open' || t.status === 'in_progress');
  const urgentTickets = openTickets.filter((t) => t.priority === 'urgent' || t.priority === 'high');
  const pendingFollowUps = (followUps ?? []).filter((f) => !f.completedAt);
  const overdueFollowUps = pendingFollowUps.filter((f) => f.overdue);
  const nextFollowUp = pendingFollowUps[0]; // service returns sorted

  const odooConfigured = !!odoo?.configured;

  return (
    <>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
          padding: '10px 24px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <CategoryChip
          engagementId={engagementId}
          userRole={userRole}
          classification={classification ?? null}
          onChange={() => onClassificationChange?.()}
        />
        <ReviewerChip
          engagementId={engagementId}
          userRole={userRole}
          assignedReviewerId={assignedReviewerId ?? null}
          onChange={() => onClassificationChange?.()}
        />
        <TicketsChip
          openCount={openTickets.length}
          urgent={urgentTickets.length > 0}
          onOpen={() => openLeadDrawer('tickets')}
        />
        <FollowUpsChip
          pending={pendingFollowUps.length}
          overdue={overdueFollowUps.length}
          next={nextFollowUp}
          onOpen={() => openLeadDrawer('followups')}
        />
        {odooConfigured && (
          <OdooChip
            link={odooLink}
            host={odoo?.host ?? null}
            connected={!!odoo?.connected}
            onOpen={() => setDrawer('odoo')}
          />
        )}
      </div>

      {drawer === 'lead' && (
        <SlideOverDrawer title={drawerTitle(leadTab)} onClose={closeDrawer}>
          <LeadManagementSection
            engagementId={engagementId}
            userRole={userRole}
            initialTab={leadTab}
          />
        </SlideOverDrawer>
      )}
      {drawer === 'odoo' && (
        <SlideOverDrawer title="Odoo CRM" onClose={closeDrawer}>
          <OdooSyncCard engagementId={engagementId} status={status} />
        </SlideOverDrawer>
      )}
    </>
  );
}

function drawerTitle(tab: LeadTab): string {
  if (tab === 'tickets') return 'Tickets & complaints';
  return 'Follow-ups';
}

// ── Chips ────────────────────────────────────────────────────────────

function ChipShell({
  onClick,
  tone,
  children,
}: {
  onClick(): void;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  children: React.ReactNode;
}) {
  const palette: Record<NonNullable<typeof tone>, { border: string; bg: string; fg: string }> = {
    default: { border: 'var(--border)', bg: 'var(--bg-elev)', fg: 'var(--fg)' },
    ok:      { border: 'color-mix(in oklch, var(--ok) 28%, transparent)', bg: 'var(--ok-tint)', fg: 'var(--ok)' },
    warn:    { border: 'color-mix(in oklch, var(--warn) 28%, transparent)', bg: 'var(--warn-tint)', fg: 'var(--warn)' },
    danger:  { border: 'color-mix(in oklch, var(--danger) 28%, transparent)', bg: 'var(--danger-tint)', fg: 'var(--danger)' },
  };
  const p = palette[tone ?? 'default'];
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '5px 10px',
        fontSize: 12, fontWeight: 500,
        background: p.bg,
        color: p.fg,
        border: `1px solid ${p.border}`,
        borderRadius: 999,
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

function TicketsChip({
  openCount,
  urgent,
  onOpen,
}: {
  openCount: number;
  urgent: boolean;
  onOpen(): void;
}) {
  if (openCount === 0) {
    return (
      <ChipShell tone="default" onClick={onOpen}>
        <Icon.Inbox size={11} />
        <span>No open tickets</span>
      </ChipShell>
    );
  }
  return (
    <ChipShell tone={urgent ? 'danger' : 'warn'} onClick={onOpen}>
      <Icon.Inbox size={11} />
      <span>{openCount} {openCount === 1 ? 'ticket' : 'tickets'} open</span>
      {urgent && <span style={{ fontSize: 10, fontWeight: 700 }}>· urgent</span>}
    </ChipShell>
  );
}

function FollowUpsChip({
  pending,
  overdue,
  next,
  onOpen,
}: {
  pending: number;
  overdue: number;
  next: FollowUpRow | undefined;
  onOpen(): void;
}) {
  if (pending === 0) {
    return (
      <ChipShell tone="default" onClick={onOpen}>
        <Icon.Clock size={11} />
        <span>No follow-ups</span>
      </ChipShell>
    );
  }
  if (overdue > 0) {
    return (
      <ChipShell tone="danger" onClick={onOpen}>
        <Icon.Clock size={11} />
        <span>{overdue} overdue</span>
      </ChipShell>
    );
  }
  return (
    <ChipShell tone="default" onClick={onOpen}>
      <Icon.Clock size={11} />
      <span>{nextFollowUpLabel(next)}</span>
      {pending > 1 && <span style={{ color: 'var(--fg-subtle)' }}>· {pending}</span>}
    </ChipShell>
  );
}

function nextFollowUpLabel(f: FollowUpRow | undefined): string {
  if (!f) return 'Follow-ups';
  const days = Math.ceil((new Date(f.scheduledFor).getTime() - Date.now()) / 86_400_000);
  if (days <= 0) return 'Due today';
  if (days === 1) return 'Due tomorrow';
  if (days <= 7) return `Due in ${days}d`;
  return `Due in ${Math.ceil(days / 7)}w`;
}

function OdooChip({
  link,
  host,
  connected,
  onOpen,
}: {
  link: OdooEntityLinkRow | null;
  host: string | null;
  connected: boolean;
  onOpen(): void;
}) {
  if (!link) {
    return (
      <ChipShell tone="default" onClick={onOpen}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 2,
          background: 'oklch(0.5 0.16 270)',
        }} />
        <span>Not synced to Odoo</span>
      </ChipShell>
    );
  }
  return (
    <ChipShell tone={connected ? 'ok' : 'warn'} onClick={onOpen}>
      <span style={{
        display: 'inline-block', width: 8, height: 8, borderRadius: 2,
        background: 'oklch(0.5 0.16 270)',
      }} />
      <span>Odoo · #{link.odooId}</span>
      {host && <span style={{ color: 'inherit', opacity: 0.65, fontSize: 11 }}>· {host}</span>}
    </ChipShell>
  );
}

// ── Slide-over drawer ────────────────────────────────────────────────

function SlideOverDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: React.ReactNode;
}) {
  // Force a single-frame render with `mounted=false` first so the
  // CSS transition has a starting state to animate from. Without this
  // the drawer just appears in place with no slide.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 'var(--z-drawer)',
          display: 'flex', justifyContent: 'flex-end',
          background: mounted ? 'color-mix(in oklch, black 35%, transparent)' : 'transparent',
          transition: 'background 180ms ease-out',
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <aside
          style={{
            width: 'min(560px, 92vw)',
            height: '100%',
            background: 'var(--bg)',
            borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            transform: mounted ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 220ms ease-out',
            boxShadow: '-12px 0 32px color-mix(in oklch, black 18%, transparent)',
          }}
        >
          <header style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
            <button className="btn sm ghost" onClick={onClose} aria-label="Close">
              <Icon.X size={11} />
            </button>
          </header>
          <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
            {children}
          </div>
        </aside>
      </div>
    </Portal>
  );
}
