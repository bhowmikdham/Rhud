'use client';

/**
 * IssueLinkModal — mint a gathering link against an existing opportunity.
 *
 * Two callers (Sprint 1):
 *   - "Send scoping questions" card on the opportunity detail page.
 *     For direct-ingest opportunities this is the *first* link
 *     (engagement.templateId currently null → attaches a template +
 *     mints in one call). For link-share opportunities this is a
 *     re-issue (same template, fresh token; emits link_reissued).
 *
 * Wraps POST /opportunities/:id/links (apps/api/src/engagements/
 * engagements.controller.ts).
 *
 * See docs/direct-ingest.md §4.2 + §7.2.
 */

import { useEffect, useMemo, useState } from 'react';
import { describeError, opportunities, templates, type IssuedLink, type Template } from '@/lib/api';
import { Icon } from './icon';

const TTL_OPTIONS: Array<{ key: string; label: string; days: number; hint?: string }> = [
  { key: '24h', label: '24 hours', days: 1,  hint: 'Same-day turn-around' },
  { key: '7d',  label: '7 days',   days: 7,  hint: 'Recommended' },
  { key: '14d', label: '14 days',  days: 14 },
  { key: '30d', label: '30 days',  days: 30, hint: 'Long-form RFPs' },
];

interface Props {
  engagementId: string;
  /** When the engagement already has a template attached (link-share
   *  opportunity re-scoping), pass it here so the picker pre-selects.
   *  For direct-ingest the field is null; the rep picks fresh. */
  currentTemplateId: string | null;
  /** True when this is a re-issue (engagement already has token(s)).
   *  The modal copy adjusts: "Re-issue scoping link" + a re-scope
   *  reason prompt. */
  isReissue: boolean;
  onIssued(link: IssuedLink): void;
  onClose(): void;
}

export function IssueLinkModal({
  engagementId,
  currentTemplateId,
  isReissue,
  onIssued,
  onClose,
}: Props) {
  const [list, setList] = useState<Template[] | null>(null);
  const [templateId, setTemplateId] = useState(currentTemplateId ?? '');
  const [ttlKey, setTtlKey] = useState<string>('7d');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    templates
      .list()
      .then((all) => {
        const published = all.filter((t) => t.status === 'published');
        setList(published);
        // Pre-select: current template if set, else first published.
        if (!templateId) {
          if (currentTemplateId) setTemplateId(currentTemplateId);
          else if (published[0]) setTemplateId(published[0].id);
        }
      })
      .catch((e) => setErr(describeError(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When re-issuing on an existing link-share opportunity, the API
  // refuses to switch templates. Lock the picker to a visual hint.
  const templateLocked = isReissue && !!currentTemplateId;

  const selectedTtl = useMemo(
    () =>
      TTL_OPTIONS.find((t) => t.key === ttlKey) ??
      (TTL_OPTIONS[1] as (typeof TTL_OPTIONS)[number]),
    [ttlKey],
  );

  async function submit() {
    setErr(null);
    setBusy(true);
    try {
      const link = await opportunities.issueLink(engagementId, {
        templateId,
        expiresInDays: selectedTtl.days,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      onIssued(link);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.4)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div
        className="card"
        style={{ maxWidth: 560, width: '100%', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid var(--divider)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {isReissue ? 'Re-issue scoping link' : 'Send scoping questions to client'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
              {isReissue
                ? 'Mints a fresh token against the same template. The previous link can stay live or be revoked separately.'
                : 'Pick a template and how long the link stays active. The client opens it in any browser — no account needed.'}
            </div>
          </div>
          <button className="btn ghost sm" onClick={onClose}>
            <Icon.X size={12} />
          </button>
        </div>

        <div style={{ padding: 20, display: 'grid', gap: 16 }}>
          {err && (
            <div
              style={{
                padding: '10px 12px',
                background: 'var(--danger-tint)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                borderRadius: 8,
                color: 'var(--danger)',
                fontSize: 12.5,
              }}
            >
              {err}
            </div>
          )}

          <div>
            <div
              style={{
                fontSize: 12.5,
                fontWeight: 500,
                marginBottom: 6,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Template
              {templateLocked && (
                <span className="chip" style={{ fontSize: 10 }}>
                  <Icon.Lock size={9} /> Locked to current
                </span>
              )}
            </div>
            {list === null ? (
              <div className="empty" style={{ padding: 16 }}>
                <span className="spin" />
              </div>
            ) : list.length === 0 ? (
              <div
                style={{
                  padding: '12px 14px',
                  background: 'var(--warn-tint)',
                  border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
                  borderRadius: 8,
                  fontSize: 12.5,
                }}
              >
                No published templates. Create one in <b>Templates</b> first.
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                {list.map((t) => {
                  const selected = templateId === t.id;
                  const disabled = templateLocked && t.id !== currentTemplateId;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      disabled={disabled}
                      onClick={() => setTemplateId(t.id)}
                      style={{
                        appearance: 'none',
                        cursor: disabled ? 'not-allowed' : 'pointer',
                        textAlign: 'left',
                        padding: '10px 12px',
                        borderRadius: 8,
                        background: selected ? 'var(--accent-tint)' : 'var(--bg)',
                        border:
                          '1px solid ' +
                          (selected ? 'var(--accent)' : 'var(--border)'),
                        opacity: disabled ? 0.4 : 1,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                      }}
                    >
                      <span
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: 999,
                          border:
                            '2px solid ' +
                            (selected ? 'var(--accent)' : 'var(--border-strong)'),
                          background: selected ? 'var(--accent)' : 'transparent',
                          display: 'grid',
                          placeItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        {selected && <Icon.Check size={9} style={{ color: 'var(--bg)' }} />}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: 'var(--fg-muted)',
                            marginTop: 2,
                          }}
                        >
                          {t.serviceLine} · v{t.version}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>Link expiry</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {TTL_OPTIONS.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTtlKey(opt.key)}
                  style={{
                    appearance: 'none',
                    cursor: 'pointer',
                    padding: '8px 10px',
                    borderRadius: 8,
                    background: ttlKey === opt.key ? 'var(--accent-tint)' : 'var(--bg)',
                    border:
                      '1px solid ' +
                      (ttlKey === opt.key ? 'var(--accent)' : 'var(--border)'),
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{opt.label}</div>
                  {opt.hint && (
                    <div style={{ fontSize: 10.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {opt.hint}
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {isReissue && (
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
                Why re-issue? <span style={{ color: 'var(--fg-subtle)' }}>(optional)</span>
              </div>
              <textarea
                className="input"
                rows={2}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Client asked for clarification on access scope…"
                style={{ resize: 'vertical', minHeight: 56 }}
                maxLength={500}
              />
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--fg-subtle)',
                  marginTop: 4,
                }}
              >
                Audit-only — shown in the opportunity timeline, not to the client.
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--divider)',
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn accent"
            onClick={submit}
            disabled={busy || !templateId || (list?.length ?? 0) === 0}
          >
            {busy ? <span className="spin" /> : <Icon.Zap size={12} />}
            {busy ? 'Issuing…' : isReissue ? 'Re-issue link' : 'Issue link'}
          </button>
        </div>
      </div>
    </div>
  );
}
