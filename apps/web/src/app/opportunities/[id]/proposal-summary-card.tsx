'use client';

import Link from 'next/link';
import { Icon } from '@/components/icon';

// ── Proposal summary card (links to the dedicated proposal workspace) ───────
//
// The full draft preview, regenerate flow, send modal, and manual-paste UX
// all live on the dedicated /opportunities/[id]/proposal route now. This
// card is just the at-a-glance summary in the artifact pane — status chip
// + a CTA into the workspace where the user has room to actually work.

export function ProposalSummaryCard({
  engagementId,
  status,
}: {
  engagementId: string;
  status: string;
}) {
  const isReady = status === 'draft_ready';
  const isDrafting = status === 'drafting';
  const isSent = status === 'sent';

  const chip = isSent ? (
    <span className="chip ok"><Icon.Check size={10} /> Sent</span>
  ) : isReady ? (
    <span className="chip accent"><Icon.Sparkles size={10} /> Draft ready</span>
  ) : isDrafting ? (
    <span className="chip warn">
      <span style={{ display: 'inline-flex', animation: 'spin 1.2s linear infinite' }}>
        <Icon.Clock size={10} />
      </span>
      Drafting
    </span>
  ) : (
    <span className="chip outline">
      <span style={{ display: 'inline-flex', animation: 'pulse 1.8s ease-in-out infinite' }}>
        <Icon.Sparkle size={10} />
      </span>
      Awaiting draft
    </span>
  );

  const ctaLabel = isSent
    ? 'View proposal'
    : isReady
      ? 'Open proposal'
      : isDrafting
        ? 'View progress'
        : 'Open workspace';

  const description = isSent
    ? 'Proposal has been sent to the client. Open the workspace to review what went out.'
    : isReady
      ? 'Draft is ready — open the workspace to review, regenerate, or send to the client.'
      : isDrafting
        ? 'Generation in progress. Open the workspace to follow along — usually 30-90s for Gamma decks.'
        : 'Generate a client-ready proposal from the approved scope + price in the dedicated workspace.';

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        gap: 12, marginBottom: 10,
      }}>
        <div style={{ minWidth: 0 }}>
          <div className="section-label">Proposal</div>
        </div>
        {chip}
      </div>
      <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
        {description}
      </p>
      <Link
        href={`/opportunities/${engagementId}/proposal`}
        className={'btn sm ' + (isReady || isSent ? 'accent' : '')}
      >
        {ctaLabel} <Icon.ArrowUpRight size={11} />
      </Link>
    </div>
  );
}
