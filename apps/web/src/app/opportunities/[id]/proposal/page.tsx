'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  gamma,
  opportunities,
  type EngagementSummary,
  type ProposalDriver,
  type ThreadEventRow,
  type GatheringLinkInfo,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { ProposalWorkspace } from './proposal-workspace';

type EngagementWithThread = EngagementSummary & {
  thread: ThreadEventRow[];
  gatheringLink: GatheringLinkInfo | null;
};

export default function ProposalPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [eng, setEng] = useState<EngagementWithThread | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // The engagement payload doesn't carry which drafter is active, so the
  // proposal driver comes from the tenant Gamma config. Default to 'llm'
  // when Gamma isn't configured (gamma.get() → null) so the workspace
  // never renders the Gamma-only setup card by mistake.
  const [proposalDriver, setProposalDriver] = useState<ProposalDriver>('llm');

  useEffect(() => {
    if (!user) return;
    opportunities.get(id).then(setEng).catch((e) => setErr(String(e)));
  }, [id, user]);

  useEffect(() => {
    if (!user) return;
    gamma
      .get()
      .then((cfg) => setProposalDriver(cfg?.proposalDriver ?? 'llm'))
      .catch(() => setProposalDriver('llm'));
  }, [user]);

  if (err) {
    return (
      <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'Not found' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22, color: 'var(--danger)' }}>{err}</div>
        </div>
      </AppShell>
    );
  }
  if (!eng || !user) {
    return (
      <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }]}>
        <div className="page-inner empty"><span className="spin" /></div>
      </AppShell>
    );
  }

  const headerTitle = eng.name ?? eng.clientEmail;
  const draftableStatus = ['approved', 'drafting', 'draft_ready', 'sent'].includes(eng.status);

  return (
    <AppShell
      crumbs={[
        { label: 'Opportunities', href: '/opportunities' },
        { label: headerTitle, href: `/opportunities/${eng.id}` },
        { label: 'Proposal' },
      ]}
    >
      <div className="page-inner" style={{ padding: '16px 24px 24px' }}>
        {draftableStatus ? (
          <ProposalWorkspace
            engagementId={eng.id}
            engagementName={headerTitle}
            clientEmail={eng.clientEmail}
            userRole={user.role}
            proposalDriver={proposalDriver}
            backHref={`/opportunities/${eng.id}`}
          />
        ) : (
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div className="card" style={{ padding: 32, textAlign: 'center' }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
                Proposal not ready yet
              </div>
              <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                The proposal workspace opens once the price has been approved.
                Current status: <span className="mono">{eng.status}</span>.
              </p>
              <a className="btn sm" href={`/opportunities/${eng.id}`}>
                Back to opportunity
              </a>
            </div>
          </div>
        )}
      </div>
    </AppShell>
  );
}
