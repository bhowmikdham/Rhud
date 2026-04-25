'use client';

import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  templates,
  type NextRule,
  type NodeOption,
  type NodeType,
  type Template,
  type TemplateNode,
  type TemplateWithNodes,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';

const NODE_TYPES: NodeType[] = [
  'single_select',
  'multi_select',
  'short_text',
  'long_text',
  'number',
  'file_upload',
];

interface Issue {
  code: string;
  message: string;
  nodeId?: string;
}

export default function TemplateEditorPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [tmpl, setTmpl] = useState<TemplateWithNodes | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const t = await templates.get(id);
      setTmpl(t);
    } catch (e) {
      setErr(String(e));
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void reload();
  }, [reload, user]);

  const nodeOptions = useMemo(
    () =>
      tmpl?.nodes.map((n) => ({ id: n.id, label: `${n.position}. ${n.question.slice(0, 60)}` })) ?? [],
    [tmpl],
  );

  if (!user) return null;
  if (err && !tmpl) {
    return (
      <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: 'Not found' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22, color: 'var(--danger)' }}>{err}</div>
        </div>
      </AppShell>
    );
  }
  if (!tmpl) {
    return (
      <AppShell crumbs={[{ label: 'Templates', href: '/templates' }]}>
        <div className="page-inner empty"><span className="spin" /></div>
      </AppShell>
    );
  }

  // ── Mutators ───────────────────────────────────────────────────────────────

  async function patchTemplate(dto: Parameters<typeof templates.update>[1]) {
    setBusy(true);
    try {
      await templates.update(id, dto);
      await reload();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function addNode() {
    setBusy(true);
    try {
      await templates.addNode(id, {
        question: 'New question',
        nodeType: 'short_text',
        nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      });
      await reload();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function patchNode(nodeId: string, dto: Parameters<typeof templates.updateNode>[2]) {
    setBusy(true);
    try {
      await templates.updateNode(id, nodeId, dto);
      await reload();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function delNode(nodeId: string) {
    if (!confirm('Delete this node?')) return;
    setBusy(true);
    try {
      await templates.removeNode(id, nodeId);
      await reload();
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  }

  async function validate() {
    try {
      const r = await templates.validate(id);
      setIssues(r.issues);
    } catch (e) { setErr(String(e)); }
  }

  async function publish() {
    try {
      await templates.update(id, { status: 'published' });
      await reload();
      setIssues([]);
    } catch (e) {
      const apiErr = e as { body?: { issues?: Issue[] } };
      if (apiErr.body?.issues) setIssues(apiErr.body.issues);
      setErr(String(e));
    }
  }

  return (
    <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: tmpl.name }]}>
      <div className="page-inner">
        <Header
          tmpl={tmpl}
          onPatch={patchTemplate}
          onValidate={validate}
          onPublish={publish}
          busy={busy}
          previewHref={`/templates/${id}/preview`}
        />

        {issues.length > 0 && <IssueList issues={issues} onClose={() => setIssues([])} />}

        <section style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Nodes</h2>
            <button onClick={addNode} disabled={busy} className="btn">
              <Icon.Plus size={12} /> Add node
            </button>
          </div>

          {tmpl.nodes.length === 0 ? (
            <div className="card" style={{ padding: 32 }}>
              <div className="empty" style={{ padding: 0 }}>
                No nodes yet. Add one to start building the tree.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tmpl.nodes.map((node) => (
                <NodeCard
                  key={node.id}
                  node={node}
                  isRoot={tmpl.rootNodeId === node.id}
                  nodeOptions={nodeOptions}
                  onPatch={(dto) => patchNode(node.id, dto)}
                  onDelete={() => delNode(node.id)}
                  onSetRoot={() => patchTemplate({ rootNodeId: node.id })}
                  issues={issues.filter((i) => i.nodeId === node.id)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}

function Header({
  tmpl,
  onPatch,
  onValidate,
  onPublish,
  busy,
  previewHref,
}: {
  tmpl: Template;
  onPatch: (dto: Parameters<typeof templates.update>[1]) => Promise<void>;
  onValidate: () => Promise<void>;
  onPublish: () => Promise<void>;
  busy: boolean;
  previewHref: string;
}) {
  const [name, setName] = useState(tmpl.name);
  const [serviceLine, setServiceLine] = useState(tmpl.serviceLine);

  useEffect(() => setName(tmpl.name), [tmpl.name]);
  useEffect(() => setServiceLine(tmpl.serviceLine), [tmpl.serviceLine]);

  return (
    <div className="page-header">
      <div style={{ flex: 1, minWidth: 0 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== tmpl.name && void onPatch({ name })}
          className="page-title"
          style={{ background: 'transparent', border: 0, outline: 'none', width: '100%', padding: 0 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          <input
            value={serviceLine}
            onChange={(e) => setServiceLine(e.target.value)}
            onBlur={() => serviceLine !== tmpl.serviceLine && void onPatch({ serviceLine })}
            className="input"
            style={{ width: 'auto', height: 24, fontSize: 12, padding: '0 8px' }}
          />
          <span className="chip mono" style={{ padding: '0 6px' }}>v{tmpl.version}</span>
          <span className={'chip ' + (tmpl.status === 'published' ? 'ok' : 'warn')}>
            <Icon.Dot size={8} /> {tmpl.status}
          </span>
        </div>
      </div>
      <div className="page-actions">
        <Link href={previewHref} className="btn">
          <Icon.Eye size={12} />
          Preview
        </Link>
        <button onClick={() => void onValidate()} disabled={busy} className="btn">
          <Icon.CheckCircle size={12} /> Validate
        </button>
        {tmpl.status !== 'published' && (
          <button onClick={() => void onPublish()} disabled={busy} className="btn accent">
            <Icon.Send size={12} /> Publish
          </button>
        )}
      </div>
    </div>
  );
}

function IssueList({ issues, onClose }: { issues: Issue[]; onClose: () => void }) {
  return (
    <div style={{
      marginTop: 16,
      padding: 16,
      borderRadius: 'var(--radius-lg)',
      background: 'var(--warn-tint)',
      border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong style={{ fontSize: 13, color: 'var(--fg)' }}>{issues.length} validation issue(s)</strong>
        <button onClick={onClose} className="btn sm ghost"><Icon.X size={11} /></button>
      </div>
      <ul style={{ margin: '8px 0 0', paddingLeft: 20, fontSize: 12.5, color: 'var(--fg-muted)' }}>
        {issues.map((i, idx) => (
          <li key={idx} style={{ margin: '4px 0' }}>
            <span className="mono" style={{ color: 'var(--fg)' }}>{i.code}</span> — {i.message}
            {i.nodeId && <span style={{ color: 'var(--fg-subtle)' }}> (node {i.nodeId.slice(0, 8)}…)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function NodeCard({
  node,
  isRoot,
  nodeOptions,
  onPatch,
  onDelete,
  onSetRoot,
  issues,
}: {
  node: TemplateNode;
  isRoot: boolean;
  nodeOptions: Array<{ id: string; label: string }>;
  onPatch: (dto: Parameters<typeof templates.updateNode>[2]) => Promise<void>;
  onDelete: () => Promise<void>;
  onSetRoot: () => Promise<void>;
  issues: Issue[];
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(node.question);
  useEffect(() => setQuestion(node.question), [node.question]);
  const needsOptions = node.nodeType === 'single_select' || node.nodeType === 'multi_select';

  return (
    <div className="card" style={{ borderColor: issues.length ? 'color-mix(in oklch, var(--warn) 30%, var(--border))' : undefined }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <span className="chip mono" style={{ padding: '0 6px' }}>{node.position}</span>
        {isRoot && <span className="chip accent"><Icon.Dot size={8} />root</span>}
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={() => question !== node.question && void onPatch({ question })}
          style={{ flex: 1, background: 'transparent', border: 0, outline: 'none', fontSize: 13, fontWeight: 500 }}
        />
        <span className="chip mono" style={{ padding: '0 6px' }}>{node.nodeType}</span>
        <button onClick={() => setOpen((v) => !v)} className="btn sm ghost">
          {open ? 'Collapse' : 'Edit'}
        </button>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid var(--divider)', background: 'var(--bg-sunk)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Row label="Type">
            <select className="input" style={{ width: 'auto', height: 28 }} value={node.nodeType} onChange={(e) => void onPatch({ nodeType: e.target.value as NodeType })}>
              {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>

          {needsOptions && (
            <Row label="Options">
              <OptionsEditor value={node.options ?? []} onChange={(opts) => void onPatch({ options: opts })} />
            </Row>
          )}

          <Row label="Allow files">
            <input type="checkbox" checked={node.allowFiles} onChange={(e) => void onPatch({ allowFiles: e.target.checked })} />
          </Row>

          <Row label="Next rules">
            <RulesEditor
              value={node.nextRules}
              nodeOptions={nodeOptions.filter((o) => o.id !== node.id)}
              onChange={(rules) => void onPatch({ nextRules: rules })}
            />
          </Row>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 10, borderTop: '1px solid var(--divider)' }}>
            {!isRoot && (
              <button onClick={() => void onSetRoot()} className="btn sm">
                <Icon.Check size={11} /> Set as root
              </button>
            )}
            <button onClick={() => void onDelete()} className="btn sm danger">
              <Icon.X size={11} /> Delete node
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ fontSize: 11.5, fontWeight: 500, color: 'var(--fg-muted)', paddingTop: 6 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

function OptionsEditor({ value, onChange }: { value: NodeOption[]; onChange: (opts: NodeOption[]) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  function commit() {
    if (JSON.stringify(draft) !== JSON.stringify(value)) onChange(draft);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {draft.map((opt, i) => (
        <div key={i} style={{ display: 'flex', gap: 6 }}>
          <input className="input" placeholder="value" style={{ width: 140 }}
            value={opt.value}
            onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, value: e.target.value } : d)))}
            onBlur={commit}
          />
          <input className="input" placeholder="label" style={{ flex: 1 }}
            value={opt.label}
            onChange={(e) => setDraft(draft.map((d, j) => (j === i ? { ...d, label: e.target.value } : d)))}
            onBlur={commit}
          />
          <button className="btn sm ghost" onClick={() => { const n = draft.filter((_, j) => j !== i); setDraft(n); onChange(n); }}>
            <Icon.X size={11} />
          </button>
        </div>
      ))}
      <button onClick={() => setDraft([...draft, { value: '', label: '' }])} className="btn sm ghost" style={{ alignSelf: 'flex-start' }}>
        <Icon.Plus size={11} /> Add option
      </button>
    </div>
  );
}

function RulesEditor({
  value,
  nodeOptions,
  onChange,
}: {
  value: NextRule[];
  nodeOptions: Array<{ id: string; label: string }>;
  onChange: (rules: NextRule[]) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {value.map((rule, i) => (
        <div key={i} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 12 }}>
          <span style={{ color: 'var(--fg-muted)' }}>when</span>
          <select className="input" style={{ width: 'auto', height: 24, fontSize: 11.5 }} value={rule.when.op}
            onChange={(e) => {
              const op = e.target.value as NextRule['when']['op'];
              onChange(value.map((r, j) => (j === i ? { ...r, when: { op } } : r)));
            }}>
            {(['eq', 'neq', 'in', 'includes', 'gt', 'lt', 'always'] as const).map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          {rule.when.op !== 'always' && (
            <input className="input" style={{ width: 140, height: 24, fontSize: 11.5 }} placeholder="value"
              value={(rule.when.value as string) ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                onChange(value.map((r, j) => (j === i ? { ...r, when: { op: r.when.op, value: v } } : r)));
              }}
            />
          )}
          <span style={{ color: 'var(--fg-muted)' }}>→</span>
          <select className="input" style={{ width: 'auto', height: 24, fontSize: 11.5, maxWidth: 280 }} value={rule.goto}
            onChange={(e) => onChange(value.map((r, j) => (j === i ? { ...r, goto: e.target.value } : r)))}>
            <option value="END">END</option>
            {nodeOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
          <button className="btn sm ghost" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Icon.X size={11} />
          </button>
        </div>
      ))}
      <button onClick={() => onChange([...value, { when: { op: 'always' }, goto: 'END' }])} className="btn sm ghost" style={{ alignSelf: 'flex-start' }}>
        <Icon.Plus size={11} /> Add rule
      </button>
    </div>
  );
}
