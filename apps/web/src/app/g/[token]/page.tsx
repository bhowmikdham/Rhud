'use client';

/**
 * Client-facing gathering flow — port of prototype/client-form.jsx onto the
 * real /g/:token endpoint. The token in the URL is the only authority; no
 * login. State persists server-side so closing the tab and re-opening picks
 * up where the client left off.
 */
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  gathering,
  type GatheringLoopContext,
  type GatheringLoopStep,
  type GatheringNext,
  type GatheringStateResponse,
} from '@/lib/api';
import type { TemplateNode, NodeOption } from '@rhud/shared';
import { Icon } from '@/components/icon';

type Answer = string | string[] | number | null;

export default function GatheringFlowPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [state, setState] = useState<GatheringStateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  // Local override for the cursor returned by the server. Lets us advance
  // the UI immediately after submitAnswer / loopStep without re-fetching
  // /state every step (which is more polite to the API + smoother UX).
  const [cursor, setCursor] = useState<{
    node: TemplateNode | null;
    loopContext: GatheringLoopContext | null;
    loopStep: GatheringLoopStep | null;
  }>({ node: null, loopContext: null, loopStep: null });

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const s = await gathering.state(token);
      setState(s);
      setCursor({ node: s.currentNode, loopContext: s.loopContext, loopStep: s.loopStep });
      if (s.currentNode) {
        // For body nodes, prefill from the current iter's answers; for
        // top-level nodes, from the flat answers map.
        const iter = s.loopContext?.iter ?? 0;
        const fromLoop = s.currentNode.parentNodeId
          ? s.loopAnswers[s.currentNode.parentNodeId]?.[iter]?.[s.currentNode.id]
          : undefined;
        const existing = fromLoop ?? s.answers[s.currentNode.id];
        setAnswer((existing as Answer) ?? null);
        // Progress: top-level answers + loop iterations × body size, rough.
        const loopCount = Object.values(s.loopAnswers).reduce(
          (sum, arr) => sum + arr.reduce((s2, dict) => s2 + Object.keys(dict).length, 0),
          0,
        );
        setStepIdx(Object.keys(s.answers).length + loopCount);
      } else if (s.status === 'submitted') {
        setDone(true);
      }
    } catch (e) {
      setErr(String(e));
    }
  }, [token]);

  useEffect(() => { void reload(); }, [reload]);

  function applyNext(next: GatheringNext) {
    if (next.kind === 'end') {
      setCursor({ node: null, loopContext: null, loopStep: null });
      return;
    }
    if (next.kind === 'loop_step') {
      setCursor({
        node: null,
        loopContext: null,
        loopStep: { loopId: next.loopId, label: next.label, iter: next.iter },
      });
      setAnswer(null);
      return;
    }
    setCursor({ node: next.node, loopContext: next.loopContext, loopStep: null });
    setAnswer(null);
    setStepIdx((i) => i + 1);
  }

  async function submitLoopStep(action: 'continue' | 'done') {
    if (!cursor.loopStep) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await gathering.loopStep(token, { loopId: cursor.loopStep.loopId, action });
      if (r.next.kind === 'end') {
        const sub = await gathering.submit(token);
        if (sub.status === 'submitted') {
          setDone(true);
          return;
        }
      }
      applyNext(r.next);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (err) return <ErrorView msg={err} />;
  if (!state) return <Loading />;

  // Loop-step prompt — "Add another?" — preempts everything else.
  if (cursor.loopStep) {
    return (
      <LoopStepView
        templateName={state.templateName}
        token={token}
        step={cursor.loopStep}
        onAction={submitLoopStep}
        busy={busy}
      />
    );
  }

  if (done || !cursor.node) return <SubmittedView templateName={state.templateName} />;

  const node = cursor.node;
  const allowFiles = node.allowFiles;
  const isSection = node.nodeType === 'section';
  const isOptional = node.required === false;
  const loopContext = cursor.loopContext;

  const canAdvance = (() => {
    if (isSection) return true;
    if (isOptional) return true;
    if (node.nodeType === 'single_select') return typeof answer === 'string' && answer.length > 0;
    if (node.nodeType === 'multi_select') return Array.isArray(answer) && answer.length > 0;
    if (node.nodeType === 'short_text' || node.nodeType === 'long_text') return typeof answer === 'string' && answer.trim().length > 0;
    if (node.nodeType === 'number') return typeof answer === 'number' && Number.isFinite(answer);
    if (node.nodeType === 'file_upload') return true;
    return false;
  })();

  async function next() {
    setBusy(true);
    setErr(null);
    try {
      const payload = isSection ? null : answer;
      const r = await gathering.answer(token, { nodeId: node.id, answer: payload });
      if (r.next.kind === 'end') {
        const sub = await gathering.submit(token);
        if (sub.status === 'submitted') {
          setDone(true);
          return;
        }
      }
      applyNext(r.next);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    setErr(null);
    try {
      const url = await gathering.uploadUrl(token, {
        nodeId: node.id,
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      const r = await fetch(url.uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type || 'application/octet-stream' },
        body: file,
      });
      if (!r.ok) throw new Error(`upload failed ${r.status}`);
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  const totalAnswered = Object.keys(state.answers).length;
  const segs = Math.max(totalAnswered + 1, 5);

  return (
    <div className="client-shell">
      <div className="client-hdr">
        <div className="brand">
          <div className="logo-mark" />
          <div>
            <div style={{ fontWeight: 600 }}>{state.templateName}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', fontWeight: 400 }}>Secure scoping · single-use link</div>
          </div>
        </div>
        <span className="client-token"><Icon.Lock size={11} /> rhud.link/g/{token.slice(0, 6)}…</span>
      </div>

      <div className="client-card">
        <div className="client-progress">
          {Array.from({ length: segs }).map((_, i) => (
            <div key={i} className={'seg ' + (i < stepIdx ? 'done' : i === stepIdx ? 'active' : '')} />
          ))}
        </div>

        <div className="client-body">
          {loopContext && (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 999,
              background: 'var(--accent-tint)',
              color: 'var(--accent)',
              fontSize: 11.5,
              fontWeight: 500,
              marginBottom: 12,
            }}>
              <Icon.Hash size={11} /> {loopContext.label} {loopContext.iter + 1}
            </div>
          )}
          <div className="client-q">
            {isSection ? 'Section' : `Question ${stepIdx + 1}`}
            {isOptional && !isSection && <span style={{ marginLeft: 8, color: 'var(--fg-subtle)' }}>· optional</span>}
          </div>
          <div className="client-title">{node.question}</div>

          {node.helpText && (
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {node.helpText}
            </p>
          )}

          {!isSection && <NodeInput node={node as TemplateNode} value={answer} onChange={setAnswer} />}

          {allowFiles && !isSection && <FileSection node={node as TemplateNode} state={state} onUpload={uploadFile} />}
        </div>

        <div className="client-foot">
          <span className="hint">
            <Icon.Shield size={12} /> End-to-end encrypted · single-use link
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn accent" disabled={busy || !canAdvance} onClick={next}>
              {busy ? <span className="spin" /> : <><Icon.ArrowRight size={12} />Continue</>}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div style={{
          marginTop: 16, padding: '8px 12px', maxWidth: 720,
          background: 'var(--danger-tint)', color: 'var(--danger)',
          border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          borderRadius: 8, fontSize: 12,
        }}>{err}</div>
      )}

      <div style={{ color: 'var(--fg-subtle)', fontSize: 11, marginTop: 20, display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icon.Shield size={11} />
        Powered by <b style={{ fontWeight: 500, color: 'var(--fg-muted)' }}>rhud</b> · All data encrypted in transit and at rest
      </div>
    </div>
  );
}

function NodeInput({ node, value, onChange }: { node: TemplateNode; value: Answer; onChange: (a: Answer) => void }) {
  const opts: NodeOption[] = node.options ?? [];

  if (node.nodeType === 'single_select') {
    return (
      <div className="choice-list">
        {opts.map((o) => (
          <div key={o.value} className={'choice' + (value === o.value ? ' selected' : '')} onClick={() => onChange(o.value)}>
            <div className="bullet" />
            <div className="body">
              <div className="label">{o.label}</div>
              {o.desc && <div className="desc">{o.desc}</div>}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (node.nodeType === 'multi_select') {
    const arr = Array.isArray(value) ? value : [];
    return (
      <div className="choice-list" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {opts.map((o) => {
          const sel = arr.includes(o.value);
          return (
            <div key={o.value} className={'choice' + (sel ? ' selected' : '')}
              style={{ padding: '12px 14px' }}
              onClick={() => onChange(sel ? arr.filter((v) => v !== o.value) : [...arr, o.value])}>
              <div style={{
                width: 16, height: 16, borderRadius: 4,
                border: '1.5px solid ' + (sel ? 'var(--fg)' : 'var(--border-strong)'),
                background: sel ? 'var(--fg)' : 'transparent',
                display: 'grid', placeItems: 'center', color: 'var(--bg)',
                marginTop: 1, flexShrink: 0,
              }}>
                {sel && <Icon.Check size={10} sw={2.2} />}
              </div>
              <div className="body"><div className="label">{o.label}</div></div>
            </div>
          );
        })}
      </div>
    );
  }

  if (node.nodeType === 'short_text') {
    return <input className="input" style={{ marginTop: 28 }} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} placeholder={node.placeholder ?? 'Type your answer…'} />;
  }

  if (node.nodeType === 'long_text') {
    return <textarea className="input" style={{ marginTop: 28 }} rows={5} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} placeholder={node.placeholder ?? 'Type your answer…'} />;
  }

  if (node.nodeType === 'number') {
    return (
      <input className="input" type="number" style={{ marginTop: 28, height: 56, fontSize: 28, fontWeight: 500, padding: '0 18px' }}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        placeholder={node.placeholder ?? '0'} />
    );
  }

  if (node.nodeType === 'file_upload') {
    return (
      <p className="attach-zone" style={{ marginTop: 28 }}>
        Use the file uploader below — this node has no inline answer.
      </p>
    );
  }
  return null;
}

function FileSection({
  node, state, onUpload,
}: {
  node: TemplateNode;
  state: GatheringStateResponse;
  onUpload: (f: File) => Promise<void>;
}) {
  const existing = state.files[node.id] ?? [];
  return (
    <div style={{ marginTop: 24 }}>
      <div className="section-label" style={{ marginBottom: 8 }}>Attachments (optional)</div>
      {existing.length > 0 && (
        <div className="attach-list">
          {existing.map((f) => (
            <div key={f.id} className="attach-item">
              <Icon.File size={13} style={{ color: 'var(--fg-subtle)' }} />
              <span className="name">{f.filename}</span>
              <span className="size">{(f.sizeBytes / 1024).toFixed(1)} KB</span>
            </div>
          ))}
        </div>
      )}
      <label className="attach-zone" style={{ marginTop: existing.length ? 10 : 0 }}>
        <Icon.Paperclip size={18} style={{ color: 'var(--fg-subtle)', marginBottom: 6 }} />
        <div><b>Drop files or click to browse</b></div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
          Up to 50 MB · encrypted at rest · visible only to your sales rep
        </div>
        <input
          type="file"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onUpload(f);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}

function ErrorView({ msg }: { msg: string }) {
  return (
    <div className="client-shell">
      <div className="client-card" style={{ padding: 32, textAlign: 'center', maxWidth: 480 }}>
        <div style={{ width: 44, height: 44, margin: '0 auto', borderRadius: 999, background: 'var(--danger-tint)', color: 'var(--danger)', display: 'grid', placeItems: 'center' }}>
          <Icon.X size={22} sw={2} />
        </div>
        <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 14 }}>This link doesn&apos;t work</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13.5, marginTop: 6, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' }}>
          It may have expired, been used already, or been revoked. Reach out to your sales contact for a fresh one.
        </p>
        <pre className="mono" style={{ marginTop: 14, padding: 10, background: 'var(--bg-sunk)', borderRadius: 6, fontSize: 11, color: 'var(--fg-subtle)', textAlign: 'left', overflow: 'auto' }}>{msg}</pre>
      </div>
    </div>
  );
}

function LoopStepView({
  templateName,
  token,
  step,
  onAction,
  busy,
}: {
  templateName: string;
  token: string;
  step: GatheringLoopStep;
  onAction(action: 'continue' | 'done'): void;
  busy: boolean;
}) {
  return (
    <div className="client-shell">
      <div className="client-hdr">
        <div className="brand">
          <div className="logo-mark" />
          <div>
            <div style={{ fontWeight: 600 }}>{templateName}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', fontWeight: 400 }}>Secure scoping · single-use link</div>
          </div>
        </div>
        <span className="client-token"><Icon.Lock size={11} /> rhud.link/g/{token.slice(0, 6)}…</span>
      </div>

      <div className="client-card">
        <div className="client-body" style={{ paddingTop: 32, paddingBottom: 32 }}>
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '4px 10px',
            borderRadius: 999,
            background: 'var(--ok-tint)',
            color: 'var(--ok)',
            fontSize: 11.5,
            fontWeight: 500,
          }}>
            <Icon.Check size={11} sw={2.2} /> {step.label} {step.iter + 1} captured
          </div>
          <div className="client-title" style={{ marginTop: 14 }}>
            Add another {step.label.toLowerCase()}?
          </div>
          <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            We&apos;ll ask the same set of questions for the next {step.label.toLowerCase()}.
            Pick &quot;No, I&apos;m done&quot; if {step.label} {step.iter + 1} is the last one in scope.
          </p>
        </div>

        <div className="client-foot">
          <span className="hint">
            <Icon.Hash size={12} /> Iteration {step.iter + 1}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={busy} onClick={() => onAction('done')}>
              {busy ? <span className="spin" /> : <>No, I&apos;m done</>}
            </button>
            <button className="btn accent" disabled={busy} onClick={() => onAction('continue')}>
              {busy ? <span className="spin" /> : <><Icon.Plus size={12} /> Add another</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function SubmittedView({ templateName }: { templateName: string }) {
  return (
    <div className="client-shell">
      <div className="client-card" style={{ padding: 48, textAlign: 'center', maxWidth: 540 }}>
        <div style={{ width: 56, height: 56, margin: '0 auto', borderRadius: 999, background: 'var(--ok-tint)', color: 'var(--ok)', display: 'grid', placeItems: 'center' }}>
          <Icon.Check size={28} sw={2} />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 18 }}>Scope received</h2>
        <p style={{ color: 'var(--fg-muted)', margin: '8px auto 0', maxWidth: 380, fontSize: 14 }}>
          Thanks — we have everything we need. Your sales rep will review and come back with a proposal within 24 hours.
        </p>
        <p style={{ color: 'var(--fg-subtle)', fontSize: 11.5, marginTop: 14 }}>{templateName}</p>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="client-shell"><span className="spin" /></div>;
}
