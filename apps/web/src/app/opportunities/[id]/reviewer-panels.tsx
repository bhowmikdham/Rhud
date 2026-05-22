'use client';

/**
 * Phase A — reviewer-facing UI on the opportunity detail page.
 *
 * Three panels exposed here:
 *   • AssumptionsExclusionsCard — free-text assumptions, exclusions,
 *     and an optional delivery-timeline override. Editable by tech
 *     reviewer / sales manager / admin.
 *   • QuoteLineItemsCard — add/edit/remove travel, tool, resource,
 *     discount, and custom line items on the quote. Recomputed
 *     totals shown alongside the rate-card base.
 *   • ReviewerHoldActions — three small ghost buttons on the
 *     approval card row (Send Back / Request Clarification /
 *     Escalate), each opening a small reason-modal.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  describeError,
  opportunities,
  quoteLineItems,
  type CreateQuoteLineItemInput,
  type QuoteLineItemKind,
  type QuoteLineItemRow,
  type QuoteTotalsBreakdown,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

// ── Assumptions / Exclusions / Timeline ─────────────────────────────

interface ScopeFieldsProps {
  engagementId: string;
  userRole: string;
  initial: {
    assumptions: string | null;
    exclusions: string | null;
    deliveryTimelineOverride: string | null;
  };
  onSaved?(next: {
    assumptions: string | null;
    exclusions: string | null;
    deliveryTimelineOverride: string | null;
  }): void;
}

export function AssumptionsExclusionsCard({
  engagementId, userRole, initial, onSaved,
}: ScopeFieldsProps) {
  const canEdit = ['admin', 'sales_manager', 'tech_team'].includes(userRole);
  const [assumptions, setAssumptions] = useState(initial.assumptions ?? '');
  const [exclusions, setExclusions] = useState(initial.exclusions ?? '');
  const [timeline, setTimeline] = useState(initial.deliveryTimelineOverride ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty = useMemo(() => {
    const norm = (v: string) => v.trim();
    return (
      norm(assumptions) !== (initial.assumptions ?? '').trim()
      || norm(exclusions) !== (initial.exclusions ?? '').trim()
      || norm(timeline) !== (initial.deliveryTimelineOverride ?? '').trim()
    );
  }, [assumptions, exclusions, timeline, initial]);

  useEffect(() => {
    setAssumptions(initial.assumptions ?? '');
    setExclusions(initial.exclusions ?? '');
    setTimeline(initial.deliveryTimelineOverride ?? '');
  }, [initial.assumptions, initial.exclusions, initial.deliveryTimelineOverride]);

  async function save() {
    if (!dirty || busy) return;
    setBusy(true); setErr(null); setSaved(false);
    try {
      const out = await opportunities.updateScope(engagementId, {
        assumptions: assumptions.trim() || null,
        exclusions: exclusions.trim() || null,
        deliveryTimelineOverride: timeline.trim() || null,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onSaved?.({
        assumptions: out.assumptions,
        exclusions: out.exclusions,
        deliveryTimelineOverride: out.deliveryTimelineOverride,
      });
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 18 }}>
      <header style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Reviewer notes</h2>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
          Assumptions, exclusions, and timeline overrides. These print verbatim on the proposal.
        </div>
      </header>

      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Assumptions" hint="One per line. Things you're assuming are true.">
          <textarea
            className="input"
            value={assumptions}
            onChange={(e) => setAssumptions(e.target.value)}
            disabled={!canEdit || busy}
            rows={4}
            placeholder="e.g.&#10;Client provides VPN access by Day 1&#10;Testing window is 10 working days"
            style={{ fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
          />
        </Field>

        <Field label="Exclusions" hint="One per line. Explicit out-of-scope items.">
          <textarea
            className="input"
            value={exclusions}
            onChange={(e) => setExclusions(e.target.value)}
            disabled={!canEdit || busy}
            rows={4}
            placeholder="e.g.&#10;DoS / DDoS testing&#10;Source-code review&#10;Mobile applications"
            style={{ fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
          />
        </Field>

        <Field label="Delivery timeline override" hint="Leave empty to use the template default.">
          <input
            className="input"
            value={timeline}
            onChange={(e) => setTimeline(e.target.value)}
            disabled={!canEdit || busy}
            placeholder="e.g. 10 working days from PO, excluding weekends"
            style={{ height: 32, fontSize: 13 }}
          />
        </Field>

        {err && (
          <div style={{ padding: 8, fontSize: 12, color: 'var(--danger)', background: 'var(--danger-tint)', borderRadius: 6 }}>
            {err}
          </div>
        )}

        {canEdit && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {saved && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Icon.Check size={11} /> Saved</span>}
            <button
              className="btn sm"
              disabled={!dirty || busy}
              onClick={() => {
                setAssumptions(initial.assumptions ?? '');
                setExclusions(initial.exclusions ?? '');
                setTimeline(initial.deliveryTimelineOverride ?? '');
              }}
            >Reset</button>
            <button
              className="btn sm accent"
              disabled={!dirty || busy}
              onClick={save}
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save notes</>}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{hint}</span>}
    </label>
  );
}

// ── Quote line items ─────────────────────────────────────────────────

const KIND_LABELS: Record<QuoteLineItemKind, string> = {
  travel: 'Travel',
  tool: 'Tool',
  resource: 'Resource',
  discount: 'Discount',
  custom: 'Custom',
};

const KIND_COLORS: Record<QuoteLineItemKind, string> = {
  travel: '#558',
  tool: '#586',
  resource: '#856',
  discount: 'var(--danger)',
  custom: 'var(--fg-muted)',
};

interface LineItemsProps {
  engagementId: string;
  userRole: string;
  currency: string;
}

export function QuoteLineItemsCard({ engagementId, userRole, currency }: LineItemsProps) {
  const confirm = useConfirm();
  const canEdit = ['admin', 'sales_manager', 'tech_team'].includes(userRole);
  const [data, setData] = useState<QuoteTotalsBreakdown | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    quoteLineItems.list(engagementId).then(setData).catch((e) => setErr(describeError(e)));
  }, [engagementId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function remove(item: QuoteLineItemRow) {
    const ok = await confirm({
      title: 'Remove line item?',
      body: `${KIND_LABELS[item.kind]}: ${item.label}`,
      tone: 'warn',
      confirmLabel: 'Remove',
    });
    if (!ok) return;
    try {
      await quoteLineItems.remove(engagementId, item.id);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    }
  }

  if (!data) return null;
  if (!canEdit && data.lineItems.length === 0) return null; // hide empty card for non-reviewers

  return (
    <div className="card" style={{ padding: 18 }}>
      <header style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Pricing extras</h2>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
            Travel, tools, resource costs, and discounts. Added on top of the rate-card base.
          </div>
        </div>
        {canEdit && (
          <button className="btn sm accent" onClick={() => setShowAdd(true)}>
            <Icon.Plus size={11} /> Add line item
          </button>
        )}
      </header>

      {data.lineItems.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', padding: '6px 0' }}>
          No extras. Click <i>Add line item</i> for travel, tools, resources, or discounts.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {data.lineItems.map((item) => (
            <div
              key={item.id}
              style={{
                display: 'grid', gridTemplateColumns: '80px 1fr auto auto', gap: 12,
                alignItems: 'center',
                padding: '8px 12px', borderRadius: 6,
                background: 'var(--bg-sunk)',
                borderLeft: `3px solid ${KIND_COLORS[item.kind]}`,
              }}
            >
              <span style={{
                fontSize: 10.5, fontWeight: 700, letterSpacing: 0.4,
                textTransform: 'uppercase', color: KIND_COLORS[item.kind],
              }}>{KIND_LABELS[item.kind]}</span>
              <span style={{ fontSize: 13 }}>{item.label}</span>
              <span style={{
                fontSize: 13, fontWeight: 600,
                color: item.amountCents < 0 ? 'var(--danger)' : 'var(--fg)',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {formatCents(item.amountCents, currency)}
                {item.percentageBps != null && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)', marginLeft: 6 }}>
                    ({(item.percentageBps / 100).toFixed(1)}%)
                  </span>
                )}
              </span>
              {canEdit && (
                <button className="btn sm ghost" title="Remove" onClick={() => remove(item)}>
                  <Icon.X size={11} />
                </button>
              )}
            </div>
          ))}

          <div style={{
            marginTop: 4, padding: '8px 12px',
            display: 'grid', gridTemplateColumns: '1fr auto', gap: 8,
            fontSize: 12.5, color: 'var(--fg-muted)',
          }}>
            <span>Base (from rate card)</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(data.baseTotalCents, currency)}</span>
            <span>Extras &amp; discounts</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatCents(data.lineItemTotalCents, currency)}</span>
            <span style={{ fontWeight: 600, color: 'var(--fg)', fontSize: 13.5 }}>Grand total</span>
            <span style={{
              fontWeight: 700, color: 'var(--fg)', fontSize: 13.5,
              fontVariantNumeric: 'tabular-nums',
            }}>
              {formatCents(data.grandTotalCents, currency)}
            </span>
          </div>
        </div>
      )}

      {err && (
        <div style={{ marginTop: 10, padding: 8, fontSize: 12, color: 'var(--danger)' }}>{err}</div>
      )}

      {showAdd && (
        <AddLineItemModal
          engagementId={engagementId}
          currency={currency}
          baseTotalCents={data.baseTotalCents}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); refresh(); }}
        />
      )}
    </div>
  );
}

function AddLineItemModal({
  engagementId, currency, baseTotalCents, onClose, onSaved,
}: {
  engagementId: string;
  currency: string;
  baseTotalCents: number;
  onClose(): void;
  onSaved(): void;
}) {
  const [kind, setKind] = useState<QuoteLineItemKind>('travel');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');  // user enters major-units (rupees/dollars)
  const [percentage, setPercentage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Discount mode: percent OR absolute. Default: percent.
  const [discountMode, setDiscountMode] = useState<'percent' | 'amount'>('percent');
  const isDiscount = kind === 'discount';

  async function save() {
    if (!label.trim()) { setErr('Label is required'); return; }
    setBusy(true); setErr(null);
    try {
      const input: CreateQuoteLineItemInput = {
        kind,
        label: label.trim(),
      };
      if (isDiscount && discountMode === 'percent') {
        const pct = Number(percentage);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          throw new Error('Enter a discount percentage between 0 and 100');
        }
        input.percentageBps = Math.round(pct * 100);
      } else {
        const amt = Number(amount);
        if (!Number.isFinite(amt) || amt <= 0) {
          throw new Error('Enter a positive amount');
        }
        // Convert major units to cents.
        input.amountCents = Math.round(amt * 100);
      }
      await quoteLineItems.create(engagementId, input);
      onSaved();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 480, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Add line item</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Base rate-card total: <b>{formatCents(baseTotalCents, currency)}</b>
            </div>
          </header>
          <div style={{ padding: 18, display: 'grid', gap: 12 }}>
            <Field label="Kind">
              <select
                className="input"
                value={kind}
                onChange={(e) => setKind(e.target.value as QuoteLineItemKind)}
                style={{ height: 32 }}
              >
                {(Object.keys(KIND_LABELS) as QuoteLineItemKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABELS[k]}</option>
                ))}
              </select>
            </Field>
            <Field label="Label">
              <input
                className="input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Mumbai onsite — 2 trips"
                style={{ height: 32, fontSize: 13 }}
              />
            </Field>

            {isDiscount && (
              <div style={{
                display: 'flex', gap: 4,
                background: 'var(--bg-sunk)', padding: 2, borderRadius: 6,
              }}>
                <button
                  className="btn sm"
                  style={{
                    flex: 1,
                    background: discountMode === 'percent' ? 'var(--bg)' : 'transparent',
                    fontWeight: discountMode === 'percent' ? 600 : 400,
                  }}
                  onClick={() => setDiscountMode('percent')}
                >% off base</button>
                <button
                  className="btn sm"
                  style={{
                    flex: 1,
                    background: discountMode === 'amount' ? 'var(--bg)' : 'transparent',
                    fontWeight: discountMode === 'amount' ? 600 : 400,
                  }}
                  onClick={() => setDiscountMode('amount')}
                >Flat amount</button>
              </div>
            )}

            {isDiscount && discountMode === 'percent' ? (
              <Field label="Discount %" hint="Whole or decimal, e.g. 10 or 12.5">
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  value={percentage}
                  onChange={(e) => setPercentage(e.target.value)}
                  placeholder="10"
                  style={{ height: 32, fontSize: 13 }}
                />
              </Field>
            ) : (
              <Field label={`Amount (${currency})`} hint={isDiscount ? 'We&apos;ll record this as a negative line.' : 'Positive amount in major units.'}>
                <input
                  className="input"
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="25000"
                  style={{ height: 32, fontSize: 13 }}
                />
              </Field>
            )}

            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn sm accent"
              disabled={busy || !label.trim() || (
                isDiscount && discountMode === 'percent' ? !percentage : !amount
              )}
              onClick={save}
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Add</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

// ── Reviewer hold actions (Send Back / Clarify / Escalate) ──────────

type HoldAction = 'send_back' | 'request_clarification' | 'escalate';

const HOLD_LABELS: Record<HoldAction, { title: string; verb: string; description: string; tone: 'warn' | 'danger' }> = {
  send_back: {
    title: 'Send back to sales',
    verb: 'Send back',
    description: "Scope needs work. Sales must edit and resubmit before this can re-enter approval.",
    tone: 'warn',
  },
  request_clarification: {
    title: 'Request clarification',
    verb: 'Send request',
    description: "Ask sales or the client a clarifying question. Status holds until answered.",
    tone: 'warn',
  },
  escalate: {
    title: 'Escalate to manager',
    verb: 'Escalate',
    description: "Push this opportunity to a sales manager / admin for a higher-level decision.",
    tone: 'danger',
  },
};

interface HoldActionsProps {
  engagementId: string;
  userRole: string;
  status: string;
  onStatusChange?(status: string): void;
}

export function ReviewerHoldActions({
  engagementId, userRole, status, onStatusChange,
}: HoldActionsProps) {
  const canAct = ['admin', 'sales_manager', 'tech_team'].includes(userRole);
  const [open, setOpen] = useState<HoldAction | null>(null);

  // Don't show if already in a terminal/hold state.
  const terminal = ['closed', 'sent', 'expired', 'rejected'].includes(status);
  const alreadyHeld = ['returned_to_sales', 'awaiting_clarification', 'escalated'].includes(status);

  if (!canAct) return null;
  if (terminal) return null;

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          className="btn sm ghost"
          disabled={alreadyHeld}
          onClick={() => setOpen('send_back')}
          title={alreadyHeld ? `Already in ${status}` : HOLD_LABELS.send_back.description}
        >
          <Icon.ChevronLeft size={11} /> Send back
        </button>
        <button
          className="btn sm ghost"
          disabled={alreadyHeld}
          onClick={() => setOpen('request_clarification')}
          title={alreadyHeld ? `Already in ${status}` : HOLD_LABELS.request_clarification.description}
        >
          <Icon.Clock size={11} /> Clarify
        </button>
        <button
          className="btn sm ghost"
          disabled={alreadyHeld}
          onClick={() => setOpen('escalate')}
          title={alreadyHeld ? `Already in ${status}` : HOLD_LABELS.escalate.description}
        >
          <Icon.ArrowUpRight size={11} /> Escalate
        </button>
      </div>

      {open && (
        <HoldReasonModal
          action={open}
          engagementId={engagementId}
          onClose={() => setOpen(null)}
          onDone={(status) => { setOpen(null); onStatusChange?.(status); }}
        />
      )}
    </>
  );
}

function HoldReasonModal({
  action, engagementId, onClose, onDone,
}: {
  action: HoldAction;
  engagementId: string;
  onClose(): void;
  onDone(newStatus: string): void;
}) {
  const cfg = HOLD_LABELS[action];
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!reason.trim()) { setErr('Reason is required'); return; }
    setBusy(true); setErr(null);
    try {
      const fn =
        action === 'send_back' ? opportunities.sendBack
        : action === 'request_clarification' ? opportunities.requestClarification
        : opportunities.escalate;
      const out = await fn(engagementId, reason.trim());
      onDone(out.status);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 460, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>{cfg.title}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{cfg.description}</div>
          </header>
          <div style={{ padding: 18, display: 'grid', gap: 8 }}>
            <Field label="Reason" hint="Shown in the audit timeline. Be specific.">
              <textarea
                className="input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                placeholder={
                  action === 'send_back' ? 'e.g. Asset count is incomplete — need network ranges'
                  : action === 'request_clarification' ? 'e.g. Is the API count for v1 only or all versions?'
                  : 'e.g. Discount request exceeds my authority; routing to manager'
                }
                style={{ fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5 }}
              />
            </Field>
            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', justifyContent: 'flex-end', gap: 8,
          }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className={`btn sm ${cfg.tone === 'danger' ? 'danger' : 'accent'}`}
              disabled={busy || !reason.trim()}
              onClick={submit}
            >
              {busy ? <span className="spin" /> : <>{cfg.verb}</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatCents(cents: number, currency: string): string {
  const abs = Math.abs(cents) / 100;
  const formatted = abs.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const sign = cents < 0 ? '−' : '';
  return `${sign}${currency} ${formatted}`;
}
