'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { templates, describeError, type Template } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { RowActions } from '@/components/row-actions';
import { DeleteConfirmModal } from '@/components/delete-confirm-modal';
import { AiAssistModal } from './ai-assist-modal';

export default function TemplatesListPage() {
  const user = useRequireAuth();
  const router = useRouter();
  const [items, setItems] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAi, setShowAi] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<{ template: Template; engagementCount: number } | null>(null);

  const canEdit = user ? ['admin', 'sales_manager'].includes(user.role) : false;

  function refresh() {
    templates.list().then(setItems).catch((e) => setErr(describeError(e)));
  }

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user]);

  async function startDelete(t: Template) {
    // Probe usage first so the modal can either offer Delete OR show
    // the blocked message with a count + suggestion.
    try {
      const { engagementCount } = await templates.usage(t.id);
      setPendingDelete({ template: t, engagementCount });
    } catch (e) {
      setErr(describeError(e));
    }
  }

  async function createFromAi(args: { name: string; serviceLine: string; nodes: Array<{ question: string; nodeType: import('@/lib/api').NodeType; helpText?: string; required?: boolean; options?: import('@/lib/api').NodeOption[] }> }) {
    // Two-step: create the template, then bulk-import the AI-generated
    // nodes via the existing import endpoint. On success, jump to the
    // editor so the user can refine.
    const created = await templates.create({ name: args.name, serviceLine: args.serviceLine });
    await templates.importNodes(created.id, { replace: true, nodes: args.nodes });
    router.push(`/templates/${created.id}`);
  }

  return (
    <AppShell crumbs={[{ label: 'Templates' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Templates</h1>
            <p className="page-subtitle">
              Decision-tree forms your sales team uses to gather scope. Branch by answer, attach files at any step.
            </p>
          </div>
          {canEdit && (
            <div className="page-actions">
              <button onClick={() => setShowAi(true)} className="btn">
                <Icon.Sparkles size={13} />
                Generate with AI
              </button>
              <Link href="/templates/new" className="btn accent">
                <Icon.Plus size={13} />
                New template
              </Link>
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
            Read-only — only admins and sales managers can author templates.
          </div>
        )}

        {showAi && (
          <AiAssistModal
            onClose={() => setShowAi(false)}
            onCreate={createFromAi}
          />
        )}

        {pendingDelete && (
          <DeleteConfirmModal
            title="Delete template"
            subject={pendingDelete.template.name}
            description={
              <>
                Removes this template and all of its questions. Existing opportunities
                that were issued from older versions of the template are not affected.
              </>
            }
            blockedReason={pendingDelete.engagementCount > 0 ? (
              <>
                <b>{pendingDelete.engagementCount} opportunit{pendingDelete.engagementCount === 1 ? 'y is' : 'ies are'} using this template.</b>{' '}
                Templates can&apos;t be deleted while opportunities reference them — archive it instead, or delete those opportunities first.
              </>
            ) : undefined}
            confirmPhrase="delete"
            onCancel={() => setPendingDelete(null)}
            onConfirm={async () => {
              await templates.remove(pendingDelete.template.id);
              setPendingDelete(null);
              refresh();
            }}
          />
        )}

        {items && items.some((t) => t.status === 'published' && !t.rateCardId) && (
          <div
            className="card"
            style={{
              padding: '12px 14px', marginBottom: 16, fontSize: 12.5,
              background: 'var(--warn-tint)', color: 'var(--warn)',
              borderColor: 'color-mix(in oklch, var(--warn) 22%, transparent)',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}
          >
            <Icon.Sparkle size={12} style={{ marginTop: 2 }} />
            <div>
              <b>One or more published templates have no rate card bound.</b>{' '}
              Opportunities issued from those templates won&apos;t produce a price prediction. Open the template and assign a rate card.
            </div>
          </div>
        )}

        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Service line</th>
                <th style={{ width: 120 }}>Status</th>
                <th style={{ width: 130 }}>Rate card</th>
                <th style={{ width: 80 }}>Version</th>
                <th style={{ width: 160 }}>Updated</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {items === null && !err && (
                <tr><td colSpan={7}><div className="empty">Loading…</div></td></tr>
              )}
              {items?.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">
                      No templates yet.
                      {canEdit && (
                        <>
                          {' '}
                          <Link href="/templates/new" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>Create one</Link>.
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              )}
              {items?.map((t) => (
                <tr key={t.id} onClick={() => location.assign(`/templates/${t.id}`)}>
                  <td className="cell-strong">{t.name}</td>
                  <td className="cell-muted">{t.serviceLine}</td>
                  <td>
                    <span className={'chip ' + (t.status === 'published' ? 'ok' : t.status === 'archived' ? '' : 'warn')}>
                      <Icon.Dot size={8} />
                      {t.status}
                    </span>
                  </td>
                  <td>
                    {t.rateCardId
                      ? <span className="chip ok"><Icon.Check size={9} sw={2.2} /> Bound</span>
                      : <span className="chip warn" title="Without a rate card, opportunities can't be priced">
                          <Icon.X size={9} sw={2.2} /> Not bound
                        </span>}
                  </td>
                  <td className="cell-mono">v{t.version}</td>
                  <td className="cell-muted" style={{ fontSize: 12 }}>{new Date(t.updatedAt).toLocaleString()}</td>
                  <td onClick={(ev) => ev.stopPropagation()}>
                    <RowActions
                      size="sm"
                      stopPropagation
                      items={[
                        {
                          label: 'Open editor',
                          icon: 'Edit',
                          onClick: () => location.assign(`/templates/${t.id}`),
                        },
                        { divider: true },
                        {
                          label: 'Delete template',
                          icon: 'X',
                          danger: true,
                          disabled: !canEdit,
                          title: canEdit ? undefined : 'Manager or admin only',
                          onClick: () => void startDelete(t),
                        },
                      ]}
                    />
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
