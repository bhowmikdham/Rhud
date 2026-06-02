'use client';

import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';
import { STAGES, stageOf, ACTOR_BY_STATUS, nextStepHint, type SideState } from './stage';

/**
 * Stage-led header for the artifact pane (Phase D). Replaces the old
 * "Opportunity state" head: a 5-station stepper showing where the deal is, the
 * status chip, a "Your turn / Waiting on X" badge, the one-line what's-next, and
 * (when it's the viewer's turn) a jump-to-action button. Lives as the first
 * flex child of .artifact-pane, so it stays put while the body scrolls.
 */
export function StageHeader({
  status,
  userRole,
  onJumpToAction,
}: {
  status: string;
  userRole: string;
  onJumpToAction?: () => void;
}) {
  const { stage, side } = stageOf(status);
  const actor = ACTOR_BY_STATUS[status] ?? { label: '', roles: [] };
  const isMyTurn = side !== 'rejected' && side !== 'lost' && actor.roles.includes(userRole);
  const activeIdx = STAGES.findIndex((s) => s.id === stage);

  return (
    <div className="artifact-head" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
      <Stepper activeIdx={activeIdx} side={side} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StageChip stage={status} />
            <TurnBadge isMyTurn={isMyTurn} actor={actor.label} side={side} />
          </div>
          <p className="artifact-sub" style={{ marginTop: 6, lineHeight: 1.5, maxWidth: '64ch' }}>
            {nextStepHint(status)}
          </p>
        </div>
        {isMyTurn && onJumpToAction && (
          <button className="btn sm accent" onClick={onJumpToAction} style={{ flexShrink: 0 }}>
            Take action <Icon.ArrowRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function Stepper({ activeIdx, side }: { activeIdx: number; side: SideState }) {
  const activeTone =
    side === 'rejected' || side === 'lost'
      ? 'var(--danger)'
      : side === 'hold'
        ? 'var(--warn)'
        : 'var(--accent)';
  return (
    <div style={{ display: 'flex', alignItems: 'center' }}>
      {STAGES.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        const tone = active ? activeTone : 'var(--accent)';
        const I = Icon[s.icon];
        return (
          <div key={s.id} style={{ display: 'contents' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span
                aria-current={active ? 'step' : undefined}
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 999,
                  display: 'grid',
                  placeItems: 'center',
                  background: done
                    ? 'var(--accent)'
                    : active
                      ? `color-mix(in oklch, ${tone} 14%, transparent)`
                      : 'var(--bg-sunk)',
                  color: done ? 'var(--accent-fg)' : active ? tone : 'var(--fg-faint)',
                  border: '1.5px solid ' + (done ? 'var(--accent)' : active ? tone : 'var(--border)'),
                  transition: 'all .2s',
                }}
              >
                {done ? <Icon.Check size={12} sw={2.4} /> : <I size={11} />}
              </span>
              <span
                style={{
                  fontSize: 10,
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--fg)' : done ? 'var(--fg-muted)' : 'var(--fg-faint)',
                }}
              >
                {s.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div
                aria-hidden
                style={{
                  flex: 1,
                  height: 2,
                  margin: '0 6px 16px',
                  borderRadius: 2,
                  background: i < activeIdx ? 'var(--accent)' : 'var(--border)',
                  transition: 'background .2s',
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TurnBadge({ isMyTurn, actor, side }: { isMyTurn: boolean; actor: string; side: SideState }) {
  if (side === 'rejected' || side === 'lost') {
    return <span className="chip danger"><Icon.X size={10} /> {side === 'lost' ? 'Lost' : 'Rejected'}</span>;
  }
  if (isMyTurn) {
    return (
      <span className="chip ok" style={{ fontWeight: 600 }}>
        <Icon.Zap size={10} /> Your turn
      </span>
    );
  }
  if (!actor) return null;
  return (
    <span className="chip">
      <Icon.Clock size={10} /> Waiting on {actor}
    </span>
  );
}
