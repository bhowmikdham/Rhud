'use client';

/**
 * THROWAWAY PROTOTYPE — stage-driven opportunity-detail redesign.
 *
 * Route: /opportunities/preview  (static segment, does NOT collide with [id]).
 * Mock data only; nothing here is wired to the API. Its job is to let us SEE
 * the proposed IA — a sticky Stage Header + a single role-aware primary zone +
 * collapsed, count-badged sections — and to flip between lifecycle stages and
 * roles so the "page reshapes itself" idea is tangible before we refactor the
 * real 4570-line page.tsx. Delete this file once the direction is signed off.
 *
 * Spec: docs/opportunity-page-redesign.md
 */

import { useRef, useState } from 'react';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

// ── Model ───────────────────────────────────────────────────────────────────

type StageId = 'discovery' | 'pricing' | 'approval' | 'proposal' | 'delivered';
type Role = 'sales_employee' | 'sales_manager' | 'tech_team' | 'admin' | 'vp_sales';

const STAGES: Array<{ id: StageId; label: string; status: string; icon: keyof typeof Icon }> = [
  { id: 'discovery', label: 'Discovery', status: 'in_progress', icon: 'Link' },
  { id: 'pricing', label: 'Pricing', status: 'predicted', icon: 'Sparkle' },
  { id: 'approval', label: 'Approval', status: 'pending_approval', icon: 'Shield' },
  { id: 'proposal', label: 'Proposal', status: 'draft_ready', icon: 'FileText' },
  { id: 'delivered', label: 'Delivered', status: 'sent', icon: 'Send' },
];

const ROLES: Array<{ id: Role; label: string }> = [
  { id: 'sales_employee', label: 'Sales rep' },
  { id: 'sales_manager', label: 'Sales manager' },
  { id: 'tech_team', label: 'Tech team' },
  { id: 'vp_sales', label: 'VP sales' },
  { id: 'admin', label: 'Admin' },
];

// Who the page is waiting on at each stage, and the one-line "what's next".
const STAGE_META: Record<StageId, { actor: string; hint: string }> = {
  discovery: { actor: 'the client', hint: 'Client is filling out the scoping questions. Re-issue the link if it stalls.' },
  pricing: { actor: 'sales manager', hint: 'The model has priced this. Review the number and approve at a tier, or send it back.' },
  approval: { actor: 'VP sales', hint: 'Above the manager threshold — VP sign-off is required before drafting.' },
  proposal: { actor: 'sales', hint: 'Approved. The proposal draft is ready — review it and send to the client.' },
  delivered: { actor: 'sales', hint: 'Proposal delivered. Mark the deal won or lost when the client responds.' },
};

// Roles allowed to take the PRIMARY action at each stage. Everyone else gets a
// read-only "waiting on {actor}" framing — never a dead button.
const ACTORS: Record<StageId, Role[]> = {
  discovery: ['sales_employee', 'sales_manager', 'admin'],
  pricing: ['sales_manager', 'tech_team', 'admin', 'sales_employee'], // rep can Run prediction at submitted
  approval: ['vp_sales', 'admin'],
  proposal: ['sales_employee', 'sales_manager', 'admin'],
  delivered: ['sales_employee', 'sales_manager', 'admin'],
};

// ── Page ────────────────────────────────────────────────────────────────────

