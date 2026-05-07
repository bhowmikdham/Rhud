'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  describeError,
  integrations,
  proposalDraft,
  type CurrentProposalDraft,
  type OutlookConnectionStatus,
  type ProposalDraftResult,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

export function ProposalWorkspace({
  engagementId,
  engagementName,
  clientEmail,
  userRole,
  backHref,
}: {
  engagementId: string;
  engagementName: string;
  clientEmail: string;
  userRole: string;
  backHref: string;
}) {
  const confirm = useConfirm();
  const [current, setCurrent] = useState<CurrentProposalDraft | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const canSend =
    userRole === 'admin' || userRole === 'sales_manager' || userRole === 'sales_employee';

  const refresh = useCallback(async () => {
    try {
      const c = await proposalDraft.current(engagementId);
      setCurrent(c);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    if (current?.status !== 'drafting') return;
    const handle = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(handle);
  }, [current?.status, refresh]);

  useEffect(() => {
    if (!regenerating) return;
    if (current?.status === 'drafting' || current?.status === 'draft_ready') {
      setRegenerating(false);
    }
  }, [regenerating, current?.status]);

  async function generate() {
    if (busy) return;
    setBusy(true); setErr(null); setManualPrompt(null);
    try {
      const res: ProposalDraftResult = await proposalDraft.generate(engagementId);
      if (res.mode === 'manual') {
        setManualPrompt(res.prompt);
      } else {
        await refresh();
      }
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured')) {
        setErr('AI isn\'t configured. An admin needs to set it up in Settings → AI.');
      } else if (msg.includes('ai_provider_error')) {
        setErr(`Your AI provider returned an error: ${msg.replace(/^ai_provider_error:\s*/, '')}`);
      } else if (msg.includes('gamma_provider_error')) {
        setErr(`Gamma returned an error: ${msg.replace(/^gamma_provider_error:\s*/, '')}`);
      } else if (msg.includes('gamma_config_not_set') || msg.includes('gamma_api_key_missing')) {
        setErr('Gamma is selected as your drafter but isn\'t fully configured. An admin needs to add the API key in Connections.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  async function regenerate() {
    if (busy) return;
    const ok = await confirm({
      title: 'Regenerate proposal draft?',
      body: 'The current text will be replaced. The new draft is generated from scratch using the latest scope + price.',
      tone: 'warn',
      confirmLabel: 'Regenerate',
      icon: 'Sparkles',
    });
    if (!ok) return;
    setRegenerating(true);
    setBusy(true); setErr(null); setManualPrompt(null);
    try {
      await proposalDraft.clear(engagementId);
      await generate();
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
      setRegenerating(false);
    }
  }

  async function markSent() {
    if (busy) return;
    const ok = await confirm({
      title: 'Mark proposal as sent?',
      body: (
        <>
          Use this if you already emailed <b>{clientEmail}</b> the proposal yourself.
          Status moves to &ldquo;sent&rdquo;; we won&apos;t send anything from Rhud.
        </>
      ),
      confirmLabel: 'Mark as sent',
      icon: 'Send',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.markSent(engagementId);
      await refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const [showSend, setShowSend] = useState(false);
  // Top-bar PDF download — separate state from the SendModal's copy so
  // the user can grab the PDF without opening the send flow.
  const [downloading, setDownloading] = useState(false);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);

  async function downloadPdf() {
    if (downloading) return;
    setDownloading(true);
    setDownloadErr(null);
    try {
      const ok = await proposalDraft.downloadPdf(engagementId);
      if (!ok) {
        setDownloadErr('PDF unavailable — the Gamma export URL may have expired. Regenerate the proposal to refresh.');
      }
    } catch (e) {
      setDownloadErr(describeError(e));
    } finally {
      setDownloading(false);
    }
  }

  async function confirmSent() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.markSent(engagementId);
      await refresh();
      setSentTo(clientEmail);
      setTimeout(() => setSentTo(null), 6_000);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
      setShowSend(false);
    }
  }

  if (loading) {
    return (
      <div className="empty" style={{ padding: 60 }}><span className="spin" /></div>
    );
  }

  const draftedLabel = current?.draftedAt
    ? `Drafted ${relativeTime(current.draftedAt)}${current.source && current.source !== 'manual' ? ` · ${current.source}` : ''}${current.source === 'manual' ? ' · pasted from your AI' : ''}`
    : 'No draft yet';

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: -4 }}>
        <Link href={backHref} className="btn sm ghost">
          <Icon.ChevronLeft size={12} /> Back to opportunity
        </Link>
      </div>

      <div className="card" style={{ padding: 24 }}>
        <div style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 18,
          paddingBottom: 16,
          borderBottom: '1px solid var(--divider)',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', letterSpacing: '.06em', textTransform: 'uppercase', fontWeight: 600 }}>
              Proposal workspace
            </div>
            <div style={{ fontSize: 20, fontWeight: 600, marginTop: 4, color: 'var(--fg)' }}>
              {engagementName}
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <Icon.Mail size={11} />
              <span>{clientEmail}</span>
              <span style={{ color: 'var(--fg-subtle)' }}>·</span>
              <span>{draftedLabel}</span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
            {current?.proposalPdfAvailable && (
              <button
                type="button"
                className="btn sm"
                onClick={downloadPdf}
                disabled={downloading}
                title="Download the proposal PDF"
              >
                {downloading ? <span className="spin" /> : <><Icon.Download size={11} /> Download PDF</>}
              </button>
            )}
            <ProposalStatusChip status={current?.status ?? 'approved'} hasText={!!current?.text} />
          </div>
        </div>

        {downloadErr && (
          <div style={{
            padding: 12, fontSize: 13, marginBottom: 14,
            background: 'var(--danger-tint)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
            borderRadius: 8,
          }}>{downloadErr}</div>
        )}

        {err && (
          <div style={{
            padding: 12, fontSize: 13, marginBottom: 14,
            background: 'var(--danger-tint)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
            borderRadius: 8,
          }}>{err}</div>
        )}

        {sentTo && (
          <div style={{
            padding: 12, fontSize: 13, marginBottom: 14,
            background: 'var(--ok-tint)', color: 'var(--ok)',
            border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
            borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon.Check size={13} />
            <span>Sent to <b>{sentTo}</b>. They&apos;ll get an email with the proposal.</span>
          </div>
        )}

        <DraftBody
          kind={
            regenerating
              ? 'regenerating'
              : manualPrompt
                ? 'manual'
                : current?.status === 'drafting'
                  ? 'drafting'
                  : current?.text
                    ? 'ready'
                    : 'idle'
          }
        >
          {regenerating ? (
            <RegeneratingState source={current?.source ?? null} />
          ) : manualPrompt ? (
            <ManualDraftFlow
              prompt={manualPrompt}
              engagementId={engagementId}
              clientEmail={clientEmail}
              onAccepted={async () => {
                setManualPrompt(null);
                await refresh();
              }}
              onCancel={() => setManualPrompt(null)}
            />
          ) : current?.status === 'drafting' ? (
            <DraftingState source={current.source} phase={current.gammaPhase} elapsed={current.gammaElapsedSeconds} />
          ) : current?.text ? (
            current.source === 'gamma' && current.gammaDeckUrl ? (
              <GammaDeckRendered
                url={current.gammaDeckUrl}
                status={current.status}
                canSend={canSend}
                busy={busy}
                onRegenerate={regenerate}
                onSend={() => setShowSend(true)}
                onMarkSent={markSent}
              />
            ) : (
              <DraftRendered
                text={current.text}
                status={current.status}
                canSend={canSend}
                busy={busy}
                onRegenerate={regenerate}
                onSend={() => setShowSend(true)}
                onMarkSent={markSent}
              />
            )
          ) : (
            <div style={{
              padding: 32, borderRadius: 10,
              background: 'var(--bg-sunk)',
              display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start',
            }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Ready to draft the proposal</div>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55, maxWidth: 640 }}>
                Generate a client-ready proposal draft from this engagement&apos;s scope + approved price.
                For manual AI mode you&apos;ll get a prompt to paste into ChatGPT / Claude / Gemini.
              </p>
              <button onClick={generate} disabled={busy} className="btn accent">
                {busy ? <span className="spin" /> : <><Icon.Sparkles size={12} /> Generate draft</>}
              </button>
            </div>
          )}
        </DraftBody>
      </div>

      {showSend && current && (
        <SendModal
          engagementId={engagementId}
          clientEmail={clientEmail}
          source={current.source}
          deckUrl={current.gammaDeckUrl}
          text={current.text}
          pdfAvailable={current.proposalPdfAvailable}
          busy={busy}
          onConfirmSent={confirmSent}
          onClose={() => setShowSend(false)}
          onOutlookSent={async (sentFrom) => {
            await refresh();
            setSentTo(`${clientEmail} (from ${sentFrom})`);
            setTimeout(() => setSentTo(null), 6_000);
            setShowSend(false);
          }}
        />
      )}
    </div>
  );
}

function ProposalStatusChip({ status, hasText }: { status: string; hasText: boolean }) {
  if (status === 'sent') return <span className="chip ok"><Icon.Check size={10} /> Sent</span>;
  if (status === 'draft_ready' || hasText) return <span className="chip accent"><Icon.Sparkles size={10} /> Draft ready</span>;
  if (status === 'drafting') {
    return (
      <span className="chip warn">
        <span style={{ display: 'inline-flex', animation: 'spin 1.2s linear infinite' }}>
          <Icon.Clock size={10} />
        </span>
        Drafting
      </span>
    );
  }
  return (
    <span className="chip outline">
      <span style={{ display: 'inline-flex', animation: 'pulse 1.8s ease-in-out infinite' }}>
        <Icon.Sparkle size={10} />
      </span>
      Awaiting draft
    </span>
  );
}

function DraftBody({ kind, children }: { kind: string; children: React.ReactNode }) {
  return (
    <div
      key={kind}
      style={{
        animation: 'draftBodyFade .35s cubic-bezier(.22,.8,.3,1) both',
      }}
    >
      {children}
    </div>
  );
}

function RegeneratingState({ source }: { source: string | null }) {
  return (
    <div style={{
      padding: 24, borderRadius: 10,
      background: 'var(--accent-tint)',
      display: 'flex', alignItems: 'center', gap: 16,
      border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
    }}>
      <span style={{
        display: 'inline-flex',
        animation: 'spin 1s linear infinite',
        color: 'var(--accent)',
      }}>
        <Icon.Sparkles size={20} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>
          Regenerating proposal…
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 4 }}>
          {source === 'gamma'
            ? 'Telling Gamma to draft a fresh deck. This usually takes 30-90 seconds.'
            : 'Replacing the previous draft with a fresh one.'}
        </div>
      </div>
    </div>
  );
}

