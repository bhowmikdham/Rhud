'use client';

/**
 * AI-assist modal for generating a template from a plain-English
 * description of what the consultancy sells. Three stages:
 *
 *   describe → preview → (caller calls onCreate)
 *
 * Manual mode adds a middle "paste back" stage between describe and
 * preview. Auto mode skips it.
 *
 * The actual template + node creation happens in the parent (TemplatesList)
 * — this component just produces a clean nodes[] payload via `onCreate`.
 */

import { useEffect, useRef, useState } from 'react';
import {
  templateGen,
  describeError,
  type GeneratedTemplateNode,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

interface Props {
  onClose(): void;
  onCreate(args: { name: string; serviceLine: string; nodes: GeneratedTemplateNode[] }): Promise<void>;
}

type Stage =
  | { kind: 'describe' }
  | { kind: 'manual'; prompt: string }
  | { kind: 'preview'; nodes: GeneratedTemplateNode[] };

export function AiAssistModal({ onClose, onCreate }: Props) {
  const [stage, setStage] = useState<Stage>({ kind: 'describe' });
  const [description, setDescription] = useState('');
  const [serviceLine, setServiceLine] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  // Re-entrancy guard: while a close (and its discard confirm) is in flight,
  // ignore further close requests. Without this, pressing Escape to cancel
  // the discard confirm also re-fires the modal's own document-level Escape
  // listener, popping a second confirm.
  const closing = useRef(false);

  // Closing from the preview stage throws away the generated nodes, so
  // confirm first. The describe/manual stages have nothing worth saving.
  async function discardPreview(): Promise<boolean> {
    if (stage.kind !== 'preview') return true;
    return confirm({
      title: 'Discard generated questions?',
      body: 'These haven\'t been saved as a template yet — they\'ll be lost.',
      confirmLabel: 'Discard',
      tone: 'danger',
    });
  }

  async function requestClose() {
    if (busy || closing.current) return;
    closing.current = true;
    try {
      if (await discardPreview()) onClose();
    } finally {
      closing.current = false;
    }
  }

  // Move focus into the dialog when it opens (and re-focus the first field
  // of each new stage) so keyboard + screen-reader users land inside it.
  useEffect(() => {
    const focusTarget =
      dialogRef.current?.querySelector<HTMLElement>('textarea, input, button') ?? dialogRef.current;
    focusTarget?.focus();
  }, [stage.kind]);

  // Escape closes, respecting the busy guard and the preview discard confirm
  // (so unsaved generated nodes aren't dropped without warning).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.stopPropagation(); void requestClose(); }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, busy]);

  async function generate() {
    if (!description.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await templateGen.generate(description, serviceLine || undefined);
      if (res.mode === 'manual') setStage({ kind: 'manual', prompt: res.prompt });
      else setStage({ kind: 'preview', nodes: res.nodes });
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured') || msg.includes('503')) {
        setErr('AI isn\'t configured for this workspace. An admin needs to set it up in Settings → AI.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Portal>
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) void requestClose(); }}
    >
      <div
        ref={dialogRef}
        className="card"
        role="dialog"
        aria-modal="true"
        aria-label="Generate template with AI"
        tabIndex={-1}
        style={{
          width: '100%', maxWidth: 720, maxHeight: '92vh',
          display: 'flex', flexDirection: 'column', background: 'var(--bg)',
        }}
      >
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon.Sparkles size={13} /> Generate template with AI
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Describe what you sell — we&apos;ll draft a starter scope-gathering questionnaire.
            </div>
          </div>
          <button onClick={() => void requestClose()} disabled={busy} className="btn sm ghost"><Icon.X size={11} /></button>
        </header>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          {stage.kind === 'describe' && (
            <DescribeStage
              description={description}
              setDescription={setDescription}
              serviceLine={serviceLine}
              setServiceLine={setServiceLine}
            />
          )}
          {stage.kind === 'manual' && (
            <ManualStage
              prompt={stage.prompt}
              onParsed={(nodes) => setStage({ kind: 'preview', nodes })}
              onBack={() => setStage({ kind: 'describe' })}
            />
          )}
          {stage.kind === 'preview' && (
            <PreviewStage
              nodes={stage.nodes}
              defaultName={defaultNameFromDescription(description)}
              defaultServiceLine={serviceLine || serviceLineFromDescription(description)}
              onCreate={onCreate}
              onBack={() => { void discardPreview().then((ok) => { if (ok) setStage({ kind: 'describe' }); }); }}
              setBusy={setBusy}
              setErr={setErr}
            />
          )}

          {err && (
            <div style={{
              padding: 10, fontSize: 12.5,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8,
            }}>{err}</div>
          )}
        </div>

        {stage.kind === 'describe' && (
          <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => void requestClose()} disabled={busy} className="btn sm ghost">Cancel</button>
            <button onClick={generate} disabled={busy || description.trim().length < 8} className="btn sm accent">
              {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Generate</>}
            </button>
          </footer>
        )}
      </div>
    </div>
    </Portal>
  );
}

