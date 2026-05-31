'use client';

/**
 * Template preview — walks the tree using the shared engine, no persistence.
 * Renders inside the same `client-shell` aesthetic as the real /g/[token]
 * flow so admins see exactly what clients will.
 */
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { describeError, templates, type TemplateNode, type TemplateWithNodes, type NodeOption } from '@/lib/api';
import {
  resolveNext,
  validateAnswerShape,
  type Answer,
  type AnswerMap,
} from '@/lib/engine';
import { useRequireAuth } from '@/lib/auth-context';
import { Icon } from '@/components/icon';

export default function TemplatePreviewPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [tmpl, setTmpl] = useState<TemplateWithNodes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [path, setPath] = useState<string[]>([]);
  const [idx, setIdx] = useState(0);
  const [answers, setAnswers] = useState<AnswerMap>({});
  const [done, setDone] = useState(false);
  // Inline validation message for the current question card — replaces the
  // raw alert()s on answer-shape / tree-resolution failures.
  const [stepErr, setStepErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    templates.get(id).then((t) => {
      setTmpl(t);
      if (t.rootNodeId) setPath([t.rootNodeId]);
    }).catch((e) => setErr(describeError(e)));
  }, [id]);

  useEffect(() => {
    if (!user) return;
    load();
  }, [load, user]);

  const byId = useMemo(() => new Map(tmpl?.nodes.map((n) => [n.id, n]) ?? []), [tmpl]);

  if (!user) return null;
  if (err) return <BareErr msg={err} backHref={`/templates/${id}`} onRetry={load} />;
  if (!tmpl) return <BareLoading />;
  if (!tmpl.rootNodeId) {
    return (
      <div className="client-shell">
        <div className="client-card" style={{ padding: 32, textAlign: 'center', maxWidth: 480 }}>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            This template has no root node yet. Add a node and set it as root in the editor first.
          </p>
          <Link href={`/templates/${id}`} className="btn" style={{ marginTop: 14 }}>
            <Icon.ChevronLeft size={12} /> Back to editor
          </Link>
        </div>
      </div>
    );
  }
  if (done) return <PreviewDone answers={answers} tmpl={tmpl} onRestart={restart} editorHref={`/templates/${id}`} />;

  const currentId = path[idx];
  const node = currentId ? byId.get(currentId) : null;
  if (!node) return <BareErr msg={`unknown node ${currentId}`} backHref={`/templates/${id}`} />;

  const answer = answers[node.id] ?? null;
  const isSection = node.nodeType === 'section';
  const isOptional = node.required === false;

  function setAnswer(a: Answer) {
    setStepErr(null);
    setAnswers((m) => ({ ...m, [node!.id]: a }));
  }

  function next() {
    const a = answers[node!.id] ?? null;
    const shape = validateAnswerShape(node!.nodeType, a);
    if (!shape.ok) {
      setStepErr(`Check this answer: ${shape.reason}`);
      return;
    }
    const r = resolveNext(node!, a);
    if (r.kind === 'invalid') {
      setStepErr(`Tree error: ${r.reason}`);
      return;
    }
    setStepErr(null);
    if (r.kind === 'end') {
      setDone(true);
      return;
    }
    const nextPath = [...path.slice(0, idx + 1), r.nodeId];
    setPath(nextPath);
    setIdx(nextPath.length - 1);
  }

  function back() {
    if (idx > 0) {
      setStepErr(null);
      setIdx(idx - 1);
    }
  }

  function restart() {
    setAnswers({});
    setPath([tmpl!.rootNodeId!]);
    setIdx(0);
    setDone(false);
    setStepErr(null);
  }

  // The wizard length / progress should reflect only the steps on the
  // CURRENTLY active route. After a Back, `path` still holds the old
  // forward tail (so Continue can keep it when the answer is unchanged),
  // so the count must read the active prefix, not the full path.
  const activePath = path.slice(0, idx + 1);

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

  return (
    <div className="client-shell">
      <div className="client-hdr">
        <div className="brand">
          <div className="logo-mark" />
          <div>
            <div style={{ fontWeight: 600 }}>{tmpl.name}</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', fontWeight: 400 }}>{tmpl.serviceLine}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="chip warn"><Icon.Eye size={10} />Preview · no answers saved</span>
        </div>
      </div>

      <div className="client-card">
        <div className="client-progress">
          {activePath.map((nid, i) => (
            <div key={nid} className={'seg ' + (i < idx ? 'done' : i === idx ? 'active' : '')} />
          ))}
        </div>

        <div className="client-body">
          <div className="client-q">
            {isSection ? 'Section' : `Question ${idx + 1} of ${activePath.length}`}
            {isOptional && !isSection && <span style={{ marginLeft: 8, color: 'var(--fg-subtle)' }}>· optional</span>}
          </div>
          <div className="client-title">{node.question}</div>

          {node.helpText && (
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {node.helpText}
            </p>
          )}

          {!isSection && <NodeInput node={node} value={answer} onChange={setAnswer} />}

          {stepErr && (
            <p style={{ marginTop: 16, fontSize: 12.5, color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon.X size={12} /> {stepErr}
            </p>
          )}
        </div>

        <div className="client-foot">
          <span className="hint">
            <Icon.Eye size={12} /> Preview mode · no engagement created
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={idx === 0} onClick={back}>
              <Icon.ChevronLeft size={12} /> Back
            </button>
            <button className="btn accent" disabled={!canAdvance} onClick={next}>
              Continue <Icon.ArrowRight size={12} />
            </button>
          </div>
        </div>
      </div>

      <div style={{ color: 'var(--fg-subtle)', fontSize: 11, marginTop: 20, display: 'flex', gap: 6, alignItems: 'center' }}>
        <Link href={`/templates/${id}`} className="btn sm ghost">
          <Icon.ChevronLeft size={11} /> back to editor
        </Link>
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
    return (
      <input className="input" style={{ marginTop: 28 }} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} placeholder={node.placeholder ?? 'Type your answer…'} />
    );
  }

  if (node.nodeType === 'long_text') {
    return (
      <textarea className="input" style={{ marginTop: 28 }} rows={5} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)} placeholder={node.placeholder ?? 'Type your answer…'} />
    );
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
      <div className="attach-zone" style={{ marginTop: 28 }}>
        <Icon.Paperclip size={18} style={{ color: 'var(--fg-subtle)' }} />
        <div style={{ marginTop: 8 }}><b>File upload</b></div>
        <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 4 }}>
          Preview only — no upload happens. Real flow lives at /g/[token].
        </div>
      </div>
    );
  }

  return null;
}

