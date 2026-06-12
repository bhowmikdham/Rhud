'use client';

/**
 * Settings → Gamma "Templates" tab. Lists the tenant's curated library of
 * reusable Gamma decks (GammaTemplate). Admin + sales_manager can add,
 * edit, set-default, test, and archive entries (gated on `canManage`);
 * everyone else gets a read-only view.
 *
 * The export name `GammaTemplatesPanel` is consumed by the Settings page
 * that hosts the tab — keep it stable.
 */

import { useCallback, useEffect, useState } from 'react';
import { gammaTemplates, describeError } from '@/lib/api';
import type { GammaTemplate } from '@/lib/api';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';
import { ResultLine } from './gamma-ui';
import { GammaTemplateForm } from './gamma-template-form';

type TestState = { ok: boolean; message: string };

export function GammaTemplatesPanel({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();

  const [entries, setEntries] = useState<GammaTemplate[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // null = closed; { entry: undefined } = add; { entry } = edit.
  const [editing, setEditing] = useState<{ entry: GammaTemplate | null } | null>(null);

  // Per-row transient state: which row has a mutation in flight + its
  // last inline test result.
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<{ id: string; message: string } | null>(null);
  const [testResults, setTestResults] = useState<Record<string, TestState>>({});

  const load = useCallback(() => {
    setLoadErr(null);
    gammaTemplates
      .list()
      .then(setEntries)
      .catch((e) => {
        setLoadErr(describeError(e));
        setEntries([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function setDefault(t: GammaTemplate) {
    if (busyId) return;
    setBusyId(t.id);
    setRowErr(null);
    try {
      await gammaTemplates.update(t.id, { isDefault: true });
      load();
    } catch (e) {
      setRowErr({ id: t.id, message: describeError(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function test(t: GammaTemplate) {
    if (busyId) return;
    setBusyId(t.id);
    setRowErr(null);
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[t.id];
      return next;
    });
    try {
      const r = await gammaTemplates.test(t.id);
      setTestResults((prev) => ({
        ...prev,
        [t.id]: {
          ok: r.ok,
          message: r.ok
            ? 'Gamma connection is authenticated and reachable.'
            : (r.error ?? 'Unknown error'),
        },
      }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [t.id]: { ok: false, message: describeError(e) } }));
    } finally {
      setBusyId(null);
    }
  }

  async function archive(t: GammaTemplate) {
    if (busyId) return;
    const ok = await confirm({
      title: 'Archive this template?',
      body: (
        <>
          <strong>{t.label}</strong> will no longer appear in the proposal
          template picker. Existing proposals already generated from it are
          unaffected. You can re-add it later by its File ID.
        </>
      ),
      tone: 'warn',
      confirmLabel: 'Archive',
    });
    if (!ok) return;
    setBusyId(t.id);
    setRowErr(null);
    try {
      await gammaTemplates.archive(t.id);
      load();
    } catch (e) {
      setRowErr({ id: t.id, message: describeError(e) });
    } finally {
      setBusyId(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────

  // Loading skeleton — fixed height so the panel doesn't jump when the
  // list resolves.
  if (entries === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {[0, 1].map((i) => (
          <div
            key={i}
            aria-hidden
            style={{
              height: 56,
              borderRadius: 10,
              border: '1px solid var(--border)',
              background: 'var(--bg-sunk)',
              opacity: 0.6,
            }}
          />
        ))}
        <span
          className="spin"
          style={{ alignSelf: 'center', marginTop: 4 }}
          aria-label="Loading templates"
        />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header row with the add action (manage-gated). */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
          Reusable Gamma decks. New proposals clone the resolved template&apos;s layout.
        </div>
        {canManage && entries.length > 0 && (
          <button
            type="button"
            className="btn sm"
            onClick={() => setEditing({ entry: null })}
          >
            <Icon.Plus size={12} /> Add template
          </button>
        )}
      </div>

      {loadErr && <ResultLine ok={false}>{loadErr}</ResultLine>}

      {entries.length === 0 ? (
        <div className="empty" style={{ padding: '32px 24px' }}>
          <div style={{ fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.6, maxWidth: 360, margin: '0 auto' }}>
            No proposal templates yet — add a Gamma deck to reuse its layout for
            proposals.
          </div>
          {canManage ? (
            <button
              type="button"
              className="btn sm accent"
              onClick={() => setEditing({ entry: null })}
              style={{ marginTop: 14 }}
            >
              <Icon.Plus size={12} /> Add template
            </button>
          ) : (
            <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 10 }}>
              Ask an admin or sales manager to add one.
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {entries.map((t) => {
            const rowBusy = busyId === t.id;
            const tr = testResults[t.id];
            const err = rowErr?.id === t.id ? rowErr.message : null;
            return (
              <div
                key={t.id}
                className="card"
                style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
                  <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13.5 }}>{t.label}</strong>
                      {t.isDefault && <span className="chip ok">Default</span>}
                      {t.serviceLine && <span className="chip outline">{t.serviceLine}</span>}
                      {t.status === 'archived' && <span className="chip warn">Archived</span>}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span>{t.format === 'document' ? 'Document' : 'Presentation'}</span>
                      <span aria-hidden>·</span>
                      <span
                        style={{ fontFamily: 'var(--font-mono, monospace)' }}
                        title={t.gammaTemplateId}
                      >
                        {t.gammaTemplateId}
                      </span>
                    </div>
                  </div>

                  {canManage && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                      {rowBusy && <span className="spin" aria-label="Working" />}
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => setEditing({ entry: t })}
                        disabled={rowBusy}
                        title="Edit template"
                      >
                        <Icon.Edit size={12} /> Edit
                      </button>
                      {!t.isDefault && t.status !== 'archived' && (
                        <button
                          type="button"
                          className="btn sm ghost"
                          onClick={() => setDefault(t)}
                          disabled={rowBusy}
                          title="Make this the default for new proposals"
                        >
                          <Icon.Check size={12} /> Set default
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => test(t)}
                        disabled={rowBusy}
                        title="Test the Gamma connection"
                      >
                        <Icon.Zap size={12} /> Test
                      </button>
                      {t.status !== 'archived' && (
                        <button
                          type="button"
                          className="btn sm ghost danger"
                          onClick={() => archive(t)}
                          disabled={rowBusy}
                          title="Archive template"
                        >
                          <Icon.X size={12} /> Archive
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {tr && (
                  <ResultLine ok={tr.ok}>
                    <b>{tr.ok ? 'Connection OK. ' : 'Connection failed. '}</b>
                    {tr.message}
                  </ResultLine>
                )}
                {err && <ResultLine ok={false}>{err}</ResultLine>}
              </div>
            );
          })}
        </div>
      )}

      {/* Add / edit form, inline below the list. */}
      {editing && (
        <div
          className="card"
          style={{ padding: 16, marginTop: 4, borderColor: 'var(--accent)' }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>
            {editing.entry ? 'Edit template' : 'Add template'}
          </div>
          <GammaTemplateForm
            entry={editing.entry}
            onSaved={() => {
              setEditing(null);
              load();
            }}
            onClose={() => setEditing(null)}
          />
        </div>
      )}
    </div>
  );
}