// ── Stages ──────────────────────────────────────────────────────────────────

function DescribeStage({
  description, setDescription, serviceLine, setServiceLine,
}: {
  description: string; setDescription(s: string): void;
  serviceLine: string; setServiceLine(s: string): void;
}) {
  return (
    <>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          What does your team sell?
        </span>
        <textarea
          className="input"
          rows={4}
          autoFocus
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. We do penetration testing for fintech and healthcare clients. Web apps, APIs, mobile, occasional cloud config reviews. Most engagements are 2-6 weeks."
          style={{ fontSize: 13, lineHeight: 1.5, padding: 10 }}
        />
        <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
          The more concrete (industries, deliverables, sizes), the better the questions.
        </span>
      </label>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Service line tag (optional)
        </span>
        <input
          className="input"
          value={serviceLine}
          onChange={(e) => setServiceLine(e.target.value)}
          placeholder="e.g. VAPT, SOC2, Cloud security"
          style={{ height: 32, padding: '0 10px', fontSize: 13 }}
        />
      </label>
    </>
  );
}

function ManualStage({
  prompt, onParsed, onBack,
}: {
  prompt: string;
  onParsed(nodes: GeneratedTemplateNode[]): void;
  onBack(): void;
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

  async function parse() {
    if (!pasted.trim()) return;
    setBusy(true); setErr(null);
    try {
      const res = await templateGen.parseManual(pasted);
      if (res.nodes.length === 0) {
        setErr('No valid questions found in that response. Make sure you pasted the AI\'s full reply.');
      } else {
        onParsed(res.nodes);
      }
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('not_json') || msg.includes('invalid_json')) {
        setErr('That doesn\'t look like the AI\'s JSON output. Try regenerating, or paste the full reply including the [ … ] block.');
      } else {
        setErr(msg);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{
        padding: '10px 12px', background: 'var(--accent-tint)',
        borderRadius: 8, fontSize: 12.5,
      }}>
        <div style={{ fontWeight: 600, marginBottom: 2 }}>
          <Icon.Sparkles size={11} /> Manual mode — use any AI you already have
        </div>
        <div style={{ color: 'var(--fg-muted)' }}>
          Click below to copy the prompt and open the AI in a new tab. Paste, get the response, paste it back here.
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
          {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy</>}
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
          Paste the AI&apos;s response
        </span>
        <textarea
          className="input mono"
          rows={8}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder='[{"question": "...", "nodeType": "...", ...}, ...]'
          style={{ fontSize: 12, lineHeight: 1.4, padding: 10 }}
        />
      </label>

      {err && (
        <div style={{
          padding: 10, fontSize: 12.5,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8,
        }}>{err}</div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={onBack} disabled={busy} className="btn sm ghost">
          <Icon.ChevronLeft size={11} /> Back
        </button>
        <button onClick={parse} disabled={busy || !pasted.trim()} className="btn sm accent">
          {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Use this</>}
        </button>
      </div>
    </>
  );
}

function PreviewStage({
  nodes, defaultName, defaultServiceLine, onCreate, onBack, setBusy, setErr,
}: {
  nodes: GeneratedTemplateNode[];
  defaultName: string;
  defaultServiceLine: string;
  onCreate(args: { name: string; serviceLine: string; nodes: GeneratedTemplateNode[] }): Promise<void>;
  onBack(): void;
  setBusy(b: boolean): void;
  setErr(e: string | null): void;
}) {
  const [name, setName] = useState(defaultName);
  const [serviceLine, setServiceLine] = useState(defaultServiceLine);
  const [creating, setCreating] = useState(false);

  async function create() {
    if (!name.trim() || !serviceLine.trim()) return;
    setCreating(true); setBusy(true); setErr(null);
    try {
      await onCreate({ name: name.trim(), serviceLine: serviceLine.trim(), nodes });
    } catch (e) {
      setErr(describeError(e));
      setCreating(false);
      setBusy(false);
    }
  }

  return (
    <>
      <div style={{
        padding: '10px 12px', background: 'var(--ok-tint)', color: 'var(--ok)',
        borderRadius: 8, fontSize: 12.5,
      }}>
        <Icon.Check size={11} /> Generated <b>{nodes.length}</b> question{nodes.length === 1 ? '' : 's'}.
        Review below, name the template, and create it.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Template name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Web app pen test — intake"
            style={{ height: 32, padding: '0 10px', fontSize: 13 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Service line</span>
          <input
            className="input"
            value={serviceLine}
            onChange={(e) => setServiceLine(e.target.value)}
            placeholder="e.g. VAPT"
            style={{ height: 32, padding: '0 10px', fontSize: 13 }}
          />
        </label>
      </div>

      <div style={{
        border: '1px solid var(--divider)', borderRadius: 8,
        background: 'var(--bg-sunk)', maxHeight: 360, overflow: 'auto',
      }}>
        {nodes.map((n, i) => <NodePreview key={i} node={n} index={i} />)}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={onBack} disabled={creating} className="btn sm ghost">
          <Icon.ChevronLeft size={11} /> Discard &amp; restart
        </button>
        <button onClick={create} disabled={creating || !name.trim() || !serviceLine.trim()} className="btn sm accent">
          {creating ? <span className="spin" /> : <><Icon.Plus size={11} /> Create template</>}
        </button>
      </div>
    </>
  );
}

function NodePreview({ node, index }: { node: GeneratedTemplateNode; index: number }) {
  const isSection = node.nodeType === 'section';
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '32px 1fr 110px', gap: 12,
      padding: '10px 12px', alignItems: 'flex-start',
      borderTop: index === 0 ? 'none' : '1px solid var(--divider)',
      background: isSection ? 'color-mix(in oklch, var(--accent-tint) 50%, transparent)' : undefined,
    }}>
      <span className="mono" style={{ fontSize: 11, color: 'var(--fg-subtle)', paddingTop: 2 }}>
        {String(index + 1).padStart(2, '0')}
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: isSection ? 600 : 500,
          color: 'var(--fg)',
        }}>
          {node.question}{node.required && !isSection && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>*</span>}
        </div>
        {node.helpText && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>{node.helpText}</div>
        )}
        {node.options && node.options.length > 0 && (
          <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {node.options.map((o, j) => (
              <span key={j} className="chip outline" style={{ fontSize: 10.5 }}>{o.label}</span>
            ))}
          </div>
        )}
      </div>
      <span className="chip outline" style={{ fontSize: 10.5, justifySelf: 'end' }}>{node.nodeType}</span>
    </div>
  );
}

// ── Heuristic helpers — friendly defaults for the preview stage ───────────

function defaultNameFromDescription(desc: string): string {
  if (!desc.trim()) return '';
  // Take the first ~6 meaningful words. Cheap and good-enough.
  const words = desc.trim().split(/\s+/).slice(0, 6).join(' ').replace(/[.,;:!?]+$/, '');
  return words.length > 60 ? words.slice(0, 60) + '…' : words;
}

function serviceLineFromDescription(desc: string): string {
  // Look for ALL-CAPS acronyms like VAPT, SOC2 — common in security work.
  const acronym = desc.match(/\b[A-Z]{3,}[0-9]?\b/);
  if (acronym) return acronym[0];
  return '';
}
