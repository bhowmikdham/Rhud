'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { opportunities, describeError, type EngagementSummary } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';
import { SourceChip } from '@/components/source-chip';
import { RowActions } from '@/components/row-actions';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';

type FilterId = 'all' | 'open' | 'pending_approval' | 'drafting' | 'sent';
type ViewMode = 'list' | 'kanban';

/**
 * Lifecycle columns for the Kanban view. Each column collects one or
 * more raw statuses so the board reads as the rep sees the work — not
 * as the schema enumerates it. Order matters: earlier columns are the
 * earlier lifecycle stages, leftmost on screen.
 */
const KANBAN_COLUMNS: Array<{
  id: string;
  label: string;
  statuses: string[];
  hint: string;
  accent: string;
}> = [
  {
    id: 'discovery',
    label: 'Discovery',
    // 'ingesting' is the direct-ingest start state (files dropped,
    // extraction running, before it settles to 'submitted'). It must
    // live in the first column — mirrors the detail page's stageOf(),
    // whose default branch treats ingesting as Discovery. Omitting it
    // here is what hid freshly-uploaded opportunities from the board.
    statuses: ['ingesting', 'issued', 'in_progress'],
    hint: 'Intake & scoping',
    accent: 'oklch(0.62 0.14 250)',
  },
  {
    id: 'submitted',
    label: 'Pricing',
    // Reviewer holds (returned_to_sales / awaiting_clarification /
    // escalated) sit over the pricing stage — matches stageOf(), which
    // maps them to stage 'pricing' with a hold side-state. The card's
    // StageChip still spells out the specific hold.
    statuses: ['submitted', 'predicted', 'returned_to_sales', 'awaiting_clarification', 'escalated'],
    hint: 'Scope in, price computed',
    accent: 'oklch(0.6 0.13 180)',
  },
  {
    id: 'approval',
    label: 'Awaiting approval',
    // Tiered sign-offs (VP / CEO) are still "awaiting approval" — keep
    // them in this column alongside the manager-level pending_approval.
    statuses: ['pending_approval', 'pending_vp_approval', 'pending_ceo_approval'],
    hint: 'Manager review',
    accent: 'oklch(0.7 0.14 80)',
  },
  {
    id: 'approved',
    label: 'Approved',
    statuses: ['approved'],
    hint: 'Ready to draft',
    accent: 'oklch(0.65 0.14 150)',
  },
  {
    id: 'drafting',
    label: 'Proposal',
    statuses: ['drafting', 'draft_ready'],
    hint: 'Drafting & ready to send',
    accent: 'oklch(0.6 0.12 340)',
  },
  {
    id: 'delivered',
    label: 'Delivered',
    statuses: ['sent', 'closed'],
    hint: 'Sent to client',
    accent: 'oklch(0.6 0.14 160)',
  },
];

const ARCHIVED_STATUSES = new Set(['rejected', 'expired', 'lost']);

