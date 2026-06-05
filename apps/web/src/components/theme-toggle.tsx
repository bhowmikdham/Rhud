'use client';

/**
 * Theme system — hand-rolled (no next-themes, matching the reuse-only ethos).
 *
 * - `useTheme()` owns the user PREFERENCE ('light' | 'dark' | 'system'),
 *   persists it to localStorage, and applies the RESOLVED theme to
 *   <html data-theme> + color-scheme. The actual colors come from the
 *   `:root[data-theme="dark"]` override block in globals.css.
 * - A blocking inline script in app/layout.tsx sets data-theme BEFORE first
 *   paint, so there is no flash; this hook only drives the toggle UI and
 *   reacts to OS changes while in 'system' mode.
 */

import { useCallback, useEffect, useState } from 'react';
import { Icon } from './icon';

export type ThemePref = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'theme';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolvePref(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref;
}

/** Apply a preference to the document root (data-theme + native color-scheme). */
function applyPref(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const resolved = resolvePref(pref);
  const el = document.documentElement;
  el.dataset.theme = resolved;
  el.style.colorScheme = resolved;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>('system');
  // Avoid a hydration mismatch: the server can't know the stored preference,
  // so the toggle renders a stable placeholder until we've read localStorage.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = (localStorage.getItem(STORAGE_KEY) as ThemePref | null) ?? 'system';
    setPref(stored);
    setMounted(true);
  }, []);

  // While following the OS, re-apply when it flips light/dark.
  useEffect(() => {
    if (pref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyPref('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);

  const set = useCallback((next: ThemePref) => {
    setPref(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* private mode */ }
    applyPref(next);
  }, []);

  return { pref, resolved: resolvePref(pref), set, mounted };
}

const ORDER: ThemePref[] = ['light', 'dark', 'system'];
const META: Record<ThemePref, { icon: keyof typeof Icon; label: string }> = {
  light: { icon: 'Sun', label: 'Light' },
  dark: { icon: 'Moon', label: 'Dark' },
  system: { icon: 'Monitor', label: 'System' },
};

/**
 * Compact topbar control — one icon button that cycles
 * Light → Dark → System. The icon reflects the current preference; the
 * tooltip/aria-label names the next state so the action is discoverable.
 */
export function ThemeToggle() {
  const { pref, set, mounted } = useTheme();
  const current = META[pref];
  const next = ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]!;
  const CurrentIcon = Icon[mounted ? current.icon : 'Monitor'];

  return (
    <button
      type="button"
      onClick={() => set(next)}
      aria-label={`Theme: ${current.label}. Switch to ${META[next].label}.`}
      title={`Theme: ${current.label}`}
      style={{
        appearance: 'none', border: 0, background: 'transparent',
        width: 30, height: 30, borderRadius: 6,
        display: 'grid', placeItems: 'center', color: 'var(--fg-muted)',
        cursor: 'pointer',
        transition: 'background .15s, color .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--fg)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--fg-muted)'; }}
    >
      <CurrentIcon size={15} />
    </button>
  );
}

/**
 * Three-way segmented control for the account menu — explicit Light / Dark /
 * System choice (clearer than the cycling button when the user wants a
 * specific mode). Shares state with the toggle via localStorage + the root
 * attribute, so both stay in sync.
 */
export function ThemeSegmented() {
  const { pref, set, mounted } = useTheme();
  return (
    <div
      role="group"
      aria-label="Appearance"
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 2,
        background: 'var(--bg-sunk)', border: '1px solid var(--border)',
        borderRadius: 8, padding: 2,
      }}
    >
      {ORDER.map((opt) => {
        const active = mounted && pref === opt;
        const I = Icon[META[opt].icon];
        return (
          <button
            key={opt}
            type="button"
            onClick={() => set(opt)}
            aria-pressed={active}
            style={{
              appearance: 'none', cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              padding: '5px 6px',
              background: active ? 'var(--bg-elev)' : 'transparent',
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
              borderRadius: 6,
              fontSize: 'var(--text-xs)', fontWeight: 500,
              boxShadow: active ? 'var(--shadow-xs)' : 'none',
              transition: 'background .15s, color .15s, box-shadow .15s, border-color .15s',
            }}
          >
            <I size={13} />
            {META[opt].label}
          </button>
        );
      })}
    </div>
  );
}
