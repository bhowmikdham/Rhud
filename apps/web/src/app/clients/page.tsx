'use client';

import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { ComingSoon } from '@/components/coming-soon';

export default function ClientsPage() {
  const user = useRequireAuth();
  if (!user) return null;
  return (
    <AppShell crumbs={[{ label: 'Clients' }]}>
      <ComingSoon
        title="Clients"
        subtitle="Companies you've engaged with, their contacts, and historical context."
        iconName="Users"
        sprint="sprint 8"
        bullets={[
          'A row per client company with all engagements rolled up',
          'Contact directory pulled from engagement client_email + Odoo partner records',
          'Prior-quote history surfaced when you start a new engagement with the same company',
        ]}
      />
    </AppShell>
  );
}
