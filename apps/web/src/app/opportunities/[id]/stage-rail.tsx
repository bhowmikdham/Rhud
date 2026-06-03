'use client';

import type React from 'react';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';
import { STAGES, stageOf, ACTOR_BY_STATUS, type SideState } from './stage';

/**
 * Slim, one-line replacement for StageHeader. Condenses the 5-station stepper
 * into five small dots + the active-stage label, then the status chip, the
 * "Your turn / Waiting on X" badge, and (pushed right) the optional primary CTA
 * plus a "Jump" button and an icon-only "Details" inspector toggle. Reuses the
 * .artifact-head row so it sits as the first flex child of .artifact-pane and
 * stays put while the body scrolls.
 */
export function StageRail({
  status,
  userRole,
  primaryCta,
  onJump,
  onInspector,
}: {
  status: string;
  userRole: string;
  primaryCta?: React.ReactNode;
  onJump: () => void;
  onInspector: () => void;
}) {
  const { stage, side } = stageOf(status);
  const actor = ACTOR_BY_STATUS[status] ?? { label: '', roles: [] };
  const rawIdx = STAGES.findIndex((s) => s.id === stage);
  const activeIdx = rawIdx === -1 ? 0 : rawIdx;
  const activeLabel = (STAGES[activeIdx] ?? STAGES[0]!).label;

  return (
    <div className="artifact-head" style={{ gap: 12 }}>
      {/* left: stage dots + active label, status chip, turn badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' }}>
        <StageDots activeIdx={activeIdx} activeLabel={activeLabel} side={side} />
        <StageChip stage={status} />
        <TurnBadge status={status} userRole={userRole} actor={actor} side={side} />
      </div>

      {/* right: optional primary CTA + jump + inspector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        {primaryCta}
        <button className="btn sm ghost" onClick={onJump} style={{ transition: 'background .18s, border-color .18s' }}>
          <Icon.Hash size={12} /> Jump
        </button>
        <button
          className="btn sm ghost"
          onClick={onInspector}
          aria-label="Details"
          title="Details"
          style={{ padding: '0 8px', transition: 'background .18s, border-color .18s' }}
        >
          <Icon.Inbox size={14} />
        </button>
      </div>
    </div>
  );
}

function StageDots({
  activeIdx,
  activeLabel,
  side,
}: {
  activeIdx: number;
  activeLabel: string;
  side: SideState;
}) {
  const ringTone =
    side === 'rejected' || side === 'lost'
      ? 'var(--danger)'
      : side === 'hold' || side === 'expired'
        ? 'var(--warn)'
        : 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {STAGES.map((s, i) => {
          const done = i < activeIdx;
          const active = i === activeIdx;
          return (
            <span
              key={s.id}
              aria-current={active ? 'step' : undefined}
              title={s.label}
              style={{
                width: active ? 10 : 8,
                height: active ? 10 : 8,
                borderRadius: 999,
                flexShrink: 0,
                background: done
                  ? 'var(--accent)'
                  : active
                    ? `color-mix(in oklch, ${ringTone} 18%, transparent)`
                    : 'var(--bg-sunk)',
                border:
                  '1.5px solid ' +
                  (done ? 'var(--accent)' : active ? ringTone : 'var(--border)'),
                boxShadow: active ? `0 0 0 3px color-mix(in oklch, ${ringTone} 12%, transparent)` : 'none',
                transition: 'all .2s',
              }}
            />
          );
        })}
      </div>
      <span
        className="section-label"
        style={{ color: 'var(--fg)', whiteSpace: 'nowrap' }}
      >
        {activeLabel}
      </span>
    </div>
  );
}

function TurnBadge({
  status,
  userRole,
  actor,
  side,
}: {
  status: string;
  userRole: string;
  actor: { label: string; roles: string[] };
  side: SideState;
}) {
  if (side === 'rejected' || side === 'lost') {
    return (
      <span className="chip danger">
        <Icon.X size={10} /> {side === 'lost' ? 'Lost' : 'Rejected'}
      </span>
    );
  }
  const isMyTurn = actor.roles.includes(userRole);
  if (isMyTurn) {
    return (
      <span className="chip ok" style={{ fontWeight: 600 }}>
        <Icon.Zap size={10} /> Your turn
      </span>
    );
  }
  if (!actor.label) return null;
  return (
    <span className="chip">
      <Icon.Clock size={10} /> Waiting on {actor.label}
    </span>
  );
}
