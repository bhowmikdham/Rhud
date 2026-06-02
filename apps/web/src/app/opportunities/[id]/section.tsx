'use client';

import { useState, type ReactNode } from 'react';
import { Icon } from '@/components/icon';

/**
 * Collapsible reference section (Phase E). A thin clickable header bar; the
 * child (its own `.card`) renders below only when open — so collapsed sections
 * don't clutter the page and, by default, don't even mount (no fetch / no poll
 * for panels that self-load on mount).
 *
 * `keepMounted` keeps the child mounted (hidden via display) instead of
 * unmounting — use it for panels with in-progress edits (assumptions, line
 * items) so a draft survives a collapse. `defaultOpen` opens it on first
 * render (drive this off the lifecycle stage so the relevant section leads).
 */
export function Section({
  title,
  badge,
  defaultOpen = false,
  keepMounted = false,
  children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  keepMounted?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="card"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 16px',
          cursor: 'pointer',
          textAlign: 'left',
          background: 'var(--bg-elev)',
          font: 'inherit',
          color: 'var(--fg)',
          transition: 'background .15s',
        }}
      >
        <Icon.ChevronRight
          size={14}
          style={{
            color: 'var(--fg-subtle)',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform .15s',
            flexShrink: 0,
          }}
        />
        <h3 className="section-label" style={{ flex: 1, margin: 0, scrollMarginTop: 96 }}>
          {title}
        </h3>
        {badge}
      </button>
      {keepMounted ? (
        <div style={{ marginTop: 8, display: open ? 'block' : 'none' }}>{children}</div>
      ) : (
        open && <div style={{ marginTop: 8 }}>{children}</div>
      )}
    </div>
  );
}
