'use client';

/**
 * FocusJump — segmented control that switches which "focus body" the right
 * pane shows. Mirrors the accessible ViewToggle recipe in
 * apps/web/src/app/opportunities/page.tsx (role=tablist/tab, aria-selected,
 * keyboard) and reuses the existing Rhud token + Icon system. No Tailwind.
 */
import { useRef } from 'react';
import { Icon } from '@/components/icon';

interface FocusJumpItem {
  id: string;
  label: string;
  icon: keyof typeof Icon;
}

export function FocusJump({
  current,
  items,
  onSelect,
}: {
  current: string;
  items: Array<FocusJumpItem>;
  onSelect: (id: string) => void;
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Roving keyboard nav across the tablist: Arrow keys move + select the
  // neighbouring focus body, Home/End jump to the ends. Native button focus
  // handles the rest (Enter/Space activate via onClick).
  function onKeyDown(ev: React.KeyboardEvent, index: number) {
    let next = -1;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') {
      next = (index + 1) % items.length;
    } else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') {
      next = (index - 1 + items.length) % items.length;
    } else if (ev.key === 'Home') {
      next = 0;
    } else if (ev.key === 'End') {
      next = items.length - 1;
    }
    if (next < 0) return;
    ev.preventDefault();
    const item = items[next];
    if (!item) return;
    btnRefs.current[next]?.focus();
    onSelect(item.id);
  }

  return (
    <div
      role="tablist"
      aria-label="Focus"
      style={{
        display: 'flex',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        maxWidth: '100%',
        background: 'var(--bg-sunk)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 2,
        gap: 2,
      }}
    >
      {items.map((item, index) => {
        const active = item.id === current;
        const IconCmp = Icon[item.icon];
        return (
          <button
            key={item.id}
            ref={(el) => {
              btnRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`focus-tab-${item.id}`}
            aria-controls={`focus-panel-${item.id}`}
            aria-selected={active}
            aria-label={item.label}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(item.id)}
            onKeyDown={(ev) => onKeyDown(ev, index)}
            style={{
              appearance: 'none',
              cursor: 'pointer',
              flex: '0 0 auto',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              whiteSpace: 'nowrap',
              padding: '4px 10px',
              background: active ? 'var(--bg-elev)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
              borderRadius: 6,
              fontSize: 12,
              fontWeight: 500,
              boxShadow: active ? 'var(--shadow-xs)' : 'none',
              transition: 'background .15s, color .15s, box-shadow .15s, border-color .15s',
            }}
          >
            <IconCmp size={12} />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
