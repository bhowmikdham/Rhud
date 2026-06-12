'use client';

/**
 * Gamma connect / manage modal. A tabbed shell hosting two panels:
 *  - "Connection" — the API key + workspace fields + proposal-driver picker
 *    (the existing connection config; see ./gamma/gamma-connection-panel).
 *  - "Templates"  — the multi-template library (manage actions gated to
 *    admin + sales_manager via the canManage flag).
 *
 * The outer chrome (Portal, header/title, close) lives here; each tab owns
 * its own body padding + footer.
 */

import { useState } from 'react';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { GammaConnectionPanel } from './gamma/gamma-connection-panel';
import { GammaTemplatesPanel } from './gamma/gamma-templates-panel';

interface Props {
  onClose(): void;
  /** Admins + sales managers may mutate the template library; others view only. */
  canManage?: boolean;
}

type TabId = 'connection' | 'templates';

const TABS: { id: TabId; label: string }[] = [
  { id: 'connection', label: 'Connection' },
  { id: 'templates', label: 'Templates' },
];

export function GammaConnectModal({ onClose, canManage = false }: Props) {
  const [tab, setTab] = useState<TabId>('connection');

  return (
    <Portal>
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid', placeItems: 'center', zIndex: 'var(--z-modal)', padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{ width: '100%', maxWidth: 560, background: 'var(--bg)', maxHeight: '92vh', overflow: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              <span style={{
                display: 'inline-grid', placeItems: 'center',
                width: 18, height: 18, borderRadius: 4,
                background: 'oklch(0.55 0.18 320)', color: '#fff',
                fontSize: 10, fontWeight: 700, marginRight: 6,
                verticalAlign: -3,
              }}>G</span>
              Gamma — connect your account
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4 }}>
              Generate proposal decks via Gamma&apos;s Generate API. Get your key from{' '}
              <a href="https://gamma.app/account" target="_blank" rel="noopener" style={{ color: 'var(--fg-muted)', textDecoration: 'underline' }}>
                gamma.app/account
              </a>.
            </div>
          </div>
          <button onClick={onClose} className="btn sm ghost"><Icon.X size={11} /></button>
        </header>

        <nav
          role="tablist"
          aria-label="Gamma settings"
          style={{ display: 'flex', gap: 2, padding: '8px 12px 0', borderBottom: '1px solid var(--divider)' }}
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                style={{
                  appearance: 'none', cursor: 'pointer',
                  padding: '7px 12px 9px',
                  background: 'transparent',
                  color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  border: 0,
                  borderBottom: '2px solid ' + (active ? 'var(--accent)' : 'transparent'),
                  marginBottom: -1,
                  fontSize: 12.5, fontWeight: active ? 600 : 400,
                  transition: 'color .15s, border-color .15s',
                }}
              >
                {t.label}
              </button>
            );
          })}
        </nav>

        <div style={{ minHeight: 0 }}>
          {tab === 'connection' && <GammaConnectionPanel onClose={onClose} />}
          {tab === 'templates' && <GammaTemplatesPanel canManage={canManage} />}
        </div>
      </div>
    </div>
    </Portal>
  );
}
