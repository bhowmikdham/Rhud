'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Portal } from './portal';

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell — backdrop + centered slot, with the three things
 * hand-rolled modals usually miss: a focus-trap (Tab can't escape the
 * dialog), Esc-to-close, and focus return to whatever opened it. Built on
 * Portal. The caller styles its own `.card` as `children`; this only owns the
 * backdrop, centering, and keyboard/focus behaviour.
 *
 * Pass `label` (or `labelledBy` pointing at a heading id) for the dialog's
 * accessible name. `busy` blocks Esc/backdrop close during an in-flight action.
 */
export function Overlay({
  onClose,
  children,
  label,
  labelledBy,
  closeOnBackdrop = true,
  busy = false,
  zIndex = 60,
}: {
  onClose(): void;
  children: ReactNode;
  label?: string;
  labelledBy?: string;
  closeOnBackdrop?: boolean;
  busy?: boolean;
  zIndex?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = (document.activeElement as HTMLElement) ?? null;
    const node = ref.current;
    const focusables = (): HTMLElement[] =>
      node
        ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null)
        : [];

    // Move focus into the dialog (first focusable, else the dialog itself).
    (focusables()[0] ?? node)?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Return focus to the trigger so keyboard users aren't dumped at the top.
      restoreRef.current?.focus?.();
    };
  }, [onClose, busy]);

  return (
    <Portal>
      <div
        onClick={(e) => {
          if (closeOnBackdrop && e.target === e.currentTarget && !busy) onClose();
        }}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid',
          placeItems: 'center',
          zIndex,
          padding: 16,
        }}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
          {...(label ? { 'aria-label': label } : {})}
          tabIndex={-1}
          style={{ outline: 'none', maxWidth: '100%' }}
        >
          {children}
        </div>
      </div>
    </Portal>
  );
}
