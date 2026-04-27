'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  rateCards,
  describeError,
  type RateCardSummary,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { RowActions } from '@/components/row-actions';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { RateCardUploadModal } from './upload-modal';

export default function RateCardsListPage() {
  const user = useRequireAuth();
  const [items, setItems] = useState<RateCardSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ card: RateCardSummary; templateBindings: number } | null>(null);

  const canEdit = user ? user.role === 'admin' : false;

  async function startDelete(c: RateCardSummary) {
    try {
      const { templateBindings } = await rateCards.usage(c.id);
      setPendingDelete({ card: c, templateBindings });
    } catch (e) {
      setErr(describeError(e));
    }
  }

  const refresh = useCallback(() => {
    rateCards.list().then(setItems).catch((e) => setErr(describeError(e)));
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user, refresh]);

  async function seedSample() {
    if (seeding) return;
    setSeeding(true);
    setErr(null);
    try {
      await rateCards.seedSample();
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setSeeding(false);
    }
  }

  const published = items?.filter((c) => c.status === 'published') ?? [];
  const drafts = items?.filter((c) => c.status === 'draft') ?? [];

  return (
    <AppShell crumbs={[{ label: 'Pricing' }, { label: 'Rate cards' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Rate cards</h1>
            <p className="page-subtitle">
              Versioned price books. Draft → review → publish. Templates and quotes pull from whichever card is published.
            </p>
          </div>
          {canEdit && (
            <div className="page-actions">
              {items?.length === 0 && (
                <button onClick={seedSample} className="btn sm" disabled={seeding}>
                  {seeding ? <span className="spin" /> : <><Icon.Sparkle size={12} /> Load sample</>}
                </button>
              )}
              <button onClick={() => setShowUpload(true)} className="btn accent">
                <Icon.Plus size={13} />
                Upload rate card
              </button>
            </div>
          )}
        </div>

        {err && (
          <div
            className="card"
            style={{
              padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
              background: 'var(--danger-tint)',
              borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
            }}
          >
            {err}
          </div>
        )}

        {!canEdit && (
          <div
            className="card"
            style={{
              padding: '10px 14px', fontSize: 12, color: 'var(--fg-muted)',
              marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg-sunk)',
            }}
          >
            <Icon.Lock size={12} style={{ color: 'var(--fg-subtle)' }} />
            Read-only — only admins can upload, publish, or archive rate cards.
          </div>
        )}

        {items !== null && items.length > 0 && (
          <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <Stat label="Published" value={String(published.length)} tone={published.length > 0 ? 'ok' : 'default'} />
            <Stat label="Drafts" value={String(drafts.length)} tone={drafts.length > 0 ? 'warn' : 'default'} />
            <Stat label="Total versions" value={String(items.length)} />
          </div>
        )}

        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th style={{ width: 90 }}>Version</th>
                <th style={{ width: 130 }}>Status</th>
                <th style={{ width: 100 }}>Currency</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {items === null && !err && (
                <tr><td colSpan={5}><div className="empty">Loading…</div></td></tr>
              )}
              {items?.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">
                      <div style={{ fontSize: 13, color: 'var(--fg)', marginBottom: 6 }}>
                        No rate cards yet.
                      </div>
                      {canEdit ? (
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                          Upload your CSaaS rate card spreadsheet, or load the sample to see what published looks like.
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                          Ask an admin to upload your rate card.
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {items?.map((c) => (
                <tr key={c.id} onClick={() => location.assign(`/rate-cards/${c.id}`)}>
                  <td className="cell-strong">{c.name}</td>
                  <td className="cell-mono">v{c.version}</td>
                  <td><StatusChip status={c.status} /></td>
                  <td className="cell-muted">{c.currency}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>
                    <RowActions
                      size="sm"
                      stopPropagation
                      items={[
                        {
                          label: 'Open',
                          icon: 'ArrowUpRight',
                          onClick: () => location.assign(`/rate-cards/${c.id}`),
                        },
                        { divider: true },
                        {
                          label: 'Delete rate card',
                          icon: 'X',
                          danger: true,
                          disabled: !canEdit,
                          title: canEdit ? undefined : 'Admin only',
                          onClick: () => void startDelete(c),
                        },
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {items !== null && items.length > 0 && (
          <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
            <Icon.FileText size={11} />
            Templates pick a rate card on the
            {' '}
            <Link href="/templates" style={{ color: 'var(--fg-muted)', textDecoration: 'underline' }}>templates page</Link>.
          </div>
        )}
      </div>

      {showUpload && <RateCardUploadModal onClose={() => { setShowUpload(false); refresh(); }} />}

      {pendingDelete && (
        <DeleteConfirmModal
          title="Delete rate card"
          subject={`${pendingDelete.card.name} · v${pendingDelete.card.version}`}
          description={
            <>
              Removes the rate card and every service line, tier, and open-priced service inside it.
              {pendingDelete.templateBindings > 0 ? (
                <>
                  {' '}
                  <b>{pendingDelete.templateBindings} template{pendingDelete.templateBindings === 1 ? '' : 's'}</b>{' '}
                  bound to this card will be unbound — they keep existing but won&apos;t produce a price until you bind them to another card.
                </>
              ) : (
                <> No templates are currently bound to it.</>
              )}
              {pendingDelete.card.status === 'published' && (
                <> {' '}<b>This card is currently published.</b> Consider archiving it first if you might roll back later.</>
              )}
            </>
          }
          confirmPhrase={pendingDelete.card.status === 'published' ? pendingDelete.card.name : 'delete'}
          onCancel={() => setPendingDelete(null)}
          onConfirm={async () => {
            await rateCards.remove(pendingDelete.card.id);
            setPendingDelete(null);
            refresh();
          }}
        />
      )}
    </AppShell>
  );
}

function StatusChip({ status }: { status: RateCardSummary['status'] }) {
  if (status === 'published') return <span className="chip ok"><Icon.Dot size={8} /> Published</span>;
  if (status === 'archived') return <span className="chip outline"><Icon.Dot size={8} /> Archived</span>;
  return <span className="chip warn"><Icon.Dot size={8} /> Draft</span>;
}

function Stat({ label, value, tone = 'default' }: { label: string; value: string; tone?: 'default' | 'warn' | 'ok' }) {
  const color = tone === 'warn' && value !== '0' ? 'var(--warn)'
    : tone === 'ok' && value !== '0' ? 'var(--ok)'
    : undefined;
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={color ? { color } : undefined}>{value}</div>
    </div>
  );
}
