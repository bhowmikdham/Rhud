'use client';

/**
 * Drop-in replacement for `window.confirm()` that renders a styled,
 * Portal-mounted modal instead of the browser's native dialog.
 *
 * Usage:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: 'Regenerate?', body: '...' }))) return;
 *
 * Pattern matches the native confirm() so existing call sites swap with
 * a one-line edit. The promise resolves to `true` on confirm, `false`
 * on cancel / esc / backdrop-click.
 *
 * Tone variants:
 *   - default → neutral, accent-coloured Confirm button (regenerate, mark-sent)
 *   - warn    → amber accents (revert, archive)
 *   - danger  → red accents (clear key, revoke invite)
 *
 * Mount <ConfirmProvider> once near the app root. Anywhere underneath
 * gets `useConfirm()` for free.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon } from './icon';
import { Portal } from './portal';

export type ConfirmTone = 'default' | 'warn' | 'danger';

export interface ConfirmOptions {
  title: string;
  body: ReactNode;
  tone?: ConfirmTone;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Override the icon drawn in the header circle. */
  icon?: keyof typeof Icon;
}

type Confirm = (opts: ConfirmOptions) => Promise<boolean>;

const Ctx = createContext<Confirm | null>(null);

interface PendingConfirm extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);
  pendingRef.current = pending;

  const confirm = useCallback<Confirm>((opts) => {
    return new Promise<boolean>((resolve) => {
      // If a confirm is already open, immediately reject the prior one
      // (cancel) so callers can't stack dialogs.
      if (pendingRef.current) pendingRef.current.resolve(false);
      setPending({ ...opts, resolve });
    });
  }, []);

  const close = useCallback((ok: boolean) => {
    setPending((p) => {
      if (p) p.resolve(ok);
      return null;
    });
  }, []);

  return (
    <Ctx.Provider value={confirm}>
      {children}
      {pending && <ConfirmDialog opts={pending} onClose={close} />}
    </Ctx.Provider>
  );
}

export function useConfirm(): Confirm {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return c;
}

// ── Dialog ───────────────────────────────────────────────────────────────

function ConfirmDialog({
  opts,
  onClose,
}: {
  opts: ConfirmOptions;
  onClose(ok: boolean): void;
}) {
  const tone: ConfirmTone = opts.tone ?? 'default';
  const confirmLabel = opts.confirmLabel ?? 'Confirm';
  const cancelLabel = opts.cancelLabel ?? 'Cancel';
  const iconName: keyof typeof Icon =
    opts.icon ?? (tone === 'danger' ? 'X' : tone === 'warn' ? 'Sparkle' : 'Sparkles');
  const I = Icon[iconName];

  // Esc cancels; tabbing into the page from elsewhere doesn't hijack focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const iconBg = tone === 'danger' ? 'var(--danger-tint)' : tone === 'warn' ? 'var(--warn-tint)' : 'var(--accent-tint)';
  const iconColor = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--accent)';
  const buttonClass = tone === 'danger' ? 'btn sm danger' : tone === 'warn' ? 'btn sm' : 'btn sm accent';

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 'var(--z-modal)', padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(false); }}
      >
        <div
          className="card"
          role="alertdialog"
          aria-labelledby="confirm-title"
          style={{ width: '100%', maxWidth: 440, background: 'var(--bg)' }}
        >
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
            <span style={{
              width: 28, height: 28, borderRadius: 999,
              background: iconBg, color: iconColor,
              display: 'grid', placeItems: 'center', flexShrink: 0,
            }}>
              <I size={14} sw={2.2} />
            </span>
            <div id="confirm-title" style={{ fontSize: 14, fontWeight: 600, paddingTop: 4 }}>
              {opts.title}
            </div>
          </header>

          <div style={{ padding: '14px 18px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            {opts.body}
          </div>

          <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => onClose(false)} className="btn sm ghost">{cancelLabel}</button>
            <button onClick={() => onClose(true)} className={buttonClass} autoFocus>
              {confirmLabel}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}
