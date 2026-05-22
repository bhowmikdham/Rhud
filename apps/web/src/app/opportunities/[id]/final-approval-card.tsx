'use client';

/**
 * Phase C — VP / CEO final-approval card.
 *
 * Mounts on the opportunity detail page when status is one of:
 *   - pending_vp_approval   → vp_sales (or admin / ceo) can act
 *   - pending_ceo_approval  → only ceo (or admin) can act
 *
 * Renders:
 *   - The provisional approved price + the gate level
 *   - Approve / Reject buttons gated by role
 *   - Reject demands a reason
 */

import { useState } from 'react';
import {
  describeError,
  predictions,
  type Role,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';

interface Props {
  engagementId: string;
  level: 'vp' | 'ceo';
  approvedPriceCents: number | null;
  currency: string;
  userRole: Role | string;
  onChanged(): void;
}

export function FinalApprovalCard({
  engagementId, level, approvedPriceCents, currency, userRole, onChanged,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [approveComment, setApproveComment] = useState('');

  const canAct =
    userRole === 'admin'
    || userRole === 'ceo'
    || (level === 'vp' && userRole === 'vp_sales');

  const gateLabel = level === 'ceo' ? 'CEO sign-off' : 'VP Sales sign-off';
  const tone = level === 'ceo' ? '#7c3aed' /* purple */ : '#0e7490' /* teal */;

  async function approve() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await predictions.finalApprove(engagementId, approveComment.trim() || undefined);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitReject() {
    if (busy || !reason.trim()) return;
    setBusy(true); setErr(null);
    try {
      await predictions.finalReject(engagementId, reason.trim());
      setRejecting(false);
      setReason('');
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const formattedPrice = approvedPriceCents != null
    ? `${currency} ${(approvedPriceCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : '—';

  return (
    <div
      className="card"
      style={{
        padding: 22,
        marginBottom: 16,
        borderLeft: `4px solid ${tone}`,
        background: `color-mix(in oklch, ${tone} 6%, var(--bg))`,
      }}
    >
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10, marginBottom: 12,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: tone, letterSpacing: 0.6, textTransform: 'uppercase' }}>
            Awaiting {gateLabel}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>
            Sales manager approved at <span style={{ color: tone }}>{formattedPrice}</span> —
            requires final sign-off before going to client.
          </div>
        </div>
        <span style={{
          fontSize: 10, fontWeight: 700, padding: '3px 8px', letterSpacing: 0.6,
          background: tone, color: '#fff', borderRadius: 999,
        }}>
          {level === 'ceo' ? 'CEO' : 'VP'}
        </span>
      </header>

      {!canAct ? (
        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Only {gateLabel} (or an admin) can act on this. The decision will appear in the
          timeline once it's made.
        </div>
      ) : !rejecting ? (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Comment (optional)</span>
            <textarea
              className="input"
              rows={2}
              value={approveComment}
              onChange={(e) => setApproveComment(e.target.value)}
              placeholder="e.g. Approved — strong strategic account"
              style={{ fontSize: 13 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn sm danger ghost" disabled={busy} onClick={() => setRejecting(true)}>
              <Icon.X size={11} /> Reject
            </button>
            <button className="btn sm accent" disabled={busy} onClick={approve}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Approve</>}
            </button>
          </div>
        </>
      ) : (
        <RejectPanel
          reason={reason}
          setReason={setReason}
          onCancel={() => { setRejecting(false); setReason(''); }}
          onSubmit={submitReject}
          busy={busy}
        />
      )}

      {err && (
        <div style={{ marginTop: 8, padding: 8, fontSize: 12, color: 'var(--danger)', background: 'var(--danger-tint)', borderRadius: 6 }}>
          {err}
        </div>
      )}
    </div>
  );
}

function RejectPanel({
  reason, setReason, onCancel, onSubmit, busy,
}: {
  reason: string;
  setReason(v: string): void;
  onCancel(): void;
  onSubmit(): void;
  busy: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
          Reason for rejection <span style={{ color: 'var(--danger)' }}>(required)</span>
        </span>
        <textarea
          className="input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Price is below margin floor; sales manager to renegotiate scope"
          style={{ fontSize: 13 }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn sm ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="btn sm danger" disabled={busy || !reason.trim()} onClick={onSubmit}>
          {busy ? <span className="spin" /> : <><Icon.X size={11} /> Confirm reject</>}
        </button>
      </div>
    </div>
  );
}
