'use client';

import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { ComingSoon } from '@/components/coming-soon';

export default function AutomationsPage() {
  const user = useRequireAuth();
  if (!user) return null;
  return (
    <AppShell crumbs={[{ label: 'Automations' }]}>
      <ComingSoon
        title="Automations"
        subtitle="Tenant-defined rules that fire on thread events."
        iconName="Zap"
        sprint="sprint 8"
        bullets={[
          'When-this-then-that recipes keyed off thread event types',
          'Auto-escalate approvals after an SLA window expires',
          'Auto-close engagements with no client activity for N days',
          'Custom Slack / Teams routing per service line',
        ]}
      />
    </AppShell>
  );
}