export default function OpportunitiesListPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<EngagementSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [query, setQuery] = useState('');
  const [pendingDelete, setPendingDelete] = useState<EngagementSummary | null>(null);
  const [view, setView] = useState<ViewMode>('list');

  const canDelete = user?.role === 'admin' || user?.role === 'sales_manager';

  function refresh() {
    setErr(null);
    opportunities.list().then(setItems).catch((e) => setErr(describeError(e)));
  }

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user]);

  // Restore saved view preference. Defaults to list — the table is the
  // existing default, and we don't want to surprise people on first load.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem('rhud.opportunities.view');
    if (stored === 'kanban' || stored === 'list') setView(stored);
  }, []);

  function changeView(next: ViewMode) {
    setView(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('rhud.opportunities.view', next);
    }
  }

  const tabs: Array<{ id: FilterId; label: string; count: number }> = useMemo(() => {
    const all = items ?? [];
    return [
      { id: 'all', label: 'All', count: all.length },
      { id: 'open', label: 'Open', count: all.filter((e) => !['sent', 'closed', 'rejected', 'expired', 'lost'].includes(e.status)).length },
      { id: 'pending_approval', label: 'Awaiting approval', count: all.filter((e) => e.status === 'pending_approval').length },
      { id: 'drafting', label: 'Drafting', count: all.filter((e) => e.status === 'drafting' || e.status === 'draft_ready').length },
      { id: 'sent', label: 'Delivered', count: all.filter((e) => ['sent', 'closed'].includes(e.status)).length },
    ];
  }, [items]);

  const filtered = useMemo(() => {
    const all = items ?? [];
    return all.filter((e) => {
      if (filter === 'open' && ['sent', 'closed', 'rejected', 'expired', 'lost'].includes(e.status)) return false;
      if (filter === 'pending_approval' && e.status !== 'pending_approval') return false;
      if (filter === 'drafting' && !['drafting', 'draft_ready'].includes(e.status)) return false;
      if (filter === 'sent' && !['sent', 'closed'].includes(e.status)) return false;
      if (query) {
        const q = query.toLowerCase();
        // templateName is null for direct-ingest opportunities; fall back
        // to an empty string so the search still works on email + id.
        const hay = (e.clientEmail + (e.templateName ?? '') + (e.name ?? '') + e.id).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, filter, query]);

  const archivedCount = useMemo(
    () => (items ?? []).filter((e) => ARCHIVED_STATUSES.has(e.status)).length,
    [items],
  );

  return (
    <AppShell crumbs={[{ label: 'Opportunities' }]}>
      <div className="page-inner wide">
        <div className="page-header">
          <div>
            <h1 className="page-title">Opportunities</h1>
            <p className="page-subtitle">Every active and completed sales conversation.</p>
          </div>
          <div className="page-actions">
            <Link href="/opportunities/new" className="btn accent">
              <Icon.Plus size={13} />
              New opportunity
            </Link>
          </div>
        </div>

        {err && <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16 }}>{err}</div>}

        {/* Tab strip + view toggle + search */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 2,
          marginBottom: 14,
          borderBottom: '1px solid var(--border)', paddingBottom: 0,
          flexWrap: 'wrap',
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
          <ViewToggle view={view} onChange={changeView} />
          <div style={{ position: 'relative', marginBottom: 6, marginLeft: 8 }}>
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

        {pendingDelete && (
          <DeleteConfirmModal
            title="Delete opportunity"
            subject={pendingDelete.name ?? pendingDelete.clientEmail}
            description={
              <>
                Removes the opportunity and everything attached: scope answers, files,
                thread events, the quote, predictions, and the gathering token. The client&apos;s
                gathering link will stop working.
              </>
            }
            confirmPhrase="delete"
            onCancel={() => setPendingDelete(null)}
            onConfirm={async () => {
              await opportunities.remove(pendingDelete.id);
              setPendingDelete(null);
              refresh();
            }}
          />
        )}

        {view === 'list' ? (
          <ListView
            items={items}
            filtered={filtered}
            canDelete={canDelete}
            onDelete={(e) => setPendingDelete(e)}
          />
        ) : (
          <KanbanView
            items={items}
            filtered={filtered}
            canDelete={canDelete}
            onDelete={(e) => setPendingDelete(e)}
            archivedCount={archivedCount}
          />
        )}
      </div>
    </AppShell>
  );
}

function ViewToggle({ view, onChange }: { view: ViewMode; onChange(v: ViewMode): void }) {
  return (
    <div
      role="tablist"
      aria-label="Layout"
      style={{
        display: 'inline-flex',
        background: 'var(--bg-sunk)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 2,
        marginBottom: 6,
      }}
    >
      <ViewToggleButton
        active={view === 'list'}
        onClick={() => onChange('list')}
        icon={<Icon.FileText size={12} />}
        label="List"
      />
      <ViewToggleButton
        active={view === 'kanban'}
        onClick={() => onChange('kanban')}
        icon={<Icon.Thread size={12} />}
        label="Kanban"
      />
    </div>
  );
}

function ViewToggleButton({
  active, onClick, icon, label,
}: {
  active: boolean;
  onClick(): void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        appearance: 'none', cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 10px',
        background: active ? 'var(--bg)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
        borderRadius: 6,
        fontSize: 12, fontWeight: 500,
        boxShadow: active ? '0 1px 2px rgba(0,0,0,.05)' : 'none',
        transition: 'background .15s, color .15s, box-shadow .15s',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function ListView({
  items, filtered, canDelete, onDelete,
}: {
  items: EngagementSummary[] | null;
  filtered: EngagementSummary[];
  canDelete: boolean;
  onDelete(e: EngagementSummary): void;
}) {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 90 }}>ID</th>
            <th>Opportunity</th>
            <th style={{ width: 180 }}>Stage</th>
            <th style={{ width: 110 }}>Updated</th>
            <th style={{ width: 24 }} />
          </tr>
        </thead>
        <tbody>
          {items === null && (
            <tr><td colSpan={5}><div className="empty">Loading…</div></td></tr>
          )}
          {filtered.length === 0 && items !== null && (
            <tr><td colSpan={5}><div className="empty">No opportunities match.</div></td></tr>
          )}
          {filtered.map((e) => (
            <ListRow
              key={e.id}
              engagement={e}
              canDelete={canDelete}
              onDelete={() => onDelete(e)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListRow({
  engagement, canDelete, onDelete,
}: {
  engagement: EngagementSummary;
  canDelete: boolean;
  onDelete(): void;
}) {
  const e = engagement;
  const router = useRouter();
  const href = `/opportunities/${e.id}`;
  const hasProposal = ['approved', 'drafting', 'draft_ready', 'sent', 'closed'].includes(e.status);
  const [emailCopied, setEmailCopied] = useState(false);
  function copyEmail() {
    navigator.clipboard.writeText(e.clientEmail);
    setEmailCopied(true);
    setTimeout(() => setEmailCopied(false), 1500);
  }
  return (
    // The title link carries the real semantics + keyboard nav; the row
    // onClick is a click-anywhere affordance, made keyboard-reachable
    // with role/tabIndex/onKeyDown so it isn't a mouse-only trap.
    <tr
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          router.push(href);
        }
      }}
    >
      <td><span className="cell-mono">{e.id.slice(0, 8)}</span></td>
      <td>
        <div className="cell-strong" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link href={href} onClick={(ev) => ev.stopPropagation()}>
            {e.name ?? e.clientEmail}
          </Link>
          <SourceChip source={e.source} />
        </div>
        <div className="cell-muted" style={{ fontSize: 12 }}>
          {/* Template name is null for direct-ingest opportunities; fall
              back to the engagement label / client email so the row
              still says something useful. */}
          {e.name
            ? `${e.clientEmail}${e.templateName ? ` · ${e.templateName}` : ''}`
            : e.templateName ?? e.clientEmail}
        </div>
      </td>
      <td><StageChip stage={e.status} /></td>
      <td className="cell-muted" style={{ fontSize: 12 }}>{relativeTime(e.submittedAt ?? e.createdAt)}</td>
      <td onClick={(ev) => ev.stopPropagation()}>
        <RowActions
          size="sm"
          stopPropagation
          items={[
            {
              label: 'Open opportunity',
              icon: 'ArrowUpRight',
              onClick: () => router.push(href),
            },
            ...(hasProposal
              ? [{
                  label: 'View proposal',
                  icon: 'FileText' as const,
                  onClick: () => router.push(`/opportunities/${e.id}/proposal`),
                }]
              : []),
            { divider: true },
            {
              label: emailCopied ? 'Email copied' : 'Copy client email',
              icon: emailCopied ? 'Check' : 'Mail',
              onClick: copyEmail,
            },
            {
              label: 'Open in new tab',
              icon: 'ArrowUpRight',
              onClick: () => window.open(`/opportunities/${e.id}`, '_blank', 'noopener'),
            },
            { divider: true },
            {
              label: 'Delete opportunity',
              icon: 'X',
              danger: true,
              disabled: !canDelete,
              title: canDelete ? undefined : 'Manager or admin only',
              onClick: onDelete,
            },
          ]}
        />
      </td>
    </tr>
  );
}

function KanbanView({
  items, filtered, canDelete, onDelete, archivedCount,
}: {
  items: EngagementSummary[] | null;
  filtered: EngagementSummary[];
  canDelete: boolean;
  onDelete(e: EngagementSummary): void;
  archivedCount: number;
}) {
  if (items === null) {
    return <div className="empty" style={{ padding: 60 }}><span className="spin" /></div>;
  }

  // Assign every filtered opportunity to exactly one pipeline column.
  // This mirrors the detail page's stageOf(): a status that no column
  // names explicitly still lands in Discovery (the leftmost stage)
  // rather than dropping off the board — the bug that hid freshly
  // 'ingesting' opportunities. Only genuinely archived statuses
  // (rejected/expired/lost) are intentionally left out, surfaced as a
  // count below.
  const columns = KANBAN_COLUMNS.map((col) => ({ ...col, items: [] as EngagementSummary[] }));
  // KANBAN_COLUMNS is a non-empty literal, so a fallback always exists.
  const fallbackColumn = (columns.find((c) => c.id === 'discovery') ?? columns[0])!;
  const orphans: EngagementSummary[] = [];
  for (const e of filtered) {
    if (ARCHIVED_STATUSES.has(e.status)) {
      orphans.push(e);
      continue;
    }
    const target = columns.find((c) => c.statuses.includes(e.status)) ?? fallbackColumn;
    target.items.push(e);
  }

  const totalShown = columns.reduce((acc, c) => acc + c.items.length, 0);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{
        display: 'flex',
        gap: 12,
        overflowX: 'auto',
        paddingBottom: 8,
        // Stretch columns to fill available width when there's room,
        // and let them scroll horizontally on narrow viewports.
        scrollSnapType: 'x proximity',
      }}>
        {columns.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            canDelete={canDelete}
            onDelete={onDelete}
          />
        ))}
      </div>
      {totalShown === 0 && (
        <div className="card" style={{ padding: 32 }}>
          <div className="empty">No opportunities match.</div>
        </div>
      )}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        fontSize: 11.5, color: 'var(--fg-subtle)',
      }}>
        <span>
          Showing <b style={{ color: 'var(--fg-muted)' }}>{totalShown}</b> in pipeline
        </span>
        {orphans.length > 0 && (
          <span title="Rejected or expired opportunities aren't in the pipeline columns above. Switch to List view to see them.">
            · {orphans.length} archived (not shown — switch to List)
          </span>
        )}
        {archivedCount > 0 && orphans.length === 0 && (
          <span title="Rejected or expired opportunities exist outside the active filter.">
            · {archivedCount} rejected/expired total
          </span>
        )}
      </div>
    </div>
  );
}

