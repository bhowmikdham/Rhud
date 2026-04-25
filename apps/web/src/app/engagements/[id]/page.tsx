'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { engagements, type EngagementSummary, type ThreadEventRow } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { StageChip } from '@/components/stage-chip';

const EVENT_LABELS: Record<string, string> = {
  link_issued: 'Link issued to client',
  link_opened: 'Client opened the link',
  node_answered: 'Question answered',
  file_uploaded: 'File uploaded',
  scope_submitted: 'Scope submitted',
  price_predicted: 'Price predicted',
  approval_requested: 'Approval requested',
  approval_granted: 'Approved',
  approval_adjusted: 'Approved with adjustment',
  approval_rejected: 'Rejected',
  proposal_draft_requested: 'Drafting proposal',
  proposal_draft_ready: 'Proposal draft ready',
  proposal_sent: 'Proposal sent',
  engagement_synced: 'Synced to Odoo',
  engagement_closed: 'Engagement closed',
};

const EVENT_ICONS: Partial<Record<string, keyof typeof Icon>> = {
  link_issued: 'Link',
  link_opened: 'Eye',
  node_answered: 'Check',
  file_uploaded: 'Paperclip',
  scope_submitted: 'Send',
  price_predicted: 'Sparkle',
  approval_requested: 'Clock',
  approval_granted: 'Check',
  approval_adjusted: 'Edit',
  approval_rejected: 'X',
  proposal_draft_requested: 'Sparkles',
  proposal_draft_ready: 'FileText',
  proposal_sent: 'Send',
  engagement_synced: 'Globe',
  engagement_closed: 'CheckCircle',
};

type EngagementWithThread = EngagementSummary & { thread: ThreadEventRow[] };

export default function EngagementDetailPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [eng, setEng] = useState<EngagementWithThread | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    engagements.get(id).then(setEng).catch((e) => setErr(String(e)));
  }, [id, user]);

  if (err) {
    return (
      <AppShell crumbs={[{ label: 'Engagements', href: '/engagements' }, { label: 'Not found' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22, color: 'var(--danger)' }}>{err}</div>
        </div>
      </AppShell>
    );
  }
  if (!eng) {
    return (
      <AppShell crumbs={[{ label: 'Engagements', href: '/engagements' }]}>
        <div className="page-inner empty"><span className="spin" /></div>
      </AppShell>
    );
  }

  return (
    <AppShell crumbs={[{ label: 'Engagements', href: '/engagements' }, { label: eng.clientEmail }]}>
      <div className="thread-split">
        <div className="thread-pane">
          <div className="thread-head">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
              <div style={{ minWidth: 0 }}>
                <div className="thread-title">{eng.clientEmail}</div>
                <div className="thread-meta">
                  <span className="mono" style={{ color: 'var(--fg-subtle)' }}>{eng.id.slice(0, 8)}</span>
                  <span className="dot">·</span>
                  <span>{eng.templateName}</span>
                </div>
              </div>
              <button className="btn sm ghost" title="More">
                <Icon.More size={13} />
              </button>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
              <StageChip stage={eng.status} />
              <span className="chip"><Icon.Mail size={10} />{eng.clientEmail}</span>
              <span className="chip"><Icon.Calendar size={10} />{new Date(eng.createdAt).toLocaleDateString()}</span>
            </div>
          </div>

          <div className="thread-body">
            {eng.thread.length === 0 ? (
              <div className="empty">No thread events yet.</div>
            ) : eng.thread.map((ev) => {
              const IconComp = Icon[EVENT_ICONS[ev.eventType] ?? 'Dot' as keyof typeof Icon];
              return (
                <div key={ev.id} className="thread-event done">
                  <div className="node">{IconComp && <IconComp size={8} />}</div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <span className="actor">{actorLabel(ev)}</span>
                    <span className="when mono">{relativeTime(ev.createdAt)}</span>
                    {ev.actorType === 'client' && <span className="pill"><Icon.User size={8} />client</span>}
                    {ev.actorType === 'system' && <span className="pill"><Icon.Sparkle size={8} />system</span>}
                  </div>
                  <div className="msg">
                    <b>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</b>
                    {payloadHint(ev)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="artifact-pane">
          <div className="artifact-head">
            <div>
              <div className="artifact-title">Engagement state</div>
              <div className="artifact-sub">
                Status: <span className="mono">{eng.status}</span>
              </div>
            </div>
            <Link href="/engagements" className="btn sm"><Icon.ChevronLeft size={12} />All engagements</Link>
          </div>
          <div className="artifact-body">
            <div className="card" style={{ padding: 22 }}>
              <div className="section-label" style={{ marginBottom: 10 }}>Engagement</div>
              <Row k="Client email" v={eng.clientEmail} />
              <Row k="Template" v={eng.templateName} />
              <Row k="Created" v={new Date(eng.createdAt).toLocaleString()} />
              {eng.submittedAt && <Row k="Submitted" v={new Date(eng.submittedAt).toLocaleString()} />}
              <Row k="Engagement id" v={<span className="mono">{eng.id}</span>} />
            </div>

            <div className="card" style={{ padding: 22, marginTop: 16 }}>
              <div className="section-label" style={{ marginBottom: 10 }}>What happens next</div>
              <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.55 }}>
                {nextStepHint(eng.status)}
              </p>
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--divider)' }}>
      <div style={{ color: 'var(--fg-muted)', fontSize: 12.5 }}>{k}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{v}</div>
    </div>
  );
}

function actorLabel(ev: ThreadEventRow): string {
  if (ev.actorType === 'client') return 'Client';
  if (ev.actorType === 'system') return 'rhud';
  if (ev.actorType === 'integration') return 'Integration';
  return 'Sales';
}

function payloadHint(ev: ThreadEventRow): React.ReactNode {
  const p = ev.payload as Record<string, unknown> | null;
  if (!p) return null;
  if (ev.eventType === 'file_uploaded' && typeof p.filename === 'string') {
    return <> · {p.filename}</>;
  }
  if (ev.eventType === 'link_issued' && typeof p.expiresAt === 'string') {
    return <> · expires {new Date(p.expiresAt).toLocaleDateString()}</>;
  }
  return null;
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
  return `${d}d ago`;
}

function nextStepHint(status: string): string {
  switch (status) {
    case 'issued': return 'Waiting on the client to open the link and start answering. They get a tokenised URL — no account required.';
    case 'in_progress': return 'Client is filling the form. Their progress saves between sessions.';
    case 'submitted': return 'Scope received. Sprint 5 will trigger ML price prediction here.';
    case 'predicted': return 'Price band ready. Sales manager review next.';
    case 'pending_approval': return 'Manager review pending. Approve to start drafting.';
    case 'approved': return 'Approved. Gamma drafting kicks off automatically (sprint 7).';
    case 'drafting': return 'Gamma is generating the proposal.';
    case 'draft_ready': return 'Draft is in the portal — review before sending.';
    case 'sent': return 'Proposal delivered. Engagement auto-closes after 14 days unless the client responds.';
    case 'closed': return 'Engagement closed. Audit chain sealed.';
    default: return 'Awaiting the next signal.';
  }
}