export default function OpportunityPreviewPage() {
  const [stage, setStage] = useState<StageId>('pricing');
  const [role, setRole] = useState<Role>('sales_manager');
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function demo(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  }

  const meta = STAGE_META[stage];
  const isMyTurn = ACTORS[stage].includes(role);
  const stageIdx = STAGES.findIndex((s) => s.id === stage);

  return (
    <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'Preview · stage-driven redesign' }]}>
      <div className="page-inner wide" style={{ paddingBottom: 120 }}>
        <PrototypeBar stage={stage} setStage={setStage} role={role} setRole={setRole} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)',
            gap: 18,
            alignItems: 'start',
            marginTop: 18,
          }}
        >
          {/* ── Left: persistent activity spine ── */}
          <ActivityRail stageIdx={stageIdx} />

          {/* ── Right: the redesigned artifact pane ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
            <StageHeader stage={stage} stageIdx={stageIdx} role={role} isMyTurn={isMyTurn} meta={meta} onAct={demo} />
            <ContextStrip onAct={demo} />
            <PrimaryZone stage={stage} role={role} isMyTurn={isMyTurn} meta={meta} onAct={demo} />
            <SectionStack stage={stage} onAct={demo} />
          </div>
        </div>
      </div>

      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed', bottom: 22, left: '50%', transform: 'translateX(-50%)',
            zIndex: 'var(--z-toast)', background: 'var(--fg)', color: 'var(--bg)',
            padding: '10px 16px', borderRadius: 999, fontSize: 12.5, fontWeight: 500,
            boxShadow: 'var(--shadow-lg)', display: 'inline-flex', alignItems: 'center', gap: 8,
            maxWidth: '90vw',
          }}
        >
          <Icon.Zap size={12} />
          {toast}
        </div>
      )}
    </AppShell>
  );
}

// ── Prototype control bar (stage + role switchers) ──────────────────────────

function PrototypeBar({
  stage, setStage, role, setRole,
}: {
  stage: StageId; setStage(s: StageId): void; role: Role; setRole(r: Role): void;
}) {
  return (
    <div
      style={{
        border: '1px dashed color-mix(in oklch, var(--warn) 45%, transparent)',
        background: 'var(--warn-tint)',
        borderRadius: 'var(--radius-lg)',
        padding: '12px 14px',
        display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 16,
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: 'var(--fg)' }}>
        <Icon.Eye size={13} /> Prototype · mock data
      </span>
      <Segmented
        label="Stage"
        value={stage}
        onChange={(v) => setStage(v as StageId)}
        options={STAGES.map((s) => ({ id: s.id, label: s.label }))}
      />
      <Segmented
        label="Viewing as"
        value={role}
        onChange={(v) => setRole(v as Role)}
        options={ROLES.map((r) => ({ id: r.id, label: r.label }))}
      />
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
        Flip stage &amp; role — the page reshapes itself.
      </span>
    </div>
  );
}

function Segmented({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange(v: string): void;
  options: Array<{ id: string; label: string }>;
}) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', fontWeight: 500 }}>{label}</span>
      <div
        role="tablist"
        aria-label={label}
        style={{
          display: 'inline-flex', background: 'var(--bg-sunk)',
          border: '1px solid var(--border)', borderRadius: 8, padding: 2,
        }}
      >
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(o.id)}
              style={{
                appearance: 'none', cursor: 'pointer',
                padding: '4px 10px', borderRadius: 6,
                border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
                background: active ? 'var(--bg-elev)' : 'transparent',
                color: active ? 'var(--fg)' : 'var(--fg-muted)',
                fontSize: 12, fontWeight: 500,
                boxShadow: active ? 'var(--shadow-xs)' : 'none',
                transition: 'background .15s, color .15s',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Left activity rail ──────────────────────────────────────────────────────

const TIMELINE: Array<{ label: string; stageIdx: number; icon: keyof typeof Icon }> = [
  { label: 'Link issued to client', stageIdx: 0, icon: 'Link' },
  { label: 'Client opened the link', stageIdx: 0, icon: 'Eye' },
  { label: 'Scope submitted', stageIdx: 1, icon: 'Send' },
  { label: 'Price predicted', stageIdx: 1, icon: 'Sparkle' },
  { label: 'Approval requested', stageIdx: 2, icon: 'Clock' },
  { label: 'Approved', stageIdx: 3, icon: 'Check' },
  { label: 'Proposal sent', stageIdx: 4, icon: 'Send' },
];

function ActivityRail({ stageIdx }: { stageIdx: number }) {
  return (
    <div
      className="card"
      style={{ padding: 16, position: 'sticky', top: 12, alignSelf: 'start' }}
    >
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.01em' }}>Acme Corp — Website RFP</div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="mono">#a91f3c8</span><span>·</span><span>Web build v3</span><span>·</span><span>client@acme.com</span>
        </div>
      </div>
      <div className="section-label" style={{ marginBottom: 10 }}>Activity</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {TIMELINE.map((ev, i) => {
          const done = ev.stageIdx <= stageIdx;
          const I = Icon[ev.icon];
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', opacity: done ? 1 : 0.4 }}>
              <span
                style={{
                  width: 22, height: 22, borderRadius: 999, flexShrink: 0,
                  display: 'grid', placeItems: 'center',
                  background: done ? 'var(--accent-tint)' : 'var(--bg-sunk)',
                  color: done ? 'var(--accent)' : 'var(--fg-faint)',
                  border: '1px solid ' + (done ? 'color-mix(in oklch, var(--accent) 25%, transparent)' : 'var(--border)'),
                }}
              >
                <I size={11} />
              </span>
              <span style={{ fontSize: 12.5, color: done ? 'var(--fg)' : 'var(--fg-subtle)' }}>{ev.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sticky Stage Header (stepper + your-turn + next + primary CTA) ───────────

function StageHeader({
  stage, stageIdx, role, isMyTurn, meta, onAct,
}: {
  stage: StageId; stageIdx: number; role: Role; isMyTurn: boolean;
  meta: { actor: string; hint: string }; onAct(m: string): void;
}) {
  const status = STAGES[stageIdx]!.status;
  return (
    <div
      style={{
        position: 'sticky', top: 12, zIndex: 'var(--z-sticky)',
        background: 'var(--bg-elev)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)',
        padding: '14px 16px',
      }}
    >
      <Stepper stageIdx={stageIdx} />
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 14, marginTop: 14, flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StageChip stage={status} />
            <TurnBadge isMyTurn={isMyTurn} actor={meta.actor} />
          </div>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5, maxWidth: '62ch' }}>
            {meta.hint}
          </div>
        </div>
        <PrimaryCta stage={stage} role={role} isMyTurn={isMyTurn} onAct={onAct} />
      </div>
    </div>
  );
}

function Stepper({ stageIdx }: { stageIdx: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      {STAGES.map((s, i) => {
        const done = i < stageIdx;
        const active = i === stageIdx;
        const I = Icon[s.icon];
        return (
          <div key={s.id} style={{ display: 'contents' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <span
                aria-current={active ? 'step' : undefined}
                style={{
                  width: 26, height: 26, borderRadius: 999, display: 'grid', placeItems: 'center',
                  background: done ? 'var(--accent)' : active ? 'var(--accent-tint)' : 'var(--bg-sunk)',
                  color: done ? 'var(--accent-fg)' : active ? 'var(--accent)' : 'var(--fg-faint)',
                  border: '1.5px solid ' + (done || active ? 'var(--accent)' : 'var(--border)'),
                  boxShadow: active ? '0 0 0 3px var(--accent-tint)' : 'none',
                  transition: 'all .2s',
                }}
              >
                {done ? <Icon.Check size={13} sw={2.4} /> : <I size={12} />}
              </span>
              <span style={{
                fontSize: 10.5, fontWeight: active ? 600 : 500,
                color: active ? 'var(--fg)' : done ? 'var(--fg-muted)' : 'var(--fg-faint)',
              }}>{s.label}</span>
            </div>
            {i < STAGES.length - 1 && (
              <div aria-hidden style={{
                flex: 1, height: 2, margin: '0 6px', marginBottom: 18, borderRadius: 2,
                background: i < stageIdx ? 'var(--accent)' : 'var(--border)',
                transition: 'background .2s',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function TurnBadge({ isMyTurn, actor }: { isMyTurn: boolean; actor: string }) {
  if (isMyTurn) {
    return (
      <span className="chip ok" style={{ fontWeight: 600 }}>
        <Icon.Zap size={10} /> Your turn
      </span>
    );
  }
  return (
    <span className="chip" style={{ color: 'var(--fg-muted)' }}>
      <Icon.Clock size={10} /> Waiting on {actor}
    </span>
  );
}

function PrimaryCta({
  stage, role, isMyTurn, onAct,
}: {
  stage: StageId; role: Role; isMyTurn: boolean; onAct(m: string): void;
}) {
  if (!isMyTurn) {
    return (
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)', alignSelf: 'center' }}>
        No action needed from you
      </span>
    );
  }
  const cta: Record<StageId, { label: string; icon: keyof typeof Icon }> = {
    discovery: { label: 'Send scoping link', icon: 'Link' },
    pricing: role === 'tech_team' ? { label: 'Lodge tech price', icon: 'Edit' } : { label: 'Approve', icon: 'Check' },
    approval: { label: 'Final-approve', icon: 'Shield' },
    proposal: { label: 'Open proposal', icon: 'FileText' },
    delivered: { label: 'Mark won', icon: 'CheckCircle' },
  };
  const c = cta[stage];
  const I = Icon[c.icon];
  return (
    <button className="btn accent" style={{ flexShrink: 0 }} onClick={() => onAct(`Demo: "${c.label}" — would advance the lifecycle.`)}>
      <I size={13} /> {c.label}
    </button>
  );
}

// ── Context strip (lead one-liner + chips) ──────────────────────────────────

function ContextStrip({ onAct }: { onAct(m: string): void }) {
  const chips: Array<{ label: string; icon: keyof typeof Icon }> = [
    { label: 'Web › Corporate', icon: 'Hash' },
    { label: 'Reviewer: J. Doe', icon: 'User' },
    { label: '2 tickets', icon: 'Inbox' },
    { label: '1 follow-up', icon: 'Clock' },
    { label: 'Odoo synced', icon: 'Globe' },
  ];
  return (
    <div
      className="card"
      style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}
    >
      <button
        onClick={() => onAct('Demo: expand the full AI lead summary.')}
        style={{
          appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent',
          display: 'inline-flex', alignItems: 'center', gap: 8, padding: 0,
          color: 'var(--fg)', fontSize: 12.5, minWidth: 0,
        }}
      >
        <span className="chip ok" style={{ flexShrink: 0 }}><Icon.Check size={9} /> Low risk</span>
        <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          “Chase the scope sign-off — strong fit, decision-maker engaged.”
        </span>
        <Icon.ChevronRight size={12} style={{ color: 'var(--fg-subtle)', flexShrink: 0 }} />
      </button>
      <span style={{ flex: 1 }} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {chips.map((c) => {
          const I = Icon[c.icon];
          return (
            <button
              key={c.label}
              onClick={() => onAct(`Demo: open “${c.label}”.`)}
              className="chip"
              style={{ cursor: 'pointer', border: '1px solid var(--border)' }}
            >
              <I size={10} /> {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Primary zone (role + stage aware) ───────────────────────────────────────

function PrimaryZone({
  stage, role, isMyTurn, meta, onAct,
}: {
  stage: StageId; role: Role; isMyTurn: boolean;
  meta: { actor: string }; onAct(m: string): void;
}) {
  if (stage === 'pricing') return <PricingPrimary role={role} onAct={onAct} />;
  if (stage === 'discovery') return <DiscoveryPrimary isMyTurn={isMyTurn} actor={meta.actor} onAct={onAct} />;
  if (stage === 'approval') return <ApprovalPrimary role={role} isMyTurn={isMyTurn} onAct={onAct} />;
  if (stage === 'proposal') return <ProposalPrimary isMyTurn={isMyTurn} onAct={onAct} />;
  return <DeliveredPrimary isMyTurn={isMyTurn} onAct={onAct} />;
}

function HeroCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="card"
      style={{
        padding: 0, overflow: 'hidden',
        borderLeft: '3px solid var(--accent)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      {children}
    </div>
  );
}

function PriceSummary() {
  return (
    <div style={{ padding: '18px 20px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div className="section-label" style={{ marginBottom: 4 }}>Recommended price</div>
          <div style={{ fontSize: 34, fontWeight: 650, letterSpacing: '-0.02em', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            ₹18,40,000
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 6 }}>
            band ₹16.2L – ₹20.1L · confidence 0.82
          </div>
        </div>
        <span className="chip ok"><Icon.Sparkle size={10} /> Boosted · 142 closed</span>
      </div>
    </div>
  );
}

function PricingPrimary({ role, onAct }: { role: Role; onAct(m: string): void }) {
  const canApprove = role === 'sales_manager' || role === 'admin';
  const isTech = role === 'tech_team';
  const isRep = role === 'sales_employee';
  const isVp = role === 'vp_sales';

  return (
    <HeroCard>
      <PriceSummary />

      {canApprove && (
        <div style={{ padding: '0 20px 18px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
            <Tier label="Base" amount="₹16.2L" sub="No modifier" tone="muted" onAct={onAct} />
            <Tier label="Recommended" amount="₹18.4L" sub="+13.6%" tone="accent" recommended onAct={onAct} />
            <Tier label="Aggressive" amount="₹20.1L" sub="Band high" tone="ok" onAct={onAct} />
          </div>
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--fg-muted)', userSelect: 'none' }}>
              What moved this number? · 3 drivers
            </summary>
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
              <Driver label="Repeat client (loyalty)" value="-4.0%" tone="var(--ok)" />
              <Driver label="Tight delivery timeline" value="+9.2%" tone="var(--warn)" />
              <Driver label="High API surface count" value="+8.4%" tone="var(--warn)" />
            </div>
          </details>
          <div style={{
            marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          }}>
            <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', flex: 1 }}>Pause before approving?</span>
            <button className="btn sm ghost" onClick={() => onAct('Demo: send back to sales.')}>Send back</button>
            <button className="btn sm ghost" onClick={() => onAct('Demo: ask clarification.')}>Ask clarification</button>
            <button className="btn sm danger" onClick={() => onAct('Demo: reject opportunity.')}><Icon.X size={11} /> Reject</button>
          </div>
        </div>
      )}

      {isTech && (
        <div style={{ padding: '0 20px 18px' }}>
          <div className="section-label" style={{ marginBottom: 6 }}><Icon.Edit size={11} /> Lodge an adjusted price</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" defaultValue="1840000" style={{ width: 160, fontVariantNumeric: 'tabular-nums' }} />
            <input className="input" placeholder="Why this price?" style={{ flex: 1, minWidth: 180, fontSize: 12 }} />
            <button className="btn sm accent" onClick={() => onAct('Demo: lodge adjusted price for manager review.')}>Lodge</button>
          </div>
          <p style={{ fontSize: 11.5, color: 'var(--fg-subtle)', margin: '8px 0 0' }}>
            The sales manager reviews your adjustment before approving. Re-predict &amp; approve stay hidden for tech team.
          </p>
        </div>
      )}

      {(isRep || isVp) && (
        <div style={{
          padding: '12px 20px 16px', borderTop: '1px solid var(--divider)',
          fontSize: 12.5, color: 'var(--fg-muted)',
        }}>
          <Icon.Lock size={11} /> Read-only — {isRep ? 'the sales manager reviews the price.' : 'manager review in progress; you sign off only if it crosses the VP threshold.'} No tier buttons for your role.
        </div>
      )}
    </HeroCard>
  );
}

function Tier({
  label, amount, sub, tone, recommended, onAct,
}: {
  label: string; amount: string; sub: string;
  tone: 'accent' | 'ok' | 'muted'; recommended?: boolean; onAct(m: string): void;
}) {
  return (
    <div
      style={{
        padding: 12, borderRadius: 'var(--radius)',
        border: '1px solid ' + (recommended ? 'color-mix(in oklch, var(--accent) 35%, transparent)' : 'var(--divider)'),
        background: tone === 'accent' ? 'var(--accent-tint)' : tone === 'ok' ? 'var(--ok-tint)' : 'var(--bg-sunk)',
      }}
    >
      <div style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 650, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{amount}</div>
      <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>{sub}</div>
      <button className="btn sm accent" style={{ marginTop: 8, width: '100%' }} onClick={() => onAct(`Demo: approve at ${label} (${amount}).`)}>
        Approve at this
      </button>
    </div>
  );
}

function Driver({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', fontSize: 12 }}>
      <span>{label}</span>
      <span style={{ color: tone, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

function DiscoveryPrimary({ isMyTurn, actor, onAct }: { isMyTurn: boolean; actor: string; onAct(m: string): void }) {
  return (
    <HeroCard>
      <div style={{ padding: 20 }}>
        <div className="section-label" style={{ marginBottom: 6 }}><Icon.Link size={11} /> Scoping link</div>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
          A scoping link is live — the client has answered 6 of 9 questions. {isMyTurn ? 'Re-issue or copy the link to nudge them along.' : `Waiting on ${actor} to finish.`}
        </p>
        {isMyTurn && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn accent" onClick={() => onAct('Demo: copy gathering link.')}><Icon.Copy size={12} /> Copy link</button>
            <button className="btn ghost" onClick={() => onAct('Demo: re-issue scoping link.')}><Icon.Refresh size={12} /> Re-issue</button>
          </div>
        )}
      </div>
    </HeroCard>
  );
}

function ApprovalPrimary({ role, isMyTurn, onAct }: { role: Role; isMyTurn: boolean; onAct(m: string): void }) {
  return (
    <HeroCard>
      <PriceSummary />
      <div style={{ padding: '0 20px 18px' }}>
        {isMyTurn ? (
          <>
            <div className="section-label" style={{ marginBottom: 8 }}><Icon.Shield size={11} /> Final approval required</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn accent" onClick={() => onAct('Demo: final-approve at ₹18.4L.')}><Icon.Check size={12} /> Final-approve</button>
              <button className="btn danger" onClick={() => onAct('Demo: final-reject.')}><Icon.X size={11} /> Reject</button>
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
            <Icon.Lock size={11} /> Read-only — awaiting {role === 'vp_sales' ? 'CEO' : 'VP'} sign-off. Your role can&apos;t act at this gate.
          </div>
        )}
      </div>
    </HeroCard>
  );
}

function ProposalPrimary({ isMyTurn, onAct }: { isMyTurn: boolean; onAct(m: string): void }) {
  return (
    <HeroCard>
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="chip accent"><Icon.FileText size={10} /> Draft ready</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
          The proposal draft is generated and ready for review. Open the workspace to edit and send it to the client.
        </p>
        {isMyTurn && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn accent" onClick={() => onAct('Demo: open the proposal workspace.')}><Icon.FileText size={12} /> Open proposal workspace</button>
            <button className="btn ghost" onClick={() => onAct('Demo: mark proposal as sent.')}><Icon.Send size={12} /> Mark as sent</button>
          </div>
        )}
      </div>
    </HeroCard>
  );
}

function DeliveredPrimary({ isMyTurn, onAct }: { isMyTurn: boolean; onAct(m: string): void }) {
  return (
    <HeroCard>
      <div style={{ padding: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="chip ok"><Icon.Send size={10} /> Delivered</span>
        </div>
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 14px', lineHeight: 1.55 }}>
          Proposal sent to the client. Record the outcome when they respond.
        </p>
        {isMyTurn && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn accent" onClick={() => onAct('Demo: mark deal won (syncs to Odoo).')}><Icon.CheckCircle size={12} /> Mark won</button>
            <button className="btn ghost" onClick={() => onAct('Demo: mark deal lost.')}><Icon.X size={11} /> Mark lost</button>
          </div>
        )}
        <p style={{ fontSize: 11, color: 'var(--fg-subtle)', margin: '12px 0 0' }}>
          Note: persisting a “closed” status needs a new API endpoint (see spec §9-Q1) — today this only fires the Odoo action.
        </p>
      </div>
    </HeroCard>
  );
}

// ── Collapsed, count-badged sections ────────────────────────────────────────

function SectionStack({ stage, onAct }: { stage: StageId; onAct(m: string): void }) {
  const sections: Array<{ id: string; label: string; badge?: string; defaultOpen?: boolean; body: React.ReactNode }> = [
    {
      id: 'scope', label: 'Scope evidence', badge: '12 URLs · idle',
      defaultOpen: stage === 'pricing',
      body: <MockLines lines={['/products — Catalog (e-commerce)', '/api/v2/orders — REST endpoint', '/blog — Content (12 pages)', '+ 9 more discovered URLs']} />,
    },
    { id: 'docs', label: 'Documents & extraction', badge: '3 files', body: <MockLines lines={['RFP_Acme_v3.pdf — 14 points extracted', 'wireframes.fig — parsed', 'rate_sheet.xlsx — 3 sheets']} /> },
    { id: 'notes', label: 'Reviewer notes', badge: 'edited', body: <MockLines lines={['Assumptions: hosting excluded, 2 rounds of revisions', 'Exclusions: native mobile apps', 'Delivery override: 10 weeks']} /> },
    { id: 'extras', label: 'Pricing extras', badge: '+₹40k · 2', body: <MockLines lines={['Priority support (12mo) — +₹25,000', 'Extra staging environment — +₹15,000']} /> },
    { id: 'detail', label: 'Pricing detail / breakdown', body: <MockLines lines={['Base build — ₹14,20,000', 'Integrations (4) — ₹2,00,000', 'Rate card v7 · 9 line items']} /> },
    { id: 'just', label: 'Justification & rationale', defaultOpen: stage === 'proposal', body: <MockLines lines={['AI-drafted rationale for the quoted price', 'Comparable: 3 similar closed deals', 'Email-ready summary']} /> },
    { id: 'link', label: 'Scoping link', badge: 'active · 4 opens', body: <MockLines lines={['Live link · expires in 5 days', 'Opened 4 times · 6/9 answered']} /> },
    { id: 'facts', label: 'Opportunity details', body: <MockLines lines={['Client: client@acme.com', 'Template: Web build v3', 'Created: 12 May 2026']} /> },
  ];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="section-label" style={{ margin: '6px 2px 0' }}>Reference · expand what you need</div>
      {sections.map((s) => (
        <Section key={s.id} label={s.label} badge={s.badge} defaultOpen={s.defaultOpen} onAct={onAct}>
          {s.body}
        </Section>
      ))}
    </div>
  );
}

function Section({
  label, badge, defaultOpen, children, onAct,
}: {
  label: string; badge?: string | undefined; defaultOpen?: boolean | undefined;
  children: React.ReactNode; onAct(m: string): void;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) onAct(`Demo: “${label}” mounts on expand — fetches/polls only now.`);
        }}
        style={{
          appearance: 'none', cursor: 'pointer', border: 0, background: 'transparent',
          width: '100%', display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 14px', textAlign: 'left',
        }}
      >
        <Icon.ChevronRight
          size={13}
          style={{ color: 'var(--fg-subtle)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }}
        />
        <span style={{ fontSize: 13, fontWeight: 600, flex: 1 }}>{label}</span>
        {badge && (
          <span style={{
            fontSize: 11, fontVariantNumeric: 'tabular-nums',
            padding: '1px 8px', borderRadius: 999,
            background: 'var(--bg-sunk)', color: 'var(--fg-subtle)', fontWeight: 500,
          }}>{badge}</span>
        )}
      </button>
      {open && (
        <div style={{ padding: '2px 14px 14px 37px', borderTop: '1px solid var(--divider)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function MockLines({ lines }: { lines: string[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 10 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ fontSize: 12.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon.Dot size={12} style={{ color: 'var(--fg-faint)', flexShrink: 0 }} />
          {l}
        </div>
      ))}
    </div>
  );
}
