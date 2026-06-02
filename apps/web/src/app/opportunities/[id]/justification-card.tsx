'use client';

import { useState } from 'react';
import { describeError, justification, type JustificationResult } from '@/lib/api';
import { Icon } from '@/components/icon';

// ── Justification card (LLM-driven quote rationale + draft email) ───────────

export function JustificationCard({ engagementId, clientEmail }: { engagementId: string; clientEmail: string }) {
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function generate() {
    setBusy(true); setErr(null); setText(null); setManualPrompt(null);
    try {
      const res: JustificationResult = await justification.generate(engagementId);
      if (res.mode === 'manual') setManualPrompt(res.prompt);
      else setText(res.text);
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured')) {
        setErr('AI isn\'t configured for this workspace yet. An admin needs to set it up in Settings → AI.');
      } else if (msg.includes('ai_provider_error')) {
        // Strip the prefix our backend adds so the user sees the actual
        // upstream message ("Incorrect API key", "model not found", etc.).
        setErr(`Your AI provider returned an error: ${msg.replace(/^ai_provider_error:\s*/, '')}`);
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 10 }}>
        <div className="section-label">Justification &amp; draft email</div>
        {!text && !manualPrompt && (
          <button onClick={generate} disabled={busy} className="btn sm accent">
            {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Generate</>}
          </button>
        )}
      </div>

      {!text && !manualPrompt && !err && (
        <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13, lineHeight: 1.55 }}>
          Have an AI write a short business rationale + draft sales email for this quote. You&apos;ll
          be able to copy it straight into your email client.
        </p>
      )}

      {err && (
        <div style={{
          padding: 10, fontSize: 12.5,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}

      {text && (
        <JustificationResultView
          text={text}
          onRegenerate={generate}
          regenBusy={busy}
        />
      )}

      {manualPrompt && (
        <ManualJustificationFlow
          prompt={manualPrompt}
          engagementId={engagementId}
          clientEmail={clientEmail}
          onAccepted={(t) => { setManualPrompt(null); setText(t); }}
          onCancel={() => setManualPrompt(null)}
        />
      )}
    </div>
  );
}

function JustificationResultView({
  text, onRegenerate, regenBusy,
}: { text: string; onRegenerate(): void; regenBusy: boolean }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <pre style={{
        margin: 0, padding: 14, background: 'var(--bg-sunk)', borderRadius: 8,
        fontFamily: 'inherit', fontSize: 13, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      }}>{text}</pre>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={copy} className="btn sm">
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
        </button>
        <button onClick={onRegenerate} disabled={regenBusy} className="btn sm ghost">
          {regenBusy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Regenerate</>}
        </button>
      </div>
    </div>
  );
}

function ManualJustificationFlow({
  prompt, engagementId, clientEmail, onAccepted, onCancel,
}: {
  prompt: string;
  engagementId: string;
  clientEmail: string;
  onAccepted(text: string): void;
  onCancel(): void;
}) {
  const [pasted, setPasted] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  function copyAndOpen(url: string | null) {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (url) window.open(url, '_blank', 'noopener');
  }

  async function accept() {
    if (!pasted.trim()) return;
    setBusy(true);
    try {
      const res = await justification.acceptManual(engagementId, pasted);
      onAccepted(res.text);
    } catch {
      onAccepted(pasted.trim());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{
        padding: '10px 12px', background: 'var(--accent-tint)',
        borderRadius: 8, fontSize: 12.5, color: 'var(--fg)',
      }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          <Icon.Sparkles size={11} /> Manual mode — use any AI you already have
        </div>
        <div style={{ color: 'var(--fg-muted)' }}>
          For <b>{clientEmail}</b>. Click a button below to copy the prompt and open the AI in a new tab.
          Paste the prompt, get the response, then paste it back here.
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy the prompt</>}
        </button>
      </div>

      <details style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Preview the prompt</summary>
        <pre style={{
          marginTop: 6, padding: 12, background: 'var(--bg-sunk)', borderRadius: 8,
          fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5,
          whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 240, overflow: 'auto',
        }}>{prompt}</pre>
      </details>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Paste the AI&apos;s response here
        </span>
        <textarea
          className="input"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder="Paste what the AI gave you…"
          rows={6}
          style={{ fontSize: 13, lineHeight: 1.5, padding: 10 }}
        />
      </label>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button onClick={onCancel} className="btn sm ghost" disabled={busy}>Cancel</button>
        <button onClick={accept} disabled={busy || !pasted.trim()} className="btn sm accent">
          {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Use this</>}
        </button>
      </div>
    </div>
  );
}


