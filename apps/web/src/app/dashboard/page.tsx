'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { opportunities, type EngagementSummary } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

// ─── Funnel definition (drives the pipeline card + tinting) ──────────────────
const FUNNEL_STAGES: Array<{
  id: string;
  label: string;
  statuses: string[];
  tint: string;
}> = [
  { id: 'scope',     label: 'Scope gathering',   statuses: ['issued', 'in_progress'],         tint: 'var(--accent)' },
  { id: 'pricing',   label: 'Pricing',           statuses: ['submitted', 'predicted'],         tint: 'oklch(0.6 0.13 180)' },
  { id: 'approval',  label: 'Awaiting approval', statuses: ['pending_approval'],               tint: 'var(--warn)' },
  { id: 'drafting',  label: 'Drafting',          statuses: ['approved', 'drafting', 'draft_ready'], tint: 'oklch(0.6 0.12 340)' },
  { id: 'delivered', label: 'Delivered',         statuses: ['sent', 'closed'],                 tint: 'var(--ok)' },
];

export default function DashboardPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<EngagementSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    opportunities.list().then(setItems).catch((e) => setErr(String(e)));
  }, [user]);

  const firstName = user ? capitalize(user.email.split('@')[0]?.split('.')[0] ?? '') : '';

  // ─── Derived stats ──────────────────────────────────────────────────────
  const open = useMemo(
    () => (items ?? []).filter((e) => !['sent', 'closed', 'rejected', 'expired'].includes(e.status)),
    [items],
  );
  const awaitingApproval = useMemo(
    () => (items ?? []).filter((e) => e.status === 'pending_approval'),
    [items],
  );
  const deliveredThisWeek = useMemo(
    () => (items ?? []).filter((e) => {
      if (!['sent', 'closed'].includes(e.status)) return false;
      const t = new Date(e.submittedAt ?? e.createdAt).getTime();
      return Date.now() - t < 7 * 86_400_000;
    }),
    [items],
  );
  const pipelineValue = useMemo(
    () => (items ?? [])
      .filter((e) => e.predictedPriceCents != null && !['rejected', 'expired'].includes(e.status))
      .reduce((acc, e) => acc + (e.predictedPriceCents ?? 0), 0),
    [items],
  );
  // Most engagements share a currency within a workspace; pick the first
  // non-null one and use it as the workspace currency for the pipeline tile.
  const workspaceCurrency = useMemo(
    () => (items ?? []).find((e) => e.currency)?.currency ?? null,
    [items],
  );
  const recent = useMemo(() => (items ?? []).slice(0, 5), [items]);

  // ─── Sparkline data (daily buckets, last 9 days) ─────────────────────────
  const openSpark = useMemo(
    () => dailyBuckets(items ?? [], (e) => !['sent', 'closed', 'rejected', 'expired'].includes(e.status), 9),
    [items],
  );
  const turnaroundSpark = useMemo(
    () => turnaroundBuckets(items ?? [], 9),
    [items],
  );
  const deliveredSpark = useMemo(
    () => dailyBuckets(items ?? [], (e) => ['sent', 'closed'].includes(e.status), 9),
    [items],
  );
  const pipelineSpark = useMemo(() => {
    const buckets = dailyBuckets(items ?? [], (e) => e.predictedPriceCents != null, 9);
    // turn into a cumulative-style series so it climbs visually.
    return buckets.map((_v, i) => buckets.slice(0, i + 1).reduce((a, b) => a + b, 0));
  }, [items]);

  // ─── Funnel + weekly throughput ─────────────────────────────────────────
  const funnel = useMemo(
    () => FUNNEL_STAGES.map((s) => ({
      ...s,
      count: (items ?? []).filter((e) => s.statuses.includes(e.status)).length,
    })),
    [items],
  );
  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);
  const weekly = useMemo(() => weeklyThroughput(items ?? []), [items]);

  // ─── Activity feed (synthesised from engagement state) ───────────────────
  const activity = useMemo(() => deriveActivity(items ?? []), [items]);

  // Median turnaround label
  const turnaround = useMemo(() => medianTurnaroundMs(items ?? []), [items]);

  return (
    <AppShell crumbs={[{ label: 'Dashboard' }]}>
      <div className="page-inner dash-v2">
        {err && (
          <div className="card" style={{ padding: 12, color: 'var(--danger)', fontSize: 12.5 }}>{err}</div>
        )}

        <HeroHeader
          name={firstName}
          openCount={open.length}
          awaitingCount={awaitingApproval.length}
        />

        {awaitingApproval.length > 0 && (
          <PriorityBand items={awaitingApproval} />
        )}

        <div className="dash-stat-grid">
          <StatTile
            label="Open opportunities"
            value={open.length}
            delta={`${open.length === 0 ? 'None' : 'in flight'}`}
            deltaTone="ok"
            spark={openSpark}
            delay={60}
          />
          <StatTile
            label="Median turnaround"
            value={turnaround ? formatDuration(turnaround) : '—'}
            raw
            delta={turnaround ? 'submit → quote' : 'Not enough data'}
            deltaTone="ok"
            spark={turnaroundSpark}
            delay={140}
          />
          <StatTile
            label="Delivered this week"
            value={deliveredThisWeek.length}
            delta="Past 7 days"
            deltaTone="ok"
            spark={deliveredSpark}
            accent
            delay={220}
          />
          <StatTile
            label="Pipeline value"
            value={pipelineValueLabel(pipelineValue, workspaceCurrency)}
            raw
            delta={`${(items ?? []).filter((e) => e.predictedPriceCents != null).length} priced`}
            deltaTone="ok"
            spark={pipelineSpark}
            delay={300}
          />
        </div>

        <div className="dash-2col">
          <PipelineCard
            funnel={funnel}
            funnelMax={funnelMax}
            totalCount={(items ?? []).length}
            weekly={weekly}
          />
          <ActivityCard activity={activity} loading={items === null} />
        </div>

        <div className="dash-section-head">
          <div>
            <h2 className="dash-section-title">Recent opportunities</h2>
            <div className="dash-section-sub">
              {recent.length} of {(items ?? []).length} · sorted by activity
            </div>
          </div>
          <Link href="/opportunities" className="btn sm ghost">
            View all {items?.length ?? 0} <Icon.ArrowUpRight size={12} />
          </Link>
        </div>

        <div className="card recent-card">
          <table className="table recent-table">
            <thead>
              <tr>
                <th style={{ width: 96 }}>ID</th>
                <th>Opportunity</th>
                <th style={{ width: 180 }}>Stage</th>
                <th style={{ width: 110 }}>Updated</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty"><span className="spin" /></div>
                  </td>
                </tr>
              )}
              {items !== null && recent.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      No opportunities yet.{' '}
                      <Link href="/opportunities/new" style={{ color: 'var(--fg)' }}>
                        Issue your first link →
                      </Link>
                    </div>
                  </td>
                </tr>
              )}
              {recent.map((e, i) => (
                <tr
                  key={e.id}
                  className="recent-row"
                  style={{ animationDelay: `${i * 60 + 400}ms` }}
                  onClick={() => location.assign(`/opportunities/${e.id}`)}
                >
                  <td><span className="cell-mono">{e.id.slice(0, 8)}</span></td>
                  <td>
                    <div className="cell-strong">{e.name ?? e.clientEmail}</div>
                    <div className="cell-muted" style={{ fontSize: 12 }}>
                      {e.name ? `${e.clientEmail} · ${e.templateName}` : e.templateName}
                    </div>
                  </td>
                  <td><StageChip stage={e.status} /></td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>
                    {relativeTime(e.submittedAt ?? e.createdAt)}
                  </td>
                  <td>
                    <Icon.ChevronRight size={14} style={{ color: 'var(--fg-faint)' }} className="row-chev" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AppShell>
  );
}

// ─── Hero header ────────────────────────────────────────────────────────────
function HeroHeader({
  name, openCount, awaitingCount,
}: {
  name: string;
  openCount: number;
  awaitingCount: number;
}) {
  const greet = timeOfDay();
  const openAnim = useCountUp(openCount, { duration: 700 });
  return (
    <div className="dash-hero">
      <div className="dash-hero-bg" aria-hidden>
        <span className="orb o1" />
        <span className="orb o2" />
        <span className="orb o3" />
      </div>
      <div className="dash-hero-inner">
        <div style={{ minWidth: 0 }}>
          <div className="dash-eyebrow">
            <span className="live-dot" /> Workspace live
          </div>
          <h1 className="dash-hero-title">
            Good {greet}
            {name && <>, <span className="hero-name">{name}</span></>}
            <span className="hero-stop">.</span>
          </h1>
          <p className="dash-hero-sub">
            You have <b className="num">{openAnim}</b> open opportunit{openCount === 1 ? 'y' : 'ies'}
            {awaitingCount > 0 && (
              <>, <b className="hero-warn">{awaitingCount} waiting on you</b></>
            )}
            <span className="hero-faint"> · {fmtToday()}</span>
          </p>
        </div>
        <div className="dash-hero-actions">
          <Link href="/opportunities" className="btn">
            <Icon.Filter size={13} /> Browse
          </Link>
          <Link href="/opportunities/new" className="btn accent dash-shimmy">
            <Icon.Plus size={13} /> New opportunity
          </Link>
        </div>
      </div>
    </div>
  );
}

// ─── Priority band ──────────────────────────────────────────────────────────
function PriorityBand({ items }: { items: EngagementSummary[] }) {
  return (
    <div className="priority-band">
      <div className="priority-pulse">
        <Icon.Clock size={18} />
        <span className="priority-ring r1" />
        <span className="priority-ring r2" />
      </div>
      <div className="priority-body">
        <div className="priority-title">
          {items.length === 1 ? '1 approval' : `${items.length} approvals`} waiting on you
        </div>
        <div className="priority-sub">
          Rhud has priced {items.length === 1 ? 'an opportunity' : 'these opportunities'} and needs a green light before drafting.
        </div>
        <div className="priority-chips">
          {items.slice(0, 6).map((e, i) => (
            <Link
              key={e.id}
              href={`/opportunities/${e.id}`}
              className="priority-chip"
              style={{ animationDelay: `${i * 70 + 200}ms` }}
            >
              <span className="cell-mono priority-chip-id">{e.id.slice(0, 8)}</span>
              <span style={{
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180,
              }}>
                {e.name ?? e.clientEmail}
              </span>
              {e.predictedPriceCents != null && (
                <span className="num priority-chip-amt">
                  {formatPrice(e.predictedPriceCents, e.currency)}
                </span>
              )}
              <Icon.ArrowUpRight size={11} className="priority-chip-arrow" />
            </Link>
          ))}
        </div>
      </div>
      {items[0] && (
        <Link href={`/opportunities/${items[0].id}`} className="btn accent priority-cta dash-shimmy">
          Review now <Icon.ArrowUpRight size={12} />
        </Link>
      )}
    </div>
  );
}

// ─── Stat tile ──────────────────────────────────────────────────────────────
function StatTile({
  label, value, raw, delta, deltaTone = 'ok', spark, accent, delay = 0,
}: {
  label: string;
  value: number | string;
  raw?: boolean;
  delta?: string;
  deltaTone?: 'ok' | 'warn' | 'default';
  spark: number[];
  accent?: boolean;
  delay?: number;
}) {
  const animatedNum = useCountUp(typeof value === 'number' ? value : 0, { duration: 900 });
  const display = raw ? value : (typeof value === 'number' ? animatedNum : value);
  return (
    <MagnetCard className="stat dash-stat" style={{ animationDelay: `${delay}ms` }}>
      <div className="dash-stat-shine" aria-hidden />
      <div className="stat-label">{label}</div>
      <div className="stat-value">{display}</div>
      {delta && (
        <div className={`stat-delta ${deltaTone}`}>
          <Icon.TrendUp size={11} /> {delta}
        </div>
      )}
      <div className="stat-spark">
        <DrawSpark data={spark} accent={accent ?? false} delay={delay + 200} />
      </div>
    </MagnetCard>
  );
}

// ─── Pipeline card with animated rivers + weekly throughput ────────────────
function PipelineCard({
  funnel, funnelMax, totalCount, weekly,
}: {
  funnel: Array<{ id: string; label: string; tint: string; count: number }>;
  funnelMax: number;
  totalCount: number;
  weekly: number[];
}) {
  const [hover, setHover] = useState<string | null>(null);
  const weeklyMax = Math.max(...weekly, 1);
  const weekdays = weekdayLabels();
  const today = new Date().getDay(); // 0=Sun … 6=Sat
  return (
    <div className="card pipeline-card">
      <div className="pipeline-head">
        <div>
          <h3 className="dash-card-title">Pipeline by stage</h3>
          <div className="dash-card-sub">{totalCount} total opportunit{totalCount === 1 ? 'y' : 'ies'}</div>
        </div>
        <Link href="/opportunities" className="btn sm ghost">
          View all <Icon.ArrowUpRight size={12} />
        </Link>
      </div>

      <div className="pipeline-rows">
        {funnel.map((f, i) => {
          const pct = Math.max(4, (f.count / funnelMax) * 100);
          const isActive = hover === f.id;
          return (
            <div
              key={f.id}
              className={`pipeline-row ${isActive ? 'active' : ''}`}
              style={{ animationDelay: `${i * 80 + 250}ms` }}
              onMouseEnter={() => setHover(f.id)}
              onMouseLeave={() => setHover(null)}
            >
              <div className="pipeline-row-label">
                <span className="pipeline-row-icon" style={{ color: f.tint }}>
                  {stageIcon(f.id)}
                </span>
                {f.label}
              </div>
              <div className="pipeline-bar">
                <div
                  className="pipeline-bar-fill"
                  style={{
                    ['--w' as string]: `${pct}%`,
                    ['--c' as string]: f.tint,
                    animationDelay: `${i * 90 + 300}ms`,
                  } as React.CSSProperties}
                >
                  <span className="pipeline-bar-shimmer" />
                </div>
              </div>
              <div className="pipeline-row-count num">
                <CountInline target={f.count} delay={i * 90 + 400} />
              </div>
            </div>
          );
        })}
      </div>

      <div className="weekly-section">
        <div className="weekly-head">
          <span>Weekly throughput</span>
          <span className="weekly-sub">Mon — Sun</span>
        </div>
        <div className="weekly-bars">
          {weekly.map((v, i) => {
            // weekly[] is Mon..Sun; map to dow index for "today" highlight
            const dow = (i + 1) % 7; // i=0 Mon → 1, i=6 Sun → 0
            const isToday = dow === today;
            return (
              <div key={i} className="weekly-col">
                <div className="weekly-bar-track">
                  <div
                    className="weekly-bar"
                    style={{
                      ['--h' as string]: `${(v / weeklyMax) * 100}%`,
                      background: isToday ? 'var(--accent)' : 'var(--border-strong)',
                      animationDelay: `${i * 60 + 600}ms`,
                    } as React.CSSProperties}
                  >
                    <span className="weekly-tip">{v}</span>
                  </div>
                </div>
                <div className="weekly-day">{weekdays[i]}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Activity card ──────────────────────────────────────────────────────────
function ActivityCard({
  activity, loading,
}: {
  activity: ActivityItem[];
  loading: boolean;
}) {
  return (
    <div className="card activity-card">
      <div className="activity-head">
        <div>
          <h3 className="dash-card-title">Recent activity</h3>
          <div className="dash-card-sub">Across all opportunities</div>
        </div>
        <span className="activity-live"><span className="live-dot" /> Live</span>
      </div>
      <div className="activity-body">
        {loading && (
          <div className="empty" style={{ padding: 24 }}><span className="spin" /></div>
        )}
        {!loading && activity.length === 0 && (
          <div className="empty" style={{ padding: 32, fontSize: 12.5 }}>
            Nothing recent yet — issue an opportunity to see live activity here.
          </div>
        )}
        {!loading && activity.map((a, i) => (
          <div key={i} className="activity-row" style={{ animationDelay: `${i * 80 + 400}ms` }}>
            <div className="activity-rail" />
            <div className="activity-avatar" style={{ background: a.actorColor }}>
              {a.actor === 'rhud'
                ? <span style={{ fontSize: 12 }}>✦</span>
                : a.initial}
              {i === 0 && <span className="activity-pulse" />}
            </div>
            <div className="activity-msg-wrap">
              <div className="activity-msg">{a.msg}</div>
              <div className="activity-meta">
                {a.icon}
                {a.when}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Hooks: count-up + sparkline draw ──────────────────────────────────────
function useCountUp(
  target: number,
  { duration = 900, decimals = 0, prefix = '', suffix = '' }: {
    duration?: number;
    decimals?: number;
    prefix?: string;
    suffix?: string;
  } = {},
): string {
  const [val, setVal] = useState(0);
  useEffect(() => {
    let raf: number;
    let start: number | undefined;
    const ease = (t: number) => 1 - Math.pow(1 - t, 3);
    const tick = (ts: number) => {
      if (start == null) start = ts;
      const t = Math.min(1, (ts - start) / duration);
      setVal(target * ease(t));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  const formatted = decimals > 0 ? val.toFixed(decimals) : Math.round(val).toLocaleString();
  return prefix + formatted + suffix;
}

function CountInline({ target, delay = 0 }: { target: number; delay?: number }) {
  const [start, setStart] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStart(true), delay);
    return () => clearTimeout(id);
  }, [delay]);
  const v = useCountUp(start ? target : 0, { duration: 600 });
  return <>{v}</>;
}

function DrawSpark({
  data, accent = false, height = 32, delay = 0,
}: {
  data: number[];
  accent?: boolean;
  height?: number;
  delay?: number;
}) {
  const ref = useRef<SVGPathElement | null>(null);
  useEffect(() => {
    const path = ref.current;
    if (!path) return;
    const len = path.getTotalLength();
    path.style.transition = 'none';
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    void path.getBoundingClientRect();
    path.style.transition = `stroke-dashoffset 1100ms cubic-bezier(.22,.8,.3,1) ${delay}ms`;
    path.style.strokeDashoffset = '0';
  }, [data, delay]);

  // Guard against degenerate inputs.
  const safe = data.length > 1 ? data : [0, 0];
  const max = Math.max(...safe);
  const min = Math.min(...safe);
  const span = max - min || 1;
  const pts = safe.map((v, i) => {
    const x = (i / (safe.length - 1)) * 100;
    const y = 100 - ((v - min) / span) * 92 - 4;
    return [x, y] as const;
  });
  const lineD = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  const areaD = `${lineD} L100,100 L0,100 Z`;
  const stroke = accent ? 'var(--accent)' : 'var(--fg)';
  const lastPt = pts[pts.length - 1] ?? [100, 50];
  const gradId = `sg-${delay}-${Math.round(safe[0] ?? 0)}-${Math.round(max)}`;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ width: '100%', height, display: 'block', overflow: 'visible' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradId})`} style={{ animation: `dashFadeIn .6s ${delay + 700}ms both` }} />
      <path
        ref={ref}
        d={lineD}
        fill="none"
        stroke={stroke}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={lastPt[0]}
        cy={lastPt[1]}
        r="2"
        fill={stroke}
        style={{ animation: `dashDotPop .4s ${delay + 1100}ms both`, transformOrigin: 'center', transformBox: 'fill-box' }}
      />
    </svg>
  );
}

// ─── Magnetic hover wrapper ────────────────────────────────────────────────
function MagnetCard({
  children, intensity = 4, className, style,
}: {
  children: React.ReactNode;
  intensity?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - r.left) / r.width - 0.5;
    const dy = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `translate(${dx * intensity}px, ${dy * intensity}px)`;
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }
  function onLeave() {
    const el = ref.current;
    if (!el) return;
    el.style.transform = '';
  }
  return (
    <div
      ref={ref}
      className={className}
      style={{ transition: 'transform .25s cubic-bezier(.22,.8,.3,1)', ...style }}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      {children}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────
type ActivityItem = {
  msg: React.ReactNode;
  icon: React.ReactNode;
  when: string;
  actor: 'rhud' | 'client' | 'rep';
  actorColor: string;
  initial: string;
};

function deriveActivity(items: EngagementSummary[]): ActivityItem[] {
  // Synthesize a feed from the engagements themselves. We don't have a
  // tenant-wide thread events endpoint, so we narrate state changes per
  // engagement using the timestamps we already have.
  const out: ActivityItem[] = [];
  for (const e of items) {
    const when = e.submittedAt ?? e.createdAt;
    const whenAge = Date.now() - new Date(when).getTime();
    if (whenAge > 14 * 86_400_000) continue; // older than 2 weeks — skip
    const client = e.name ?? e.clientEmail;
    const initial = (e.clientEmail.slice(0, 1) || '?').toUpperCase();
    const clientItem: Omit<ActivityItem, 'msg' | 'icon'> = {
      when: relativeTime(when),
      actor: 'client',
      actorColor: actorColor(e.clientEmail),
      initial,
    };
    switch (e.status) {
      case 'sent':
      case 'closed':
        out.push({
          ...clientItem,
          actor: 'rhud',
          actorColor: 'var(--accent-tint)',
          msg: <>Proposal delivered to <b>{client}</b></>,
          icon: <Icon.Send size={11} />,
        });
        break;
      case 'draft_ready':
        out.push({
          ...clientItem,
          actor: 'rhud',
          actorColor: 'var(--accent-tint)',
          msg: <>Draft ready for <b>{client}</b></>,
          icon: <Icon.Sparkles size={11} />,
        });
        break;
      case 'drafting':
        out.push({
          ...clientItem,
          actor: 'rhud',
          actorColor: 'var(--accent-tint)',
          msg: <>Drafting proposal for <b>{client}</b></>,
          icon: <Icon.Sparkles size={11} />,
        });
        break;
      case 'approved':
        out.push({
          ...clientItem,
          actor: 'rep',
          actorColor: 'oklch(0.65 0.14 150)',
          msg: <>Approved <b>{client}</b>{e.predictedPriceCents != null && <> at <b className="num">{formatPrice(e.predictedPriceCents, e.currency)}</b></>}</>,
          icon: <Icon.Check size={11} />,
        });
        break;
      case 'pending_approval':
        out.push({
          ...clientItem,
          actor: 'rhud',
          actorColor: 'var(--warn-tint)',
          msg: <><b>{client}</b> awaiting approval{e.predictedPriceCents != null && <> · <b className="num">{formatPrice(e.predictedPriceCents, e.currency)}</b></>}</>,
          icon: <Icon.Clock size={11} />,
        });
        break;
      case 'predicted':
        out.push({
          ...clientItem,
          actor: 'rhud',
          actorColor: 'var(--accent-tint)',
          msg: <>Predicted{e.predictedPriceCents != null && <> <b className="num">{formatPrice(e.predictedPriceCents, e.currency)}</b></>} for <b>{client}</b></>,
          icon: <Icon.Sparkle size={11} />,
        });
        break;
      case 'submitted':
        out.push({
          ...clientItem,
          msg: <><b>{client}</b> submitted scope</>,
          icon: <Icon.Send size={11} />,
        });
        break;
      case 'in_progress':
        out.push({
          ...clientItem,
          msg: <><b>{client}</b> started filling scope</>,
          icon: <Icon.Edit size={11} />,
        });
        break;
      case 'issued':
        out.push({
          ...clientItem,
          actor: 'rep',
          actorColor: 'var(--bg-sunk)',
          msg: <>Link issued to <b>{client}</b></>,
          icon: <Icon.Link size={11} />,
        });
        break;
      case 'rejected':
        out.push({
          ...clientItem,
          actor: 'rep',
          actorColor: 'var(--danger-tint)',
          msg: <>Rejected <b>{client}</b></>,
          icon: <Icon.X size={11} />,
        });
        break;
    }
  }
  // Already roughly sorted (items list is desc); slice to 6.
  return out.slice(0, 6);
}

function actorColor(email: string): string {
  // Stable per-email tint so the same client always has the same dot
  // color across the activity feed.
  let h = 0;
  for (let i = 0; i < email.length; i++) h = ((h * 31) + email.charCodeAt(i)) & 0xffff;
  const hue = h % 360;
  return `oklch(0.78 0.08 ${hue})`;
}

function dailyBuckets(
  items: EngagementSummary[],
  pred: (e: EngagementSummary) => boolean,
  days: number,
): number[] {
  const out = new Array(days).fill(0);
  const now = Date.now();
  for (const e of items) {
    if (!pred(e)) continue;
    const t = new Date(e.submittedAt ?? e.createdAt).getTime();
    const idx = days - 1 - Math.floor((now - t) / 86_400_000);
    if (idx >= 0 && idx < days) out[idx] += 1;
  }
  return out;
}

function turnaroundBuckets(items: EngagementSummary[], days: number): number[] {
  // For each of the last N days, average submit→quote turnaround in hours
  // for engagements submitted that day. The chart shows the trend (lower =
  // faster). When no submissions on a day, fall back to the previous day's
  // value so the line stays continuous.
  const out: number[] = new Array(days).fill(0);
  const counts: number[] = new Array(days).fill(0);
  const now = Date.now();
  for (const e of items) {
    if (!e.submittedAt) continue;
    const submitted = new Date(e.submittedAt).getTime();
    const created = new Date(e.createdAt).getTime();
    const idx = days - 1 - Math.floor((now - submitted) / 86_400_000);
    if (idx < 0 || idx >= days) continue;
    out[idx] = (out[idx] ?? 0) + (submitted - created) / 3_600_000; // hours
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  let last = 0;
  for (let i = 0; i < days; i++) {
    const c = counts[i] ?? 0;
    const sum = out[i] ?? 0;
    if (c > 0) {
      out[i] = sum / c;
      last = out[i] as number;
    } else {
      out[i] = last;
    }
  }
  return out;
}

function weeklyThroughput(items: EngagementSummary[]): number[] {
  // Mon..Sun count of opportunities updated within the last 7 days.
  const out = new Array(7).fill(0);
  const now = Date.now();
  for (const e of items) {
    const t = new Date(e.submittedAt ?? e.createdAt).getTime();
    if (now - t > 7 * 86_400_000) continue;
    const dow = new Date(t).getDay(); // 0=Sun
    const idx = (dow + 6) % 7; // 0=Mon … 6=Sun
    out[idx] += 1;
  }
  return out;
}

function weekdayLabels(): string[] {
  return ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
}

function medianTurnaroundMs(items: EngagementSummary[]): number | null {
  const deltas = items
    .filter((e) => e.submittedAt)
    .map((e) => new Date(e.submittedAt!).getTime() - new Date(e.createdAt).getTime())
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  if (deltas.length === 0) return null;
  const mid = Math.floor(deltas.length / 2);
  if (deltas.length % 2 === 0) return ((deltas[mid - 1]! + deltas[mid]!) / 2);
  return deltas[mid]!;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function pipelineValueLabel(cents: number, currency: string | null): string {
  if (cents === 0) return '—';
  return formatPrice(cents, currency);
}

function formatPrice(cents: number, currency: string | null): string {
  const code = (currency ?? 'USD').toUpperCase();
  const units = cents / 100;
  const symbol = currencySymbol(code);
  const abs = Math.abs(units);
  let body: string;
  if (abs >= 10_000_000 && code === 'INR') {
    body = `${(units / 10_000_000).toFixed(units % 10_000_000 === 0 ? 0 : 1)}Cr`;
  } else if (abs >= 100_000 && code === 'INR') {
    body = `${(units / 100_000).toFixed(units % 100_000 === 0 ? 0 : 1)}L`;
  } else if (abs >= 1_000_000) {
    body = `${(units / 1_000_000).toFixed(units % 1_000_000 === 0 ? 0 : 1)}M`;
  } else if (abs >= 1_000) {
    body = `${(units / 1_000).toFixed(units % 1_000 === 0 ? 0 : 1)}k`;
  } else {
    body = units.toFixed(0);
  }
  return `${symbol}${body}`;
}

function currencySymbol(code: string): string {
  switch (code) {
    case 'INR': return '₹';
    case 'USD': return '$';
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'JPY': return '¥';
    case 'AUD': return 'A$';
    case 'CAD': return 'C$';
    default: {
      try {
        const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
        const parts = fmt.formatToParts(0);
        return parts.find((p) => p.type === 'currency')?.value ?? `${code} `;
      } catch {
        return `${code} `;
      }
    }
  }
}

function stageIcon(id: string): React.ReactNode {
  switch (id) {
    case 'scope':     return <Icon.Thread size={11} />;
    case 'pricing':   return <Icon.Sparkle size={11} />;
    case 'approval':  return <Icon.Clock size={11} />;
    case 'drafting':  return <Icon.Sparkles size={11} />;
    case 'delivered': return <Icon.Send size={11} />;
    default:          return <Icon.Dot size={11} />;
  }
}

function timeOfDay(): string {
  const h = new Date().getHours();
  if (h < 5) return 'evening';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function fmtToday(): string {
  return new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
