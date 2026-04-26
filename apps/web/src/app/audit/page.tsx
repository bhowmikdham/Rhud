'use client';

import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { ComingSoon } from '@/components/coming-soon';

export default function AuditPage() {
  const user = useRequireAuth();
  if (!user) return null;
  return (
    <AppShell crumbs={[{ label: 'Audit chain' }]}>
      <ComingSoon
        title="Audit chain"
        subtitle="Tamper-evident hash chain over every thread event in your workspace."
        iconName="Shield"
        sprint="sprint 4 (server) · UI sprint 6"
        bullets={[
          'View the latest chain link, root hash, and event window covered',
          'Run an integrity verification on demand and see which sequence diverged (if any)',
          'Export the chain to S3 Object Lock for compliance retention',
          'Backend already exposes POST /audit/build and /audit/verify — admin-only',
        ]}
      />
    </AppShell>
  );
}