function DraftingState({
  source,
  phase,
  elapsed,
}: {
  source: string | null;
  phase: string | null;
  elapsed: number | null;
}) {
  return (
    <div style={{
      padding: 24, borderRadius: 10,
      background: 'var(--bg-sunk)',
      display: 'flex', alignItems: 'center', gap: 16,
    }}>
      <span style={{
        display: 'inline-flex',
        animation: 'spin 1.2s linear infinite',
        color: 'var(--accent)',
      }}>
        <Icon.Sparkles size={20} />
      </span>
      <div style={{ minWidth: 0, fontSize: 13.5, color: 'var(--fg-muted)' }}>
        {source === 'gamma' ? (
          <>
            <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
              {phase ? <>Gamma is {gammaPhaseLabel(phase)}…</> : <>Gamma is generating the deck…</>}
            </div>
            {elapsed != null && (
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
                {formatElapsed(elapsed)} elapsed · usually 30-90s
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>AI is drafting the proposal…</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Usually 10-30 seconds.</div>
          </>
        )}
      </div>
    </div>
  );
}

function DraftRendered({
  text, status, canSend, busy, onRegenerate, onSend, onMarkSent,
}: {
  text: string;
  status: string;
  canSend: boolean;
  busy: boolean;
  onRegenerate(): void;
  onSend(): void;
  onMarkSent(): void;
}) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <pre style={{
        margin: 0, padding: 28, background: 'var(--bg-sunk)', borderRadius: 10,
        fontFamily: 'inherit', fontSize: 14, lineHeight: 1.75,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        // Match the Gamma preview's vertical footprint so text + deck
        // drafts feel equally substantial.
        height: 'min(calc(100vh - 280px), 1100px)',
        minHeight: 600,
        overflow: 'auto',
        border: '1px solid var(--divider)',
      }}>{text}</pre>
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
        paddingTop: 14, borderTop: '1px solid var(--divider)',
      }}>
        <button onClick={copy} className="btn sm">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy proposal</>}
        </button>
        {status !== 'sent' && (
          <button onClick={onRegenerate} disabled={busy} className="btn sm ghost">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
          </button>
        )}
        {status !== 'sent' && canSend && (
          <>
            <button onClick={onSend} disabled={busy} className="btn sm accent" style={{ marginLeft: 'auto' }}>
              <Icon.Send size={11} /> Send to client
            </button>
            <button
              onClick={onMarkSent}
              disabled={busy}
              className="btn sm ghost"
              title="Already emailed it yourself? Just flip the status."
            >
              Mark as sent
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Convert a Gamma viewer URL into an iframe-safe embed URL. Gamma sends
 * X-Frame-Options: DENY on the canonical viewer URL; the embed variant
 * at gamma.app/embed/{slug} is framing-safe.
 */
function gammaEmbedUrl(viewerUrl: string): string {
  try {
    const u = new URL(viewerUrl);
    if (u.hostname !== 'gamma.app') return viewerUrl;
    if (u.pathname.startsWith('/embed/')) return viewerUrl;
    const last = u.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!last) return viewerUrl;
    const slug = last.includes('-') ? last.split('-').pop()! : last;
    return `https://gamma.app/embed/${slug}`;
  } catch {
    return viewerUrl;
  }
}

function GammaDeckRendered({
  url, status, canSend, busy, onRegenerate, onSend, onMarkSent,
}: {
  url: string;
  status: string;
  canSend: boolean;
  busy: boolean;
  onRegenerate(): void;
  onSend(): void;
  onMarkSent(): void;
}) {
  const [copied, setCopied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const embedUrl = gammaEmbedUrl(url);
  const embedSrc =
    refreshKey === 0
      ? embedUrl
      : `${embedUrl}${embedUrl.includes('?') ? '&' : '?'}_=${refreshKey}`;

  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible') {
        setRefreshKey((k) => k + 1);
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  function copyLink() {
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  function refreshDeck() {
    setRefreshKey((k) => k + 1);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        position: 'relative',
        background: 'var(--bg-sunk)',
        borderRadius: 10,
        border: '1px solid var(--divider)',
        overflow: 'hidden',
        // Fill most of the viewport so the rep doesn't have to nav-scroll
        // Gamma's internal pager just to see the next slide. Floor at 600px
        // for short screens; the calc() lets long screens breathe.
        height: 'min(calc(100vh - 280px), 1100px)',
        minHeight: 600,
      }}>
        <iframe
          key={refreshKey}
          src={embedSrc}
          title="Proposal deck preview"
          loading="lazy"
          allow="fullscreen"
          style={{
            position: 'absolute', inset: 0,
            width: '100%', height: '100%',
            border: 0,
            background: 'var(--bg-sunk)',
          }}
        />
      </div>
      <div style={{
        display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center',
        paddingTop: 14, borderTop: '1px solid var(--divider)',
      }}>
        <a href={url} target="_blank" rel="noopener noreferrer" className="btn sm">
          <Icon.ArrowUpRight size={11} /> Open in Gamma
        </a>
        <button onClick={copyLink} className="btn sm ghost">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy link</>}
        </button>
        <button
          onClick={refreshDeck}
          className="btn sm ghost"
          title="Reload the embed to pull the latest edits from Gamma"
        >
          <Icon.Refresh size={11} /> Refresh
        </button>
        {status !== 'sent' && (
          <button onClick={onRegenerate} disabled={busy} className="btn sm ghost">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
          </button>
        )}
        {status !== 'sent' && canSend && (
          <>
            <button onClick={onSend} disabled={busy} className="btn sm accent" style={{ marginLeft: 'auto' }}>
              <Icon.Send size={11} /> Send to client
            </button>
            <button
              onClick={onMarkSent}
              disabled={busy}
              className="btn sm ghost"
              title="Already emailed it yourself? Just flip the status."
            >
              Mark as sent
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function gammaPhaseLabel(phase: string): string {
  switch (phase.toLowerCase()) {
    case 'queued':       return 'queued';
    case 'pending':      return 'queued';
    case 'processing':   return 'generating cards';
    case 'in_progress':  return 'generating cards';
    case 'completed':    return 'finishing up';
    case 'failed':       return 'failed';
    default:             return phase;
  }
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function ManualDraftFlow({
  prompt, engagementId, clientEmail, onAccepted, onCancel,
}: {
  prompt: string;
  engagementId: string;
  clientEmail: string;
  onAccepted(): Promise<void>;
  onCancel(): void;
}) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function copyAndOpen(url: string | null) {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (url) window.open(url, '_blank', 'noopener');
  }

  async function accept() {
    if (!pasted.trim()) return;
    setBusy(true); setErr(null);
    try {
      await proposalDraft.acceptManual(engagementId, pasted);
      await onAccepted();
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        padding: '12px 14px', background: 'var(--accent-tint)',
        borderRadius: 8, fontSize: 13,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          <Icon.Sparkles size={11} /> Manual mode — proposal for <b>{clientEmail}</b>
        </div>
        <div style={{ color: 'var(--fg-muted)' }}>
          Copy the prompt to your AI of choice, paste back the response below. We&apos;ll persist it as the proposal draft.
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={() => copyAndOpen('https://chat.openai.com/')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open ChatGPT <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://claude.ai/new')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Claude <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen('https://gemini.google.com/app')} className="btn sm">
          <Icon.Copy size={11} /> Copy &amp; open Gemini <Icon.ArrowUpRight size={10} />
        </button>
        <button onClick={() => copyAndOpen(null)} className="btn sm ghost">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy</>}
        </button>
      </div>
      <details style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Preview the prompt</summary>
        <pre style={{
          marginTop: 6, padding: 12, background: 'var(--bg-sunk)', borderRadius: 6,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 320, overflow: 'auto',
        }}>{prompt}</pre>
      </details>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 12.5, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Paste the AI&apos;s proposal here
        </span>
        <textarea
          className="input"
          rows={14}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste the full proposal markdown the AI gave you…"
          style={{ fontSize: 13, lineHeight: 1.55, padding: 12 }}
          disabled={busy}
        />
      </label>
      {err && (
        <div style={{
          padding: 12, fontSize: 13,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}
      <div style={{
        display: 'flex', justifyContent: 'space-between', gap: 8,
        paddingTop: 14, borderTop: '1px solid var(--divider)',
      }}>
        <button onClick={onCancel} disabled={busy} className="btn sm ghost">Cancel</button>
        <button onClick={accept} disabled={busy || !pasted.trim()} className="btn sm accent">
          {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save as draft</>}
        </button>
      </div>
    </div>
  );
}

function SendModal({
  engagementId,
  clientEmail,
  source,
  deckUrl,
  text,
  pdfAvailable,
  busy,
  onConfirmSent,
  onClose,
  onOutlookSent,
}: {
  engagementId: string;
  clientEmail: string;
  source: string | null;
  deckUrl: string | null;
  text: string | null;
  pdfAvailable: boolean;
  busy: boolean;
  onConfirmSent(): void;
  onClose(): void;
  onOutlookSent(sentFrom: string): void;
}) {
  const isGamma = source === 'gamma' && !!deckUrl;
  const clientName = nameFromEmail(clientEmail);
  const defaultSubject = 'Your proposal';
  const defaultBody =
    `Hi ${clientName},\n\n` +
    `Thanks for the time you spent on the scope. Please find the proposal attached` +
    (isGamma ? ' (PDF) — you can also view it online here:\n' + deckUrl : '') +
    (!isGamma && text ? '. Full text below.\n\n──────────────────\n' + text : '') +
    `\n\nLet me know what you think — happy to jump on a call to walk through it.\n\n` +
    `Best,`;

  const [subject, setSubject] = useState(defaultSubject);
  const [body, setBody] = useState(defaultBody);
  const [downloaded, setDownloaded] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [outlook, setOutlook] = useState<OutlookConnectionStatus | null>(null);
  const [sending, setSending] = useState(false);
  const [sendErr, setSendErr] = useState<string | null>(null);

  useEffect(() => {
    integrations.outlook.status().then(setOutlook).catch(() => setOutlook(null));
  }, []);

  const mailtoHref =
    'mailto:' +
    encodeURIComponent(clientEmail) +
    '?subject=' +
    encodeURIComponent(subject) +
    '&body=' +
    encodeURIComponent(body);

  async function sendViaOutlook() {
    if (sending) return;
    setSending(true); setSendErr(null);
    try {
      const res = await proposalDraft.sendViaOutlook(engagementId, { subject, body });
      onOutlookSent(res.sentFrom);
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('outlook_reconnect_required')) {
        setSendErr('Your Outlook session expired. Reconnect Outlook in Settings → Connections, then try again.');
      } else if (msg.includes('outlook_not_connected')) {
        setSendErr('Outlook isn\'t connected for your account. Connect it in Settings → Connections first.');
      } else if (msg.includes('outlook_not_configured')) {
        setSendErr('Outlook isn\'t configured for this workspace. Ask an admin to set up the integration.');
      } else if (msg.includes('outlook_send_failed')) {
        setSendErr(`Outlook returned an error: ${msg.replace(/^outlook_send_failed:\s*/, '')}`);
      } else {
        setSendErr(msg);
      }
    } finally {
      setSending(false);
    }
  }

  const outlookReady = outlook?.connected && outlook.available;
  const outlookUnavailable = outlook && !outlook.available;

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div
          className="card"
          style={{ width: '100%', maxWidth: 620, background: 'var(--bg)', maxHeight: '92vh', overflow: 'auto' }}
        >
          <header style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon.Send size={13} /> Send proposal to client
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
                {outlookReady ? (
                  <>Sends from <b>{outlook?.accountEmail}</b> via your connected Outlook account, with the PDF attached.</>
                ) : outlookUnavailable ? (
                  <>Edit, download the PDF, click <i>Open in mail app</i>, attach manually. (Outlook one-click send isn&apos;t configured on this server.)</>
                ) : (
                  <>Edit, download the PDF, click <i>Open in mail app</i>, attach manually. <a href="/integrations" style={{ color: 'var(--accent)' }}>Connect Outlook</a> to skip the manual attach.</>
                )}
              </div>
            </div>
            <button onClick={onClose} disabled={busy || sending} className="btn sm ghost"><Icon.X size={11} /></button>
          </header>

          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Field label="To">
              <input className="input" value={clientEmail} disabled style={{ height: 32, fontSize: 13, padding: '0 10px' }} />
            </Field>
            <Field label="Subject">
              <input
                className="input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ height: 32, fontSize: 13, padding: '0 10px' }}
              />
            </Field>
            <Field label="Body">
              <textarea
                className="input mono"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                style={{ width: '100%', fontSize: 12.5, lineHeight: 1.55, padding: 10 }}
              />
            </Field>

            {pdfAvailable ? (
              <div style={{
                padding: 12, borderRadius: 8,
                background: 'var(--accent-tint)',
                border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <span style={{
                  width: 36, height: 36, borderRadius: 8,
                  background: 'var(--accent)', color: 'white',
                  display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 700,
                  flexShrink: 0,
                }}>PDF</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>Proposal.pdf</div>
                  <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                    Download → attach in your mail client.
                    {downloaded && <span style={{ color: 'var(--ok)', marginLeft: 6 }}>✓ Downloaded</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn sm accent"
                  disabled={downloading}
                  onClick={async () => {
                    setDownloading(true);
                    setSendErr(null);
                    const ok = await proposalDraft.downloadPdf(engagementId);
                    setDownloading(false);
                    if (ok) {
                      setDownloaded(true);
                    } else {
                      setSendErr('PDF unavailable — the Gamma export URL may have expired. Regenerate the proposal to refresh.');
                    }
                  }}
                >
                  {downloading ? <span className="spin" /> : <><Icon.Download size={11} /> Download PDF</>}
                </button>
              </div>
            ) : (
              <div style={{
                padding: 10, fontSize: 11.5, color: 'var(--fg-muted)',
                background: 'var(--bg-sunk)', borderRadius: 8, lineHeight: 1.5,
              }}>
                <Icon.FileText size={11} style={{ marginRight: 4 }} />
                {isGamma
                  ? 'PDF link expired (Gamma exports lapse after ~7 days). Regenerate the proposal to refresh, or send the deck link inline.'
                  : 'Text proposals don\'t carry a PDF in this phase — the body above contains the full text.'}
              </div>
            )}
          </div>

          {sendErr && (
            <div style={{
              margin: '0 18px 12px', padding: 10, fontSize: 12.5,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{sendErr}</div>
          )}

          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
          }}>
            <button onClick={onClose} disabled={busy || sending} className="btn sm ghost">Cancel</button>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {outlookReady ? (
                <>
                  <a href={mailtoHref} className="btn sm ghost" onClick={(e) => { if (sending) e.preventDefault(); }}>
                    <Icon.Mail size={11} /> Open in mail app
                  </a>
                  <button onClick={onConfirmSent} disabled={busy || sending} className="btn sm ghost">
                    Mark as sent
                  </button>
                  <button onClick={sendViaOutlook} disabled={sending} className="btn sm accent">
                    {sending ? <span className="spin" /> : <><Icon.Send size={11} /> Send via Outlook</>}
                  </button>
                </>
              ) : (
                <>
                  <a
                    href={mailtoHref}
                    className="btn sm"
                    onClick={(e) => { if (busy) e.preventDefault(); }}
                  >
                    <Icon.Mail size={11} /> Open in mail app
                  </a>
                  <button
                    onClick={onConfirmSent}
                    disabled={busy}
                    className="btn sm accent"
                    title="Click after you've sent the email from your mail client"
                  >
                    {busy ? <span className="spin" /> : <><Icon.Check size={11} /> I&apos;ve sent it</>}
                  </button>
                </>
              )}
            </div>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>{label}</span>
      {children}
    </label>
  );
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  if (local.length < 2) return email;
  const tokens = local.split(/[._+-]+/).filter(Boolean)
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
  return tokens.length > 0 ? tokens.join(' ') : email;
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
