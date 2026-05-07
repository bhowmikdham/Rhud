'use client';

/**
 * Lead-management panels rendered on every opportunity detail page:
 *   - Lead Summary card (AI digest with risk + next actions + refresh)
 *   - Tickets panel (complaints, change requests, internal check-ins)
 *   - Follow-ups panel (scheduled "remind me" reminders)
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeError,
  followUps as followUpsApi,
  leadSummary as leadSummaryApi,
  tickets as ticketsApi,
  type CreateFollowUpInput,
  type CreateTicketInput,
  type FollowUpRow,
  type GenerateSummaryResult,
  type LeadSummaryRow,
  type SummaryNextAction,
  type SummaryRiskLevel,
  type TicketCategory,
  type TicketPriority,
  type TicketRow,
  type TicketStatus,
  type UpdateTicketInput,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

// ── Top-level panel — single card with tabs ──────────────────────────

type Tab = 'summary' | 'tickets' | 'followups';

export function LeadManagementSection({
  engagementId,
  userRole,
}: {
  engagementId: string;
  userRole: string;
}) {
  const [tab, setTab] = useState<Tab>('summary');
  const [tickets, setTickets] = useState<TicketRow[] | null>(null);
  const [followUps, setFollowUps] = useState<FollowUpRow[] | null>(null);

  // Lift counts up so the tab labels can show them. Each child panel
  // notifies on change via its onListChanged prop.
  const openTicketCount = (tickets ?? []).filter((t) => t.status === 'open' || t.status === 'in_progress').length;
  const pendingFollowUpCount = (followUps ?? []).filter((f) => !f.completedAt).length;
  const overdueFollowUpCount = (followUps ?? []).filter((f) => f.overdue).length;

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'stretch',
        borderBottom: '1px solid var(--divider)',
      }}>
        <TabButton active={tab === 'summary'} onClick={() => setTab('summary')}>
          <Icon.Sparkle size={11} /> Lead summary
        </TabButton>
        <TabButton active={tab === 'tickets'} onClick={() => setTab('tickets')}>
          Tickets {openTicketCount > 0 && (
            <span className="chip" style={{ marginLeft: 4, padding: '1px 6px', fontSize: 10 }}>
              {openTicketCount}
            </span>
          )}
        </TabButton>
        <TabButton active={tab === 'followups'} onClick={() => setTab('followups')}>
          Follow-ups {pendingFollowUpCount > 0 && (
            <span
              className="chip"
              style={{
                marginLeft: 4, padding: '1px 6px', fontSize: 10,
                background: overdueFollowUpCount > 0 ? 'var(--danger-tint)' : undefined,
                color: overdueFollowUpCount > 0 ? 'var(--danger)' : undefined,
              }}
            >
              {pendingFollowUpCount}
            </span>
          )}
        </TabButton>
        <div style={{ flex: 1 }} />
      </div>

      <div style={{ padding: 16 }}>
        {tab === 'summary' && <LeadSummaryPanel engagementId={engagementId} />}
        {tab === 'tickets' && (
          <TicketsPanel
            engagementId={engagementId}
            userRole={userRole}
            onListChanged={setTickets}
          />
        )}
        {tab === 'followups' && (
          <FollowUpsPanel
            engagementId={engagementId}
            onListChanged={setFollowUps}
          />
        )}
      </div>
    </div>
  );
}

function TabButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'var(--bg)' : 'transparent',
        border: 'none',
        borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
        marginBottom: -1,
        padding: '12px 16px',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        cursor: 'pointer',
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}
    >
      {children}
    </button>
  );
}

// ── Lead Summary panel ────────────────────────────────────────────────

function LeadSummaryPanel({ engagementId }: { engagementId: string }) {
  const [summary, setSummary] = useState<LeadSummaryRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [manualSaving, setManualSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLoading(true);
      const cur = await leadSummaryApi.current(engagementId);
      setSummary(cur);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function generate() {
    if (generating) return;
    setGenerating(true); setErr(null); setManualPrompt(null);
    try {
      const result: GenerateSummaryResult = await leadSummaryApi.generate(engagementId);
      if (result.mode === 'manual') {
        setManualPrompt(result.prompt);
      } else {
        setSummary(result.summary);
      }
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setGenerating(false);
    }
  }

  async function submitManual() {
    if (!manualText.trim()) return;
    setManualSaving(true); setErr(null);
    try {
      const row = await leadSummaryApi.acceptManual(engagementId, { text: manualText });
      setSummary(row);
      setManualPrompt(null);
      setManualText('');
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setManualSaving(false);
    }
  }

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          {summary ? (
            <>
              {summary.generatedBy === 'manual' ? 'Manual' : (summary.model ?? 'LLM')}
              {' · '}
              {new Date(summary.generatedAt).toLocaleString()}
              {!summary.fresh && <span style={{ marginLeft: 6, color: 'var(--warn, #b85)' }}>· stale</span>}
            </>
          ) : (
            <span style={{ color: 'var(--fg-muted)' }}>AI-generated digest of this lead's status</span>
          )}
        </div>
        <button className="btn sm accent" disabled={generating} onClick={generate}>
          {generating ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> {summary ? 'Refresh' : 'Generate'}</>}
        </button>
      </header>

      {loading && <div className="empty"><span className="spin" /></div>}

      {!loading && !summary && !manualPrompt && (
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '6px 0' }}>
          No summary yet. Click <b>Generate</b> to have the configured AI provider produce a status briefing
          based on the opportunity&apos;s state, open tickets, follow-ups, and recent activity.
        </div>
      )}

      {summary && !manualPrompt && (
        <SummaryBody summary={summary} />
      )}

      {manualPrompt && (
        <ManualSummaryPanel
          prompt={manualPrompt}
          text={manualText}
          onTextChange={setManualText}
          onCancel={() => { setManualPrompt(null); setManualText(''); }}
          onSubmit={submitManual}
          saving={manualSaving}
        />
      )}

      {err && (
        <div style={{ marginTop: 10, padding: 8, fontSize: 12, color: 'var(--danger)', background: 'var(--danger-tint)', borderRadius: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function SummaryBody({ summary }: { summary: LeadSummaryRow }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RiskChip risk={summary.riskLevel} />
        {summary.recommendedFollowUpDays != null && (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            <Icon.Clock size={11} /> Suggested follow-up in <b>{summary.recommendedFollowUpDays}</b> day{summary.recommendedFollowUpDays === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{summary.summaryText}</p>
      {summary.nextActions.length > 0 && (
        <div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', fontWeight: 600, marginBottom: 6 }}>NEXT ACTIONS</div>
          <ul style={{ margin: 0, padding: '0 0 0 18px', display: 'grid', gap: 4 }}>
            {summary.nextActions.map((a, i) => (
              <li key={i} style={{ fontSize: 12.5 }}>
                <UrgencyDot urgency={a.urgency} />
                <span style={{ marginLeft: 6 }}>{a.title}</span>
                {a.owner && <span style={{ color: 'var(--fg-muted)', marginLeft: 6 }}>— {a.owner}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ManualSummaryPanel({
  prompt, text, onTextChange, onCancel, onSubmit, saving,
}: {
  prompt: string;
  text: string;
  onTextChange(v: string): void;
  onCancel(): void;
  onSubmit(): void;
  saving: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function copyPrompt() {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        Your tenant uses manual LLM mode. Copy this prompt into your AI tool, then paste the JSON response below.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn sm" onClick={copyPrompt}>
          {copied ? <><Icon.Check size={11} /> Copied prompt</> : <><Icon.Copy size={11} /> Copy prompt</>}
        </button>
      </div>
      <textarea
        className="input"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder='Paste the AI response here. JSON like {"summary":"…","risk":"low","actions":[…],"follow_up_days":7} works best.'
        rows={6}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn sm ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn sm accent" onClick={onSubmit} disabled={saving || !text.trim()}>
          {saving ? <span className="spin" /> : <><Icon.Check size={11} /> Save summary</>}
        </button>
      </div>
    </div>
  );
}

function RiskChip({ risk }: { risk: SummaryRiskLevel }) {
  const styles: Record<SummaryRiskLevel, { bg: string; fg: string; label: string }> = {
    low: { bg: 'var(--ok-tint)', fg: 'var(--ok)', label: 'Low risk' },
    medium: { bg: 'color-mix(in oklch, #d80 22%, transparent)', fg: '#a60', label: 'Medium risk' },
    high: { bg: 'var(--danger-tint)', fg: 'var(--danger)', label: 'High risk' },
  };
  const s = styles[risk];
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      background: s.bg, color: s.fg,
    }}>{s.label}</span>
  );
}

function UrgencyDot({ urgency }: { urgency: SummaryNextAction['urgency'] }) {
  const colors = { low: 'var(--fg-muted)', medium: '#c80', high: 'var(--danger)' };
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: colors[urgency],
    }} />
  );
}

// ── Tickets panel ────────────────────────────────────────────────────

function TicketsPanel({
  engagementId,
  userRole,
  onListChanged,
}: {
  engagementId: string;
  userRole: string;
  onListChanged?(list: TicketRow[]): void;
}) {
  const confirm = useConfirm();
  const [list, setList] = useState<TicketRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<TicketRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const updateList = useCallback((next: TicketRow[]) => {
    setList(next);
    onListChanged?.(next);
  }, [onListChanged]);

  const refresh = useCallback(() => {
    ticketsApi.list(engagementId)
      .then((rows) => updateList(rows))
      .catch((e) => setErr(describeError(e)));
  }, [engagementId, updateList]);

  useEffect(() => { refresh(); }, [refresh]);

  async function changeStatus(t: TicketRow, status: TicketStatus, note?: string) {
    try {
      const updated = await ticketsApi.update(engagementId, t.id, {
        status,
        ...(note ? { resolutionNote: note } : {}),
      });
      const next = (list ?? []).map((x) => (x.id === updated.id ? updated : x));
      updateList(next);
    } catch (e) { setErr(describeError(e)); }
  }

  async function remove(t: TicketRow) {
    const ok = await confirm({
      title: 'Delete ticket?',
      body: 'This is permanent. Audit trail (thread events) is preserved separately.',
      tone: 'danger',
      confirmLabel: 'Delete',
    });
    if (!ok) return;
    try {
      await ticketsApi.remove(engagementId, t.id);
      refresh();
    } catch (e) { setErr(describeError(e)); }
  }

  const open = (list ?? []).filter((t) => t.status === 'open' || t.status === 'in_progress');
  const closed = (list ?? []).filter((t) => t.status === 'resolved' || t.status === 'wont_fix');

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Complaints, questions, change requests, and internal notes against this opportunity
        </span>
        <button className="btn sm accent" onClick={() => setShowCreate(true)}>
          <Icon.Plus size={11} /> Raise ticket
        </button>
      </header>

      {list == null && <div className="empty"><span className="spin" /></div>}

      {list && open.length === 0 && closed.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '6px 0' }}>
          No tickets yet. Raise one when the client surfaces a question, complaint, or change request.
        </div>
      )}

      {open.length > 0 && (
        <TicketTable rows={open} onEdit={setEditing} onChangeStatus={changeStatus} onRemove={remove} userRole={userRole} />
      )}

      {closed.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 12, color: 'var(--fg-muted)', cursor: 'pointer' }}>
            Resolved &amp; closed ({closed.length})
          </summary>
          <div style={{ marginTop: 8, opacity: 0.75 }}>
            <TicketTable rows={closed} onEdit={setEditing} onChangeStatus={changeStatus} onRemove={remove} userRole={userRole} />
          </div>
        </details>
      )}

      {err && (
        <div style={{ marginTop: 10, padding: 8, fontSize: 12, color: 'var(--danger)' }}>{err}</div>
      )}

      {showCreate && (
        <TicketEditorModal
          engagementId={engagementId}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); refresh(); }}
        />
      )}
      {editing && (
        <TicketEditorModal
          engagementId={engagementId}
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function TicketTable({
  rows, onEdit, onChangeStatus, onRemove, userRole,
}: {
  rows: TicketRow[];
  onEdit(t: TicketRow): void;
  onChangeStatus(t: TicketRow, s: TicketStatus, note?: string): void;
  onRemove(t: TicketRow): void;
  userRole: string;
}) {
  const canDelete = userRole === 'admin' || userRole === 'sales_manager';
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((t) => (
        <div
          key={t.id}
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 10, alignItems: 'center',
            padding: '10px 12px', borderRadius: 8,
            border: '1px solid var(--divider)', background: 'var(--bg-elev)',
          }}
        >
          <PriorityBadge priority={t.priority} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              {t.title}
              <CategoryChip category={t.category} />
              {t.status === 'in_progress' && <span className="chip warn">In progress</span>}
              {t.status === 'resolved' && <span className="chip ok">Resolved</span>}
              {t.status === 'wont_fix' && <span className="chip">Won&apos;t fix</span>}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3 }}>
              {t.raisedByDisplay && <>Raised by {t.raisedByDisplay} · </>}
              {new Date(t.createdAt).toLocaleString()}
              {t.assignedToDisplay && <> · Assigned to {t.assignedToDisplay}</>}
            </div>
            {t.description && (
              <div style={{ fontSize: 12, color: 'var(--fg)', marginTop: 6, whiteSpace: 'pre-wrap' }}>
                {t.description}
              </div>
            )}
            {t.resolutionNote && (
              <div style={{ fontSize: 12, marginTop: 6, padding: 6, background: 'var(--bg-sunk)', borderRadius: 4 }}>
                <b>Resolution: </b>{t.resolutionNote}
              </div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {(t.status === 'open' || t.status === 'in_progress') && (
              <>
                {t.status === 'open' && (
                  <button className="btn sm ghost" title="Mark in progress" onClick={() => onChangeStatus(t, 'in_progress')}>
                    <Icon.Clock size={11} />
                  </button>
                )}
                <button className="btn sm ghost" title="Mark resolved" onClick={() => onChangeStatus(t, 'resolved')}>
                  <Icon.Check size={11} />
                </button>
              </>
            )}
            <button className="btn sm ghost" title="Edit" onClick={() => onEdit(t)}>
              <Icon.Settings size={11} />
            </button>
            {canDelete && (
              <button className="btn sm danger ghost" title="Delete" onClick={() => onRemove(t)}>
                <Icon.X size={11} />
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const map: Record<TicketPriority, { bg: string; fg: string; label: string }> = {
    low: { bg: 'var(--bg-sunk)', fg: 'var(--fg-muted)', label: 'Low' },
    medium: { bg: 'color-mix(in oklch, #aaa 24%, transparent)', fg: 'var(--fg)', label: 'Med' },
    high: { bg: 'color-mix(in oklch, #c80 28%, transparent)', fg: '#a60', label: 'High' },
    urgent: { bg: 'var(--danger-tint)', fg: 'var(--danger)', label: 'Urgent' },
  };
  const s = map[priority];
  return (
    <span style={{
      width: 48, padding: '2px 0', textAlign: 'center', fontSize: 10, fontWeight: 700,
      background: s.bg, color: s.fg, borderRadius: 4, letterSpacing: 0.4,
    }}>{s.label}</span>
  );
}

function CategoryChip({ category }: { category: TicketCategory }) {
  const labels: Record<TicketCategory, string> = {
    complaint: 'Complaint',
    question: 'Question',
    change_request: 'Change',
    check_in: 'Check-in',
    internal_note: 'Internal',
  };
  return (
    <span style={{
      fontSize: 10, padding: '1px 6px', borderRadius: 999,
      background: 'var(--bg-sunk)', color: 'var(--fg-muted)',
      textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600,
    }}>{labels[category]}</span>
  );
}

function TicketEditorModal({
  engagementId, existing, onClose, onSaved,
}: {
  engagementId: string;
  existing?: TicketRow;
  onClose(): void;
  onSaved(): void;
}) {
  const [category, setCategory] = useState<TicketCategory>(existing?.category ?? 'question');
  const [priority, setPriority] = useState<TicketPriority>(existing?.priority ?? 'medium');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [resolutionNote, setResolutionNote] = useState(existing?.resolutionNote ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!title.trim()) { setErr('Title is required'); return; }
    setBusy(true); setErr(null);
    try {
      if (existing) {
        const patch: UpdateTicketInput = {
          category, priority, title: title.trim(),
          description: description.trim() || null,
          resolutionNote: resolutionNote.trim() || null,
        };
        await ticketsApi.update(engagementId, existing.id, patch);
      } else {
        const input: CreateTicketInput = {
          category, priority, title: title.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
        };
        await ticketsApi.create(engagementId, input);
      }
      onSaved();
    } catch (e) {
      setErr(describeError(e));
    } finally {
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
        <div className="card" style={{ width: '100%', maxWidth: 540, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {existing ? 'Edit ticket' : 'Raise a ticket'}
            </div>
          </header>
          <div style={{ padding: 18, display: 'grid', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Category</span>
                <select className="input" value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
                  <option value="complaint">Complaint</option>
                  <option value="question">Question</option>
                  <option value="change_request">Change request</option>
                  <option value="check_in">Check-in</option>
                  <option value="internal_note">Internal note</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Priority</span>
                <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
              </label>
            </div>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Title</span>
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary, e.g. 'Client wants to add 2 more web apps'"
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Description</span>
              <textarea
                className="input"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What happened, what does the client want, anything we know so far"
                rows={4}
              />
            </label>
            {existing && (existing.status === 'resolved' || existing.status === 'wont_fix') && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Resolution note</span>
                <textarea
                  className="input"
                  value={resolutionNote}
                  onChange={(e) => setResolutionNote(e.target.value)}
                  rows={2}
                />
              </label>
            )}
            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn sm accent" onClick={save} disabled={busy || !title.trim()}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

// ── Follow-ups panel ────────────────────────────────────────────────

function FollowUpsPanel({
  engagementId,
  onListChanged,
}: {
  engagementId: string;
  onListChanged?(list: FollowUpRow[]): void;
}) {
  const confirm = useConfirm();
  const [list, setList] = useState<FollowUpRow[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [completing, setCompleting] = useState<FollowUpRow | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    followUpsApi.list(engagementId)
      .then((rows) => { setList(rows); onListChanged?.(rows); })
      .catch((e) => setErr(describeError(e)));
  }, [engagementId, onListChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  async function remove(f: FollowUpRow) {
    const ok = await confirm({
      title: 'Remove follow-up?',
      body: 'This deletes the reminder. Use Complete instead if it actually happened.',
      tone: 'warn',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await followUpsApi.remove(engagementId, f.id);
      refresh();
    } catch (e) { setErr(describeError(e)); }
  }

  const pending = (list ?? []).filter((f) => !f.completedAt);
  const done = (list ?? []).filter((f) => f.completedAt);

  return (
    <div>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
          Scheduled reminders to check on this lead
        </span>
        <button className="btn sm accent" onClick={() => setShowCreate(true)}>
          <Icon.Plus size={11} /> Schedule follow-up
        </button>
      </header>

      {list == null && <div className="empty"><span className="spin" /></div>}

      {list && pending.length === 0 && done.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '6px 0' }}>
          No follow-ups scheduled. Use these for &quot;remind me to call client in 3 days&quot; tasks.
        </div>
      )}

      {pending.length > 0 && (
        <FollowUpList rows={pending} onComplete={setCompleting} onRemove={remove} />
      )}

      {done.length > 0 && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ fontSize: 12, color: 'var(--fg-muted)', cursor: 'pointer' }}>
            Completed ({done.length})
          </summary>
          <div style={{ marginTop: 8, opacity: 0.75 }}>
            <FollowUpList rows={done} onComplete={setCompleting} onRemove={remove} />
          </div>
        </details>
      )}

      {err && <div style={{ marginTop: 10, fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

      {showCreate && (
        <FollowUpCreateModal
          engagementId={engagementId}
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); refresh(); }}
        />
      )}
      {completing && (
        <FollowUpCompleteModal
          engagementId={engagementId}
          row={completing}
          onClose={() => setCompleting(null)}
          onSaved={() => { setCompleting(null); refresh(); }}
        />
      )}
    </div>
  );
}

function FollowUpList({
  rows, onComplete, onRemove,
}: {
  rows: FollowUpRow[];
  onComplete(r: FollowUpRow): void;
  onRemove(r: FollowUpRow): void;
}) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      {rows.map((f) => (
        <div
          key={f.id}
          style={{
            display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center',
            padding: '10px 12px', borderRadius: 8,
            border: `1px solid ${f.overdue ? 'var(--danger)' : 'var(--divider)'}`,
            background: 'var(--bg-elev)',
          }}
        >
          <div style={{
            width: 60, textAlign: 'center', fontSize: 11, padding: '4px 0', borderRadius: 4,
            background: f.overdue ? 'var(--danger-tint)' : f.completedAt ? 'var(--ok-tint)' : 'var(--bg-sunk)',
            color: f.overdue ? 'var(--danger)' : f.completedAt ? 'var(--ok)' : 'var(--fg-muted)',
            fontWeight: 600,
          }}>
            {f.completedAt ? 'Done'
              : f.overdue ? 'Overdue'
              : <ScheduledLabel iso={f.scheduledFor} />}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{f.reason}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 3 }}>
              {f.completedAt
                ? <>Completed {new Date(f.completedAt).toLocaleString()} {f.completedByDisplay && <>by {f.completedByDisplay}</>}</>
                : <>Due {new Date(f.scheduledFor).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}{f.assignedToDisplay && <> · {f.assignedToDisplay}</>}</>}
            </div>
            {f.completionNote && (
              <div style={{ fontSize: 12, marginTop: 6, padding: 6, background: 'var(--bg-sunk)', borderRadius: 4 }}>{f.completionNote}</div>
            )}
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            {!f.completedAt && (
              <button className="btn sm ghost" title="Mark complete" onClick={() => onComplete(f)}>
                <Icon.Check size={11} />
              </button>
            )}
            <button className="btn sm danger ghost" title="Delete" onClick={() => onRemove(f)}>
              <Icon.X size={11} />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ScheduledLabel({ iso }: { iso: string }) {
  const date = useMemo(() => new Date(iso), [iso]);
  const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
  if (days <= 1) return <>Soon</>;
  if (days <= 7) return <>{days}d</>;
  return <>{Math.ceil(days / 7)}w</>;
}

function FollowUpCreateModal({
  engagementId, onClose, onSaved,
}: {
  engagementId: string;
  onClose(): void;
  onSaved(): void;
}) {
  const [scheduledFor, setScheduledFor] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    d.setHours(9, 0, 0, 0);
    return d.toISOString().slice(0, 16); // for datetime-local
  });
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!reason.trim()) { setErr('Reason is required'); return; }
    setBusy(true); setErr(null);
    try {
      const input: CreateFollowUpInput = {
        scheduledFor: new Date(scheduledFor).toISOString(),
        reason: reason.trim(),
      };
      await followUpsApi.create(engagementId, input);
      onSaved();
    } catch (e) {
      setErr(describeError(e));
    } finally {
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
        <div className="card" style={{ width: '100%', maxWidth: 460, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Schedule a follow-up</div>
          </header>
          <div style={{ padding: 18, display: 'grid', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>When</span>
              <input
                className="input"
                type="datetime-local"
                value={scheduledFor}
                onChange={(e) => setScheduledFor(e.target.value)}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Reason</span>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Confirm scope changes with client"
              />
            </label>
            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn sm accent" onClick={save} disabled={busy || !reason.trim()}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Schedule</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

function FollowUpCompleteModal({
  engagementId, row, onClose, onSaved,
}: {
  engagementId: string;
  row: FollowUpRow;
  onClose(): void;
  onSaved(): void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true); setErr(null);
    try {
      await followUpsApi.complete(engagementId, row.id, note.trim() ? { completionNote: note.trim() } : {});
      onSaved();
    } catch (e) {
      setErr(describeError(e));
    } finally {
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
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Mark follow-up complete</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{row.reason}</div>
          </header>
          <div style={{ padding: 18, display: 'grid', gap: 8 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>What happened? (optional)</span>
              <textarea
                className="input"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="Brief note for the team"
              />
            </label>
            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn sm accent" onClick={save} disabled={busy}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Complete</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