function KanbanColumn({
  column, canDelete, onDelete,
}: {
  column: typeof KANBAN_COLUMNS[number] & { items: EngagementSummary[] };
  canDelete: boolean;
  onDelete(e: EngagementSummary): void;
}) {
  return (
    <div
      style={{
        flex: '1 0 280px',
        minWidth: 280,
        maxWidth: 360,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        scrollSnapAlign: 'start',
      }}
    >
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 4px 6px',
        position: 'sticky',
        top: 0,
        zIndex: 'var(--z-sticky)',
        background: 'var(--bg)',
      }}>
        <span style={{
          width: 8, height: 8, borderRadius: 999,
          background: column.accent,
          flexShrink: 0,
        }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 12, fontWeight: 600,
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}>
            {column.label}
            <span style={{
              fontSize: 11, fontVariantNumeric: 'tabular-nums',
              padding: '1px 6px', borderRadius: 999,
              background: 'var(--bg-sunk)', color: 'var(--fg-subtle)',
              fontWeight: 500,
            }}>
              {column.items.length}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 1 }}>
            {column.hint}
          </div>
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        background: 'var(--bg-sunk)',
        borderRadius: 10,
        padding: 8,
        minHeight: 120,
      }}>
        {column.items.length === 0 ? (
          <div style={{
            fontSize: 11.5, color: 'var(--fg-subtle)',
            padding: '24px 12px', textAlign: 'center',
            border: '1px dashed var(--divider)',
            borderRadius: 8,
            background: 'var(--bg)',
          }}>
            No items
          </div>
        ) : (
          column.items.map((e) => (
            <KanbanCard
              key={e.id}
              engagement={e}
              canDelete={canDelete}
              onDelete={() => onDelete(e)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function KanbanCard({
  engagement, canDelete, onDelete,
}: {
  engagement: EngagementSummary;
  canDelete: boolean;
  onDelete(): void;
}) {
  const e = engagement;
  const router = useRouter();
  const href = `/opportunities/${e.id}`;
  const title = e.name ?? e.clientEmail;
  // Direct-ingest opportunities have no template; fall back to the
  // client email so the kanban card subtitle isn't blank.
  const subtitle = e.name ? e.clientEmail : (e.templateName ?? e.clientEmail);
  const updatedAt = e.submittedAt ?? e.createdAt;
  const priceLabel = e.predictedPriceCents != null
    ? formatPrice(e.predictedPriceCents, e.currency)
    : null;
  // Show the proposal shortcut only once the engagement has reached the
  // post-approval lifecycle — that's when the workspace route is useful.
  const hasProposal = ['approved', 'drafting', 'draft_ready', 'sent', 'closed'].includes(e.status);
  // Copy-email convenience — the rep often wants to drop the client's
  // address into Slack/Outlook without leaving the board.
  const [emailCopied, setEmailCopied] = useState(false);
  function copyEmail() {
    navigator.clipboard.writeText(e.clientEmail);
    setEmailCopied(true);
    setTimeout(() => setEmailCopied(false), 1500);
  }

  return (
    // The title link carries the real semantics + keyboard nav; the card
    // onClick is a click-anywhere affordance, made keyboard-reachable
    // with role/tabIndex/onKeyDown so it isn't a mouse-only trap.
    <div
      role="link"
      tabIndex={0}
      onClick={() => router.push(href)}
      onKeyDown={(ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          ev.preventDefault();
          router.push(href);
        }
      }}
      style={{
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        transition: 'border-color .15s, box-shadow .15s, transform .1s',
      }}
      onMouseEnter={(ev) => {
        ev.currentTarget.style.borderColor = 'var(--border-strong)';
        ev.currentTarget.style.boxShadow = '0 4px 10px rgba(0,0,0,.04)';
      }}
      onMouseLeave={(ev) => {
        ev.currentTarget.style.borderColor = 'var(--border)';
        ev.currentTarget.style.boxShadow = 'none';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 13, fontWeight: 600, color: 'var(--fg)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            <Link
              href={href}
              onClick={(ev) => ev.stopPropagation()}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              {title}
            </Link>
          </div>
          <div style={{
            fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2,
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {subtitle}
          </div>
        </div>
        <div onClick={(ev) => ev.stopPropagation()}>
          <RowActions
            size="sm"
            stopPropagation
            items={[
              {
                label: 'Open opportunity',
                icon: 'ArrowUpRight',
                onClick: () => router.push(href),
              },
              ...(hasProposal
                ? [{
                    label: 'View proposal',
                    icon: 'FileText' as const,
                    onClick: () => router.push(`/opportunities/${e.id}/proposal`),
                  }]
                : []),
              { divider: true },
              {
                label: emailCopied ? 'Email copied' : 'Copy client email',
                icon: emailCopied ? 'Check' : 'Mail',
                onClick: copyEmail,
              },
              {
                label: 'Open in new tab',
                icon: 'ArrowUpRight',
                onClick: () => window.open(`/opportunities/${e.id}`, '_blank', 'noopener'),
              },
              { divider: true },
              {
                label: 'Delete opportunity',
                icon: 'X',
                danger: true,
                disabled: !canDelete,
                title: canDelete ? undefined : 'Manager or admin only',
                onClick: onDelete,
              },
            ]}
          />
        </div>
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
        marginTop: 2,
      }}>
        <StageChip stage={e.status} />
        <SourceChip source={e.source} />
        {priceLabel && (
          <span style={{
            fontSize: 11, fontVariantNumeric: 'tabular-nums',
            padding: '2px 8px', borderRadius: 999,
            background: 'var(--bg-sunk)', color: 'var(--fg)',
            fontWeight: 500,
          }}>
            {priceLabel}
          </span>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
        fontSize: 11, color: 'var(--fg-subtle)',
        paddingTop: 6, borderTop: '1px solid var(--divider)',
        minWidth: 0,
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          minWidth: 0, flex: 1,
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          <Icon.FileText size={9} />
          <span style={{
            overflow: 'hidden', textOverflow: 'ellipsis',
          }}>{e.templateName ?? 'No template'}</span>
        </span>
        <span className="mono" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{relativeTime(updatedAt)}</span>
      </div>
    </div>
  );
}

function formatPrice(cents: number, currency: string | null): string {
  // Pull the right symbol off the currency code via Intl, then build a
  // compact label by hand. We avoid Intl's `notation: 'compact'` because
  // it emits inconsistent spacing across currencies and locales (e.g.
  // "₹54.8K" vs "$54.8K" vs "€54,8 K"); doing the magnitude formatting
  // ourselves keeps the chip short and uniform.
  const code = (currency ?? 'USD').toUpperCase();
  const units = cents / 100;
  const symbol = currencySymbol(code);
  const abs = Math.abs(units);
  let body: string;
  if (abs >= 10_000_000 && code === 'INR') {
    // Indian convention — 1 crore = 10⁷
    body = `${(units / 10_000_000).toFixed(units % 10_000_000 === 0 ? 0 : 1)}Cr`;
  } else if (abs >= 100_000 && code === 'INR') {
    // Indian convention — 1 lakh = 10⁵
    body = `${(units / 100_000).toFixed(units % 100_000 === 0 ? 0 : 1)}L`;
  } else if (abs >= 1_000_000) {
    body = `${(units / 1_000_000).toFixed(units % 1_000_000 === 0 ? 0 : 1)}M`;
  } else if (abs >= 1_000) {
    body = `${(units / 1_000).toFixed(units % 1_000 === 0 ? 0 : 1)}k`;
  } else {
    body = units.toFixed(0);
  }
  return `${symbol}${body}`;
}

function currencySymbol(code: string): string {
  switch (code) {
    case 'INR': return '₹';
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    case 'AUD': return 'A$';
    case 'CAD': return 'C$';
    default: {
      // Fall back to the locale-aware symbol via Intl. If the code is
      // unknown to Intl, emit the bare ISO code with a trailing space.
      try {
        const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
        const parts = fmt.formatToParts(0);
        const sym = parts.find((p) => p.type === 'currency')?.value;
        return sym ?? `${code} `;
      } catch {
        return `${code} `;
      }
    }
  }
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
