'use client';

/**
 * Tiny action menu — the "···" button most table rows + detail headers
 * want. Opens a popover anchored under the trigger. One click outside
 * or Esc closes it.
 *
 * Items are rendered as a flat list with optional icon + danger
 * styling. Designed for ≤ 6 items; add a divider via { divider: true }.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icon';
import { Portal } from './portal';

interface MenuPosition {
  /** Position fixed coords for the menu — relative to viewport. */
  top: number;
  left: number;
}

export interface RowActionItem {
  label: string;
  onClick(): void;
  /** Match against the `Icon` map keys. Optional. */
  icon?: keyof typeof Icon;
  /** Renders the row in danger styling (red text, red hover). */
  danger?: boolean;
  /** Disable the row (greyed out, no click). */
  disabled?: boolean;
  /** Hover tooltip — useful when an item is disabled to explain why. */
  title?: string | undefined;
}

export interface RowActionDivider {
  divider: true;
}

export type RowAction = RowActionItem | RowActionDivider;

interface Props {
  items: RowAction[];
  /** Sizing tweak — `sm` for table rows, default for headers. */
  size?: 'sm' | 'md';
  /** Stop the click bubbling up so a clickable parent row doesn't fire. */
  stopPropagation?: boolean;
  ariaLabel?: string;
}

export function RowActions({ items, size = 'md', stopPropagation, ariaLabel = 'Actions' }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Compute the popover position from the trigger's + menu's actual
  // rects. Must be called AFTER the menu element is in the DOM,
  // otherwise we'd guess at the height and end up far above the
  // trigger (the bug that prompted this — the Portal mounts in its
  // own useEffect, so any layout effect here runs before measurement
  // is possible). The ref callback below drives this on first mount.
  const placeMenu = useCallback(() => {
    const btn = triggerRef.current;
    const menu = menuRef.current;
    if (!btn || !menu) return;
    const r = btn.getBoundingClientRect();
    const menuHeight = menu.offsetHeight;
    const menuWidth = menu.offsetWidth;
    const gap = 4;
    const margin = 8;

    // Flip up if the menu would overflow the viewport below the trigger.
    const spaceBelow = window.innerHeight - r.bottom - margin;
    const flipped = menuHeight + gap > spaceBelow;
    const top = flipped ? r.top - gap - menuHeight : r.bottom + gap;

    // Right-align to the trigger's right edge, then clamp to viewport so
    // a right-edge trigger doesn't push the menu off-screen.
    let left = r.right - menuWidth;
    left = Math.max(margin, Math.min(left, window.innerWidth - menuWidth - margin));

    setPos({ top, left });
  }, []);

  // Ref callback: fires when the portaled menu element actually attaches
  // to the DOM. That's the right moment to measure + place — `useLayoutEffect`
  // would race with the Portal's own mount-after-paint behaviour.
  const setMenuRef = useCallback((el: HTMLDivElement | null) => {
    menuRef.current = el;
    if (el) placeMenu();
  }, [placeMenu]);

  useEffect(() => {
    if (!open) return;

    const close = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      // Allow clicks on the trigger or anywhere inside the portaled menu.
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const reposition = () => placeMenu();

    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', reposition, true); // capture: catches scroll on any ancestor
    window.addEventListener('resize', reposition);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, placeMenu]);

  // Reset position when closing so the next open starts in a hidden
  // state (no flash of last-known location).
  useEffect(() => {
    if (!open) setPos(null);
  }, [open]);

  const buttonSize = size === 'sm' ? 24 : 28;

  return (
    <span
      style={{ display: 'inline-block' }}
      onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          appearance: 'none', cursor: 'pointer',
          width: buttonSize, height: buttonSize, borderRadius: 6,
          background: open ? 'var(--bg-sunk)' : 'transparent',
          border: '1px solid ' + (open ? 'var(--border)' : 'transparent'),
          display: 'grid', placeItems: 'center',
          color: 'var(--fg-muted)',
          transition: 'background .12s, border-color .12s',
        }}
        onMouseEnter={(e) => { if (!open) e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={(e) => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon.MoreHorizontal size={size === 'sm' ? 13 : 15} />
      </button>

      {open && (
        <Portal>
        <div
          ref={setMenuRef}
          role="menu"
          style={{
            position: 'fixed',
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            // Render off-screen until measured, then snap into place. Avoids
            // a one-frame flash at the wrong coords.
            opacity: pos ? 1 : 0,
            minWidth: 200,
            background: 'var(--bg)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 12px 32px rgba(0,0,0,.10), 0 2px 6px rgba(0,0,0,.06)',
            padding: 4,
            zIndex: 80,
          }}
          onClick={(e) => { if (stopPropagation) e.stopPropagation(); }}
        >
          {items.map((it, i) => {
            if ('divider' in it) {
              return <div key={`d-${i}`} style={{ height: 1, background: 'var(--divider)', margin: '4px 0' }} />;
            }
            const I = it.icon ? Icon[it.icon] : null;
            const color = it.danger ? 'var(--danger)' : 'var(--fg)';
            return (
              <button
                key={it.label + i}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                title={it.title}
                onClick={() => {
                  if (it.disabled) return;
                  setOpen(false);
                  it.onClick();
                }}
                style={{
                  appearance: 'none', border: 0, cursor: it.disabled ? 'not-allowed' : 'pointer',
                  width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 10px', background: 'transparent',
                  fontSize: 12.5, color, textAlign: 'left',
                  borderRadius: 6,
                  opacity: it.disabled ? 0.5 : 1,
                  transition: 'background .12s',
                }}
                onMouseEnter={(e) => {
                  if (it.disabled) return;
                  e.currentTarget.style.background = it.danger ? 'var(--danger-tint)' : 'var(--bg-hover)';
                }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {I && <span style={{ color: it.danger ? 'var(--danger)' : 'var(--fg-subtle)' }}><I size={13} /></span>}
                {it.label}
              </button>
            );
          })}
        </div>
        </Portal>
      )}
    </span>
  );
}
