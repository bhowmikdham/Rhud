'use client';

import { Icon } from './icon';

interface ComingSoonProps {
  title: string;
  subtitle?: string;
  sprint: string;
  bullets: string[];
  iconName: keyof typeof Icon;
}

/**
 * Generic "this surface lands in sprint X" placeholder. Keeps the visual
 * language consistent with shipped pages (page-header + card) so the
 * sidebar links don't dump users onto an empty screen.
 */
export function ComingSoon({ title, subtitle, sprint, bullets, iconName }: ComingSoonProps) {
  const I = Icon[iconName];
  return (
    <div className="page-inner" style={{ maxWidth: 720 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
      </div>

      <div className="card" style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16 }}>
          <div
            style={{
              width: 44, height: 44, borderRadius: 12,
              background: 'var(--accent-tint)',
              color: 'var(--accent)',
              display: 'grid', placeItems: 'center',
              flexShrink: 0,
            }}
          >
            <I size={22} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="section-label">Coming up</div>
            <h2 style={{ margin: '6px 0 4px', fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>
              Lands in {sprint}
            </h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0, lineHeight: 1.55 }}>
              The data model and contracts are already in place — this is where the UI surface goes once the backing service is wired.
            </p>

            <ul style={{ margin: '14px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
              {bullets.map((b) => <li key={b}>{b}</li>)}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
