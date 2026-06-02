'use client';

import { useState } from 'react';
import { opportunities, describeError } from '@/lib/api';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';

/**
 * Delivered-stage primary (Phase F). At 'sent' the rep records the deal
 * outcome — Mark won (→ closed) or Mark lost (→ lost). At 'closed'/'lost' it
 * shows the recorded outcome. Both transitions are terminal and go through
 * opportunities.markOutcome → POST /opportunities/:id/outcome.
 */
export function DealOutcomeCard({
  engagementId,
  status,
  userRole,
  onChanged,
}: {
  engagementId: string;
  status: string;
  userRole: string;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<'won' | 'lost' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const confirm = useConfirm();
  const canAct = ['admin', 'sales_manager', 'sales_employee'].includes(userRole);

  const won = status === 'closed';
  const lost = status === 'lost';

  async function mark(outcome: 'won' | 'lost') {
    const ok = await confirm({
      title: outcome === 'won' ? 'Mark this deal won?' : 'Mark this deal lost?',
      body:
        outcome === 'won'
          ? 'The opportunity moves to Won (closed). This is terminal.'
          : 'The opportunity moves to Lost. This is terminal.',
      tone: outcome === 'won' ? 'default' : 'danger',
      confirmLabel: outcome === 'won' ? 'Mark won' : 'Mark lost',
    });
    if (!ok) return;
    setBusy(outcome);
    setErr(null);
    try {
      await opportunities.markOutcome(engagementId, outcome);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
      setBusy(null);
    }
  }

  return (
    <div
      className="card"
      style={{ padding: 22, borderLeft: '3px solid var(--accent)', boxShadow: 'var(--shadow-md)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span className="chip ok"><Icon.Send size={10} /> Delivered</span>
        {won && <span className="chip ok"><Icon.CheckCircle size={10} /> Won</span>}
        {lost && <span className="chip danger"><Icon.X size={10} /> Lost</span>}
      </div>

      {won ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          This deal was won — the client accepted. The opportunity is closed.
        </p>
      ) : lost ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          This deal was marked lost — the client declined the proposal. The opportunity is closed.
        </p>
      ) : (
        <>
          <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            Proposal delivered to the client. Record the outcome when they respond.
          </p>
          {canAct ? (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn accent" disabled={busy != null} onClick={() => void mark('won')}>
                {busy === 'won' ? <span className="spin" /> : <><Icon.CheckCircle size={12} /> Mark won</>}
              </button>
              <button className="btn ghost" disabled={busy != null} onClick={() => void mark('lost')}>
                {busy === 'lost' ? <span className="spin" /> : <><Icon.X size={11} /> Mark lost</>}
              </button>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon.Lock size={11} /> Waiting on sales to record the outcome.
            </div>
          )}
          {err && (
            <div
              style={{
                marginTop: 10,
                padding: 10,
                fontSize: 12.5,
                background: 'var(--danger-tint)',
                color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                borderRadius: 8,
              }}
            >
              {err}
            </div>
          )}
        </>
      )}
    </div>
  );
}
