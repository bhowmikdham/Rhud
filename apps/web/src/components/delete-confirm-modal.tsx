'use client';

/**
 * Reusable delete-confirmation modal.
 *
 * Two modes:
 *   - simple confirm (default): one-click Delete button
 *   - type-to-confirm: caller passes `confirmPhrase` and the user must
 *     type it into a field before Delete enables. Use for irreversible
 *     deletes that take a lot of data with them (rate cards, templates
 *     with engagements, etc.).
 *
 * Renders through Portal so the dim overlay covers the whole viewport
 * regardless of any transformed ancestors. Body styling matches the
 * danger semantics (red accents, danger button) without being scary.
 */

import { useEffect, useState } from 'react';
import { Icon } from './icon';
import { Portal } from './portal';

export interface DeleteConfirmModalProps {
  /** Modal title — "Delete opportunity", "Delete template", etc. */
  title: string;
  /** Bold subject line — the item's name / identifier. */
  subject: string;
  /** Plain explanation of what gets removed. Multiple paragraphs OK. */
  description: React.ReactNode;
  /** When provided, user must type this exact string to enable Delete. */
  confirmPhrase?: string;
  /** Force the Delete button label (defaults to "Delete"). */
  deleteLabel?: string;
  /** When set, the modal renders in a "blocked" state — Delete is
   *  disabled and the message replaces the action area (e.g. a template
   *  with active engagements that can't be removed). */
  blockedReason?: React.ReactNode;
  onCancel(): void;
  onConfirm(): Promise<void>;
}

export function DeleteConfirmModal({
  title,
  subject,
  description,
  confirmPhrase,
  deleteLabel = 'Delete',
  blockedReason,
  onCancel,
  onConfirm,
}: DeleteConfirmModalProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc closes — keyboard users shouldn't be trapped.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const phraseOk = !confirmPhrase || typed.trim() === confirmPhrase;
  const canDelete = !blockedReason && phraseOk && !busy;

  async function fire() {
    if (!canDelete) return;
    setBusy(true); setErr(null);
    try {
      await onConfirm();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 'var(--z-modal)', padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}
      >
        <div
          className="card"
          role="alertdialog"
          aria-labelledby="delete-confirm-title"
          style={{ width: '100%', maxWidth: 460, background: 'var(--bg)' }}
        >
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 999,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <Icon.X size={14} sw={2.4} />
            </span>
            <div>
              <div id="delete-confirm-title" style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                This action can&apos;t be undone.
              </div>
            </div>
          </header>

          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 13, lineHeight: 1.5 }}>
              You&apos;re about to delete <b>{subject}</b>.
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
              {description}
            </div>

            {blockedReason && (
              <div style={{
                padding: 12, fontSize: 12.5,
                background: 'var(--warn-tint)', color: 'var(--warn)',
                border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
                borderRadius: 8,
              }}>
                {blockedReason}
              </div>
            )}

            {confirmPhrase && !blockedReason && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
                  Type <span className="mono" style={{ background: 'var(--bg-sunk)', padding: '1px 6px', borderRadius: 4 }}>{confirmPhrase}</span> to confirm
                </span>
                <input
                  className="input"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  autoComplete="off"
                  disabled={busy}
                  style={{ height: 32, padding: '0 10px', fontSize: 13 }}
                />
              </label>
            )}

            {err && (
              <div style={{
                padding: 10, fontSize: 12.5,
                background: 'var(--danger-tint)', color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                borderRadius: 8,
              }}>{err}</div>
            )}
          </div>

          <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
            {!blockedReason && (
              <button onClick={fire} disabled={!canDelete} className="btn sm danger">
                {busy ? <span className="spin" /> : <><Icon.X size={11} sw={2.2} /> {deleteLabel}</>}
              </button>
            )}
          </footer>
        </div>
      </div>
    </Portal>
  );
}