function PreviewDone({ answers, tmpl, onRestart, editorHref }: { answers: AnswerMap; tmpl: TemplateWithNodes; onRestart: () => void; editorHref: string }) {
  const ordered = tmpl.nodes.filter((n) => n.id in answers).map((n) => ({ q: n.question, a: answers[n.id] }));
  return (
    <div className="client-shell">
      <div className="client-card" style={{ padding: 32, maxWidth: 560 }}>
        <div style={{ width: 44, height: 44, borderRadius: 999, background: 'var(--ok-tint)', color: 'var(--ok)', display: 'grid', placeItems: 'center' }}>
          <Icon.Check size={22} sw={2} />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 14 }}>Reached END</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: 4 }}>
          Tree walked successfully. In production this is where ML price prediction kicks in.
        </p>

        <div className="section-label" style={{ marginTop: 24, marginBottom: 8 }}>Recorded answers</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ordered.map((row, i) => (
            <div key={i} style={{ padding: 12, border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-sunk)' }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{row.q}</div>
              <div className="mono" style={{ marginTop: 4, color: 'var(--fg)' }}>{JSON.stringify(row.a)}</div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
          <button onClick={onRestart} className="btn">Restart preview</button>
          <Link href={editorHref} className="btn accent">Back to editor</Link>
        </div>
      </div>
    </div>
  );
}

function BareLoading() {
  return <div className="client-shell"><span className="spin" /></div>;
}
function BareErr({ msg, backHref, onRetry }: { msg: string; backHref: string; onRetry?: () => void }) {
  return (
    <div className="client-shell">
      <div className="client-card" style={{ padding: 32, textAlign: 'center', maxWidth: 480 }}>
        <p style={{ fontSize: 13, color: 'var(--danger)' }}>{msg}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
          <Link href={backHref} className="btn">← back</Link>
          {onRetry && (
            <button onClick={onRetry} className="btn accent">Retry</button>
          )}
        </div>
      </div>
    </div>
  );
}
