'use client';

/**
 * Phase B — classification & reviewer chips on the opportunity HUD.
 *
 *   • CategoryChip — shows current category > subcategory, click to
 *     open a small picker. Picker contains the full taxonomy
 *     (system + tenant rows). When category is missing entirely,
 *     chip reads "Classify".
 *   • ReviewerChip — shows the assigned reviewer's email, click to
 *     open a reassign popover (lists tenant users with reviewer-
 *     eligible roles).
 *
 * Both render compact and slot into the HUD strip next to existing
 * chips. The current `LeadHud` already handles tickets / follow-ups /
 * Odoo; this file exports two extra chips you mount alongside.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeError,
  categories,
  classification as classificationApi,
  team,
  type CategoryTree,
  type ClassificationResult,
  type OpportunityCategoryRow,
  type UserSummary,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';

// ── Category chip ───────────────────────────────────────────────────

interface CategoryChipProps {
  engagementId: string;
  userRole: string;
  classification: ClassificationResult | null;
  onChange?(next: ClassificationResult): void;
}

export function CategoryChip({
  engagementId, userRole, classification, onChange,
}: CategoryChipProps) {
  const canEdit = ['admin', 'sales_manager', 'tech_team'].includes(userRole);
  const [picker, setPicker] = useState(false);
  const [tree, setTree] = useState<CategoryTree | null>(null);

  useEffect(() => {
    if (!picker || tree) return;
    categories.tree().then(setTree).catch(() => setTree(null));
  }, [picker, tree]);

  const top = classification?.categorySlug
    ? topNameFor(classification.categorySlug, tree)
    : null;
  const sub = classification?.subCategorySlug
    ? topNameFor(classification.subCategorySlug, tree)
    : null;

  return (
    <>
      <button
        onClick={() => canEdit && setPicker(true)}
        title={canEdit ? 'Classify or change category' : 'View-only'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px',
          fontSize: 12, fontWeight: 500,
          background: classification?.categorySlug ? 'var(--bg-elev)' : 'transparent',
          color: classification?.categorySlug ? 'var(--fg)' : 'var(--fg-muted)',
          border: `1px solid ${classification?.categorySlug ? 'var(--border)' : 'var(--divider)'}`,
          borderRadius: 999,
          cursor: canEdit ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
        }}
      >
        <Icon.Inbox size={11} />
        {classification?.categorySlug ? (
          <>
            <span>{top ?? classification.categorySlug}</span>
            {sub && (
              <>
                <span style={{ color: 'var(--fg-subtle)', fontSize: 10 }}>›</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{sub}</span>
              </>
            )}
            {classification.classifiedBy === 'llm' && (
              <span style={{
                fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                color: 'var(--fg-subtle)', textTransform: 'uppercase',
                marginLeft: 2,
              }}>AI</span>
            )}
          </>
        ) : (
          <span>{canEdit ? 'Classify' : 'Unclassified'}</span>
        )}
      </button>

      {picker && (
        <CategoryPicker
          engagementId={engagementId}
          tree={tree}
          current={classification}
          onClose={() => setPicker(false)}
          onSaved={(next) => { setPicker(false); onChange?.(next); }}
        />
      )}
    </>
  );
}

function topNameFor(slug: string, tree: CategoryTree | null): string | null {
  if (!tree) return null;
  const flat: OpportunityCategoryRow[] = [
    ...tree.topLevel,
    ...Object.values(tree.childrenByParent).flat(),
  ];
  return flat.find((c) => c.slug === slug)?.name ?? null;
}

function CategoryPicker({
  engagementId, tree, current, onClose, onSaved,
}: {
  engagementId: string;
  tree: CategoryTree | null;
  current: ClassificationResult | null;
  onClose(): void;
  onSaved(next: ClassificationResult): void;
}) {
  const [topPick, setTopPick] = useState<string | null>(current?.categorySlug ?? null);
  const [subPick, setSubPick] = useState<string | null>(current?.subCategorySlug ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const subs = topPick ? (tree?.childrenByParent[topPick] ?? []) : [];

  async function save() {
    if (!topPick) return;
    setBusy(true); setErr(null);
    try {
      const result = await classificationApi.classifyManual(engagementId, {
        categorySlug: topPick,
        subCategorySlug: subPick ?? null,
      });
      onSaved(result);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function reRunAuto() {
    setBusy(true); setErr(null);
    try {
      const result = await classificationApi.classifyAuto(engagementId);
      onSaved(result);
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
          background: 'color-mix(in oklch, black 35%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 520, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Classify opportunity</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Pick a category. The matching reviewer is auto-assigned based on the tenant&apos;s routing rules.
            </div>
          </header>

          {!tree && <div className="empty" style={{ padding: 24 }}><span className="spin" /></div>}

          {tree && (
            <div style={{ padding: 18, display: 'grid', gap: 12 }}>
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--fg-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                  Category
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {tree.topLevel.map((t) => (
                    <button
                      key={t.slug}
                      onClick={() => {
                        setTopPick(t.slug);
                        if (subPick && !(tree.childrenByParent[t.slug] ?? []).some((c) => c.slug === subPick)) {
                          setSubPick(null);
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        fontSize: 12.5,
                        background: topPick === t.slug ? 'var(--accent-tint)' : 'var(--bg-elev)',
                        color: topPick === t.slug ? 'var(--accent)' : 'var(--fg)',
                        border: `1px solid ${topPick === t.slug ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 999,
                        cursor: 'pointer',
                        fontWeight: topPick === t.slug ? 600 : 500,
                      }}
                    >{t.name}</button>
                  ))}
                </div>
              </div>

              {subs.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: 0.4, color: 'var(--fg-muted)', textTransform: 'uppercase', marginBottom: 6 }}>
                    Subcategory <span style={{ color: 'var(--fg-subtle)', fontWeight: 400, textTransform: 'none' }}>(optional)</span>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button
                      onClick={() => setSubPick(null)}
                      style={chipBtnStyle(subPick == null)}
                    >— none —</button>
                    {subs.map((s) => (
                      <button
                        key={s.slug}
                        onClick={() => setSubPick(s.slug)}
                        style={chipBtnStyle(subPick === s.slug)}
                      >{s.name}</button>
                    ))}
                  </div>
                </div>
              )}

              {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
            </div>
          )}

          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <button className="btn sm ghost" disabled={busy} onClick={reRunAuto}>
              {busy ? <span className="spin" /> : <><Icon.Sparkle size={11} /> Ask AI</>}
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
              <button
                className="btn sm accent"
                disabled={busy || !topPick}
                onClick={save}
              >
                {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save</>}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

function chipBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '5px 10px',
    fontSize: 12,
    background: active ? 'var(--accent-tint)' : 'var(--bg-sunk)',
    color: active ? 'var(--accent)' : 'var(--fg)',
    border: `1px solid ${active ? 'var(--accent)' : 'transparent'}`,
    borderRadius: 999,
    cursor: 'pointer',
    fontWeight: active ? 600 : 500,
  };
}

// ── Reviewer chip ───────────────────────────────────────────────────

interface ReviewerChipProps {
  engagementId: string;
  userRole: string;
  assignedReviewerId: string | null;
  onChange?(assignedReviewerId: string | null): void;
}

export function ReviewerChip({
  engagementId, userRole, assignedReviewerId, onChange,
}: ReviewerChipProps) {
  const canReassign = ['admin', 'sales_manager'].includes(userRole);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserSummary[] | null>(null);

  useEffect(() => {
    // Lazy-load team list once when the chip is rendered. Even
    // non-admins benefit from seeing the assigned reviewer's name.
    team.listUsers().then(setUsers).catch(() => setUsers([]));
  }, []);

  const assignee = useMemo(() => {
    if (!assignedReviewerId) return null;
    return (users ?? []).find((u) => u.id === assignedReviewerId) ?? null;
  }, [users, assignedReviewerId]);

  return (
    <>
      <button
        onClick={() => canReassign && setOpen(true)}
        title={canReassign ? 'Reassign reviewer' : 'View-only'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '5px 10px',
          fontSize: 12, fontWeight: 500,
          background: assignedReviewerId ? 'var(--ok-tint)' : 'var(--bg-elev)',
          color: assignedReviewerId ? 'var(--ok)' : 'var(--fg-muted)',
          border: `1px solid ${assignedReviewerId ? 'color-mix(in oklch, var(--ok) 28%, transparent)' : 'var(--border)'}`,
          borderRadius: 999,
          cursor: canReassign ? 'pointer' : 'default',
          whiteSpace: 'nowrap',
        }}
      >
        <Icon.User size={11} />
        {assignee?.email ?? (assignedReviewerId ? 'Reviewer assigned' : 'No reviewer')}
      </button>

      {open && (
        <ReassignModal
          engagementId={engagementId}
          users={users ?? []}
          currentReviewerId={assignedReviewerId}
          onClose={() => setOpen(false)}
          onSaved={(next) => { setOpen(false); onChange?.(next); }}
        />
      )}
    </>
  );
}

function ReassignModal({
  engagementId, users, currentReviewerId, onClose, onSaved,
}: {
  engagementId: string;
  users: UserSummary[];
  currentReviewerId: string | null;
  onClose(): void;
  onSaved(next: string | null): void;
}) {
  const [pick, setPick] = useState<string | null>(currentReviewerId);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reviewer-eligible users: admin / sales_manager / tech_team.
  const eligible = users.filter((u) =>
    u.role === 'admin' || u.role === 'sales_manager' || u.role === 'tech_team',
  );

  async function save() {
    setBusy(true); setErr(null);
    try {
      const out = await classificationApi.reassignReviewer(engagementId, {
        reviewerUserId: pick,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onSaved(out.assignedReviewerId);
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
          background: 'color-mix(in oklch, black 35%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 460, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Reassign reviewer</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Pick a teammate to own the technical review of this opportunity.
            </div>
          </header>

          <div style={{ padding: 18, display: 'grid', gap: 10 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <button
                onClick={() => setPick(null)}
                style={{
                  textAlign: 'left',
                  padding: '8px 12px',
                  fontSize: 13,
                  background: pick == null ? 'var(--accent-tint)' : 'var(--bg-sunk)',
                  color: pick == null ? 'var(--accent)' : 'var(--fg-muted)',
                  border: `1px solid ${pick == null ? 'var(--accent)' : 'transparent'}`,
                  borderRadius: 6,
                  cursor: 'pointer',
                }}
              >
                — Unassigned —
              </button>
              {eligible.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setPick(u.id)}
                  style={{
                    textAlign: 'left',
                    padding: '8px 12px',
                    fontSize: 13,
                    background: pick === u.id ? 'var(--accent-tint)' : 'var(--bg-sunk)',
                    color: pick === u.id ? 'var(--accent)' : 'var(--fg)',
                    border: `1px solid ${pick === u.id ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 6,
                    cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  }}
                >
                  <span>{u.email}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                    color: 'var(--fg-muted)', textTransform: 'uppercase',
                  }}>{u.role}</span>
                </button>
              ))}
              {eligible.length === 0 && (
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', padding: '6px 0' }}>
                  No eligible reviewers in this tenant (admin / sales_manager / tech_team).
                </div>
              )}
            </div>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Reason (optional)</span>
              <input
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Ravi is OOO; routing to Priya"
                style={{ height: 32, fontSize: 13 }}
              />
            </label>

            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>

          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn sm accent"
              disabled={busy || (pick === currentReviewerId)}
              onClick={save}
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
