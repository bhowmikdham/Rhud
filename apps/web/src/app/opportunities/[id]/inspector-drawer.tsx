'use client';

/**
 * InspectorDrawer — a right-anchored slide-over for reference content
 * (specs, source extracts, help, whatever the caller passes as children).
 *
 * Mirrors the SlideOverDrawer pattern in lead-hud.tsx exactly: a Portal
 * holding a dim backdrop that closes on click, plus a fixed full-height
 * panel anchored to the right that slides in. Esc closes. The only
 * deltas are the public `open` gate, the narrower reference width
 * (~360-420px), and the dialog a11y attributes (role/aria-modal).
 */

import { useEffect, useState } from 'react';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';

export function InspectorDrawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  // Force a single-frame render with `mounted=false` first so the CSS
  // transition has a starting state to animate from. Without this the
  // panel just appears in place with no slide. (Same trick lead-hud uses.)
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!open) return;
    setMounted(false);
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Close on Esc while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 70,
          display: 'flex', justifyContent: 'flex-end',
          background: mounted ? 'color-mix(in oklch, black 35%, transparent)' : 'transparent',
          transition: 'background 180ms ease-out',
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <aside
          role="dialog"
          aria-modal="true"
          aria-label={title ?? 'Details'}
          style={{
            width: 'min(400px, 92vw)',
            height: '100%',
            background: 'var(--bg-elev)',
            borderLeft: '1px solid var(--border)',
            display: 'flex', flexDirection: 'column',
            transform: mounted ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 220ms ease-out',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <header style={{
            padding: '14px 18px',
            borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            flexShrink: 0,
          }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{title ?? 'Details'}</div>
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
