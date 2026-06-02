'use client';

import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  rateCards,
  templates,
  type ImportNodeInput,
  type NextRule,
  type NodeOption,
  type NodeType,
  type RateCardFull,
  type RateCardSummary,
  type Template,
  type TemplateNode,
  type TemplateWithNodes,
} from '@/lib/api';
import { ApiError, describeError } from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';
import { SheetImportModal } from './sheet-import-modal';

const NODE_TYPES: NodeType[] = [
  'section',
  'loop',
  'single_select',
  'multi_select',
  'short_text',
  'long_text',
  'number',
  'file_upload',
];

/**
 * Render order: top-level nodes by position, with each loop node followed
 * immediately by its body children (also sorted by position) at indent=1.
 * Anything else stays at indent=0. Body nodes get rendered visually nested
 * so the admin can see "these belong to that loop".
 */
function orderedNodesForDisplay(
  nodes: TemplateNode[],
): Array<{ node: TemplateNode; indent: number }> {
  const top = nodes.filter((n) => !n.parentNodeId).sort((a, b) => a.position - b.position);
  const childrenByLoop = new Map<string, TemplateNode[]>();
  for (const n of nodes) {
    if (!n.parentNodeId) continue;
    const list = childrenByLoop.get(n.parentNodeId) ?? [];
    list.push(n);
    childrenByLoop.set(n.parentNodeId, list);
  }
  const out: Array<{ node: TemplateNode; indent: number }> = [];
  for (const n of top) {
    out.push({ node: n, indent: 0 });
    if (n.nodeType === 'loop') {
      const body = (childrenByLoop.get(n.id) ?? []).sort((a, b) => a.position - b.position);
      for (const c of body) out.push({ node: c, indent: 1 });
    }
  }
  return out;
}

interface Issue {
  code: string;
  message: string;
  nodeId?: string;
}

export default function TemplateEditorPage() {
  const user = useRequireAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const confirm = useConfirm();
  const id = params.id;

  const [tmpl, setTmpl] = useState<TemplateWithNodes | null>(null);
  const [cards, setCards] = useState<RateCardSummary[]>([]);
  const [activeCard, setActiveCard] = useState<RateCardFull | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [validating, setValidating] = useState(false);
  const [validClean, setValidClean] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const reload = useCallback(async () => {
    setErr(null);
    setNotFound(false);
    try {
      const t = await templates.get(id);
      setTmpl(t);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      setErr(describeError(e));
    }
  }, [id]);

  useEffect(() => {
    if (!user) return;
    void reload();
    rateCards.list().then(setCards).catch(() => setCards([]));
  }, [reload, user]);

  // Drill into the bound rate card so body nodes can pick a methodology
  // / customer-type from its actual options instead of guessing.
  useEffect(() => {
    const cardId = tmpl?.rateCardId;
    if (!cardId) {
      setActiveCard(null);
      return;
    }
    rateCards.get(cardId).then(setActiveCard).catch(() => setActiveCard(null));
  }, [tmpl?.rateCardId]);

  const nodeOptions = useMemo(
    () =>
      tmpl?.nodes.map((n) => ({ id: n.id, label: `${n.position}. ${n.question.slice(0, 60)}` })) ?? [],
    [tmpl],
  );

  if (!user) return null;
  if (err && !tmpl) {
    return (
      <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: notFound ? 'Not found' : 'Templates' }]}>
        <div className="page-inner">
          <div className="card" style={{ padding: 22 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)' }}>
              {notFound ? 'Template not found' : "Couldn't load template"}
            </div>
            <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--fg-muted)' }}>{err}</div>
            {!notFound && (
              <button onClick={() => void reload()} className="btn sm" style={{ marginTop: 14 }}>
                Retry
              </button>
            )}
          </div>
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
    } catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }

  async function addNode() {
    setBusy(true);
    setValidClean(false);
    try {
      await templates.addNode(id, {
        question: 'New question',
        nodeType: 'short_text',
        nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      });
      await reload();
    } catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }

  async function importPastedNodes(dto: { replace: boolean; nodes: ImportNodeInput[] }) {
    setBusy(true);
    setValidClean(false);
    try {
      await templates.importNodes(id, dto);
      setImportOpen(false);
      await reload();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function patchNode(nodeId: string, dto: Parameters<typeof templates.updateNode>[2]) {
    setBusy(true);
    setValidClean(false);
    try {
      await templates.updateNode(id, nodeId, dto);
      await reload();
    } catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }

  async function delNode(nodeId: string) {
    const ok = await confirm({
      title: 'Delete this node?',
      body: `Removes the question and any branch rules pointing into it. Already-issued opportunities aren't affected — they snapshot the template version.`,
      tone: 'danger',
      confirmLabel: 'Delete node',
    });
    if (!ok) return;
    setBusy(true);
    setValidClean(false);
    try {
      await templates.removeNode(id, nodeId);
      await reload();
    } catch (e) { setErr(describeError(e)); } finally { setBusy(false); }
  }

  async function validate() {
    setValidating(true);
    try {
      const r = await templates.validate(id);
      setIssues(r.issues);
      setValidClean(r.issues.length === 0);
    } catch (e) { setErr(describeError(e)); } finally { setValidating(false); }
  }

  async function publish() {
    try {
      await templates.update(id, { status: 'published' });
      await reload();
      setIssues([]);
      setValidClean(false);
    } catch (e) {
      const apiErr = e as { body?: { issues?: Issue[]; message?: { issues?: Issue[] } } };
      const fromBody = apiErr.body?.issues ?? apiErr.body?.message?.issues;
      if (fromBody) setIssues(fromBody);
      setErr(describeError(e));
    }
  }

  return (
    <AppShell crumbs={[{ label: 'Templates', href: '/templates' }, { label: tmpl.name }]}>
      <div className="page-inner">
        <Header
          tmpl={tmpl}
          cards={cards}
          onPatch={patchTemplate}
          onValidate={validate}
          onPublish={publish}
          busy={busy}
          validating={validating}
          previewHref={`/templates/${id}/preview`}
        />

        {err && (
          <div
            className="card"
            style={{
              marginTop: 16, padding: '12px 14px', fontSize: 12.5,
              display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
              color: 'var(--danger)', background: 'var(--danger-tint)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
            }}
          >
            <span>{err}</span>
            <button onClick={() => setErr(null)} className="btn sm ghost"><Icon.X size={11} /></button>
          </div>
        )}

        {validClean && issues.length === 0 && (
          <div
            style={{
              marginTop: 16, padding: '12px 14px', fontSize: 12.5,
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
              borderRadius: 'var(--radius-lg)',
              color: 'var(--ok)', background: 'var(--ok-tint)',
              border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon.Check size={12} /> Template is valid — ready to publish
            </span>
            <button onClick={() => setValidClean(false)} className="btn sm ghost"><Icon.X size={11} /></button>
          </div>
        )}

        {issues.length > 0 && <IssueList issues={issues} onClose={() => setIssues([])} />}

        <ProposalScaffoldEditor
          value={tmpl.proposalScaffold ?? ''}
          onSave={(next) => void patchTemplate({ proposalScaffold: next.trim() ? next : null })}
        />

        <section style={{ marginTop: 28 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: '-0.01em' }}>Nodes</h2>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setImportOpen(true)} disabled={busy} className="btn">
                <Icon.Paperclip size={12} /> Import questionnaire
              </button>
              <button onClick={addNode} disabled={busy} className="btn">
                <Icon.Plus size={12} /> Add node
              </button>
            </div>
          </div>

          {tmpl.nodes.length === 0 ? (
            <div className="card" style={{ padding: 32 }}>
              <div className="empty" style={{ padding: 0 }}>
                No nodes yet. Add one to start building the tree.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {orderedNodesForDisplay(tmpl.nodes).map(({ node, indent }) => (
                <div key={node.id} style={{ marginLeft: indent * 24 }}>
                  <NodeCard
                    node={node}
                    isRoot={tmpl.rootNodeId === node.id}
                    nodeOptions={nodeOptions}
                    rateCard={activeCard}
                    onPatch={(dto) => patchNode(node.id, dto)}
                    onDelete={() => delNode(node.id)}
                    onSetRoot={() => patchTemplate({ rootNodeId: node.id })}
                    issues={issues.filter((i) => i.nodeId === node.id)}
                  />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {importOpen && (
        <SheetImportModal
          onCancel={() => setImportOpen(false)}
          onImport={importPastedNodes}
          busy={busy}
        />
      )}
    </AppShell>
  );
}

function Header({
  tmpl,
  cards,
  onPatch,
  onValidate,
  onPublish,
  busy,
  validating,
  previewHref,
}: {
  tmpl: Template;
  cards: RateCardSummary[];
  onPatch: (dto: Parameters<typeof templates.update>[1]) => Promise<void>;
  onValidate: () => Promise<void>;
  onPublish: () => Promise<void>;
  busy: boolean;
  validating: boolean;
  previewHref: string;
}) {
  const [name, setName] = useState(tmpl.name);
  const [serviceLine, setServiceLine] = useState(tmpl.serviceLine);
  const [gammaId, setGammaId] = useState(tmpl.gammaTemplateId ?? '');

  useEffect(() => setName(tmpl.name), [tmpl.name]);
  useEffect(() => setServiceLine(tmpl.serviceLine), [tmpl.serviceLine]);
  useEffect(() => setGammaId(tmpl.gammaTemplateId ?? ''), [tmpl.gammaTemplateId]);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
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
          <select
            className="input"
            style={{ width: 'auto', height: 24, fontSize: 12, padding: '0 8px' }}
            value={tmpl.rateCardId ?? ''}
            onChange={(e) => void onPatch({ rateCardId: e.target.value === '' ? null : e.target.value })}
            title="Rate card used to price submitted engagements"
          >
            <option value="">— no rate card —</option>
            {cards.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} v{c.version} ({c.status})
              </option>
            ))}
          </select>
          {tmpl.status === 'published' && !tmpl.rateCardId && (
            <span
              className="chip warn"
              style={{ padding: '0 6px' }}
              title="Opportunities issued from this template won't produce a price prediction until a rate card is bound."
            >
              <Icon.Sparkle size={9} /> No rate card — opportunities won&apos;t be priced
            </span>
          )}
          <input
            className="input"
            value={gammaId}
            onChange={(e) => setGammaId(e.target.value)}
            onBlur={() => {
              const next = gammaId.trim();
              const current = tmpl.gammaTemplateId ?? '';
              if (next !== current) void onPatch({ gammaTemplateId: next === '' ? null : next });
            }}
            placeholder="Gamma template id (optional)"
            title="When set, proposal drafts via Gamma inherit this template's layout. Find the id in the URL of any Gamma deck or template you want to reuse."
            style={{ width: 220, height: 24, fontSize: 12, padding: '0 8px' }}
          />
          {tmpl.gammaTemplateId && (
            <span className="chip ok" title="Gamma will adapt this template for each opportunity">
              <Icon.Check size={10} /> Gamma connected
            </span>
          )}
        </div>
        <ProposalFlowHint
          hasGammaTemplate={!!tmpl.gammaTemplateId}
          hasScaffold={!!(tmpl.proposalScaffold && tmpl.proposalScaffold.trim())}
        />
      </div>
      <div className="page-actions">
        <Link href={previewHref} className="btn">
          <Icon.Eye size={12} />
          Preview
        </Link>
        <button onClick={() => void onValidate()} disabled={busy || validating} className="btn">
          {validating ? <span className="spin" /> : <Icon.CheckCircle size={12} />} Validate
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
  rateCard,
  onPatch,
  onDelete,
  onSetRoot,
  issues,
}: {
  node: TemplateNode;
  isRoot: boolean;
  nodeOptions: Array<{ id: string; label: string }>;
  rateCard: RateCardFull | null;
  onPatch: (dto: Parameters<typeof templates.updateNode>[2]) => Promise<void>;
  onDelete: () => Promise<void>;
  onSetRoot: () => Promise<void>;
  issues: Issue[];
}) {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState(node.question);
  const [helpText, setHelpText] = useState(node.helpText ?? '');
  const [placeholder, setPlaceholder] = useState(node.placeholder ?? '');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => setQuestion(node.question), [node.question]);
  useEffect(() => setHelpText(node.helpText ?? ''), [node.helpText]);
  useEffect(() => setPlaceholder(node.placeholder ?? ''), [node.placeholder]);

  // Flash a per-card "Saved" tick after a successful field patch. Mirrors
  // the ProposalScaffoldEditor savedAt pattern — onPatch already surfaces
  // failures via the editor's shared error banner, so we only show the
  // tick on resolve.
  async function patch(dto: Parameters<typeof onPatch>[0]) {
    await onPatch(dto);
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 1500);
  }
  const isSection = node.nodeType === 'section';
  const isLoop = node.nodeType === 'loop';
  const isLoopBody = !!node.parentNodeId;
  const needsOptions = node.nodeType === 'single_select' || node.nodeType === 'multi_select';
  const showsPlaceholder =
    node.nodeType === 'short_text' ||
    node.nodeType === 'long_text' ||
    node.nodeType === 'number';
  const required = node.required ?? true;

  return (
    <div className="card" style={{
      borderColor: issues.length ? 'color-mix(in oklch, var(--warn) 30%, var(--border))' : undefined,
      background: isSection ? 'var(--bg-sunk)' : undefined,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' }}>
        <span className="chip mono" style={{ padding: '0 6px' }}>{node.position}</span>
        {isRoot && <span className="chip accent"><Icon.Dot size={8} />root</span>}
        {isSection && <span className="chip" style={{ padding: '0 6px' }}>Section</span>}
        {isLoop && <span className="chip accent" style={{ padding: '0 6px' }}><Icon.Hash size={9} /> Loop</span>}
        {isLoopBody && <span className="chip" style={{ padding: '0 6px', fontSize: 10.5 }}>↳ in loop body</span>}
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onBlur={() => question !== node.question && void patch({ question })}
          style={{
            flex: 1,
            background: 'transparent',
            border: 0,
            outline: 'none',
            fontSize: isSection ? 14 : 13,
            fontWeight: isSection ? 600 : 500,
            letterSpacing: isSection ? '-0.01em' : undefined,
          }}
        />
        <span className="chip mono" style={{ padding: '0 6px' }}>{node.nodeType}</span>
        {!isSection && !required && <span className="chip" style={{ padding: '0 6px' }}>optional</span>}
        {savedAt && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ok)' }}>
            <Icon.Check size={10} /> Saved
          </span>
        )}
        <button onClick={() => setOpen((v) => !v)} className="btn sm ghost">
          {open ? 'Collapse' : 'Edit'}
        </button>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid var(--divider)', background: 'var(--bg-sunk)', padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Row label="Type">
            <select className="input" style={{ width: 'auto', height: 28 }} value={node.nodeType} onChange={(e) => void patch({ nodeType: e.target.value as NodeType })}>
              {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Row>

          {isLoop && (
            <>
              <Row label="Iteration label">
                <input
                  className="input"
                  defaultValue={node.loopConfig?.label ?? ''}
                  placeholder="e.g. Application — shown as “Application 1 of N”"
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    const cur = node.loopConfig?.label ?? '';
                    if (next === cur) return;
                    void patch({
                      loopConfig: {
                        mode: 'open_ended',
                        ...(next ? { label: next } : {}),
                        ...(node.loopConfig?.serviceLineSlug
                          ? { serviceLineSlug: node.loopConfig.serviceLineSlug }
                          : {}),
                      },
                    });
                  }}
                />
              </Row>
              <Row label="Service line">
                {rateCard ? (
                  <select
                    className="input"
                    style={{ width: '100%', maxWidth: 360 }}
                    value={node.loopConfig?.serviceLineSlug ?? ''}
                    onChange={(e) => {
                      const slug = e.target.value || undefined;
                      void patch({
                        loopConfig: {
                          mode: 'open_ended',
                          ...(node.loopConfig?.label ? { label: node.loopConfig.label } : {}),
                          ...(slug ? { serviceLineSlug: slug } : {}),
                        },
                      });
                    }}
                  >
                    <option value="">— don&apos;t price —</option>
                    {rateCard.serviceLines.map((sl) => (
                      <option key={sl.slug} value={sl.slug}>
                        {sl.displayName} ({sl.scopeUnit})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                    Bind a rate card to the template above to enable pricing for this loop.
                  </span>
                )}
              </Row>
            </>
          )}

          {isLoopBody && (
            <Row label="Pricing role">
              <select
                className="input"
                style={{ width: '100%', maxWidth: 360 }}
                value={node.binding?.field ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) {
                    void patch({ binding: null });
                    return;
                  }
                  void patch({ binding: { field: v as 'scope_value' | 'methodology' | 'customer_type' } });
                }}
              >
                <option value="">— informational only —</option>
                <option value="scope_value">Scope value (count of pages / screens / APIs / …)</option>
                <option value="methodology">Methodology (Grey Box / Black Box / VA / PT)</option>
                <option value="customer_type">Customer type (internal / external)</option>
              </select>
            </Row>
          )}

          <Row label={isSection ? 'Body copy' : isLoop ? 'Description' : 'Help text'}>
            <textarea
              className="input"
              rows={isSection ? 3 : 2}
              value={helpText}
              onChange={(e) => setHelpText(e.target.value)}
              onBlur={() => (helpText || '') !== (node.helpText ?? '') && void patch({ helpText: helpText || null })}
              placeholder={isSection ? 'Describe this section…' : 'Guidance shown beneath the field'}
            />
          </Row>

          {showsPlaceholder && (
            <Row label="Placeholder">
              <input
                className="input"
                value={placeholder}
                onChange={(e) => setPlaceholder(e.target.value)}
                onBlur={() => (placeholder || '') !== (node.placeholder ?? '') && void patch({ placeholder: placeholder || null })}
                placeholder="e.g. Enter approximate value"
              />
            </Row>
          )}

          {!isSection && (
            <Row label="Required">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--fg-muted)' }}>
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => void patch({ required: e.target.checked })}
                />
                Responder must answer this question
              </label>
            </Row>
          )}

          {needsOptions && (
            <Row label="Options">
              <OptionsEditor value={node.options ?? []} onChange={(opts) => void patch({ options: opts })} />
            </Row>
          )}

          {!isSection && (
            <Row label="Allow files">
              <input type="checkbox" checked={node.allowFiles} onChange={(e) => void patch({ allowFiles: e.target.checked })} />
            </Row>
          )}

          <Row label="Next rules">
            <RulesEditor
              value={node.nextRules}
              nodeOptions={nodeOptions.filter((o) => o.id !== node.id)}
              onChange={(rules) => void patch({ nextRules: rules })}
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


// ── One-line "what happens when sales rep clicks Generate" explainer ───────

function ProposalFlowHint({
  hasGammaTemplate,
  hasScaffold,
}: {
  hasGammaTemplate: boolean;
  hasScaffold: boolean;
}) {
  // Mirror the backend's decision tree (proposal-draft.service.ts:generate)
  // so admins can see the active path at a glance instead of guessing.
  let copy: React.ReactNode;
  if (hasScaffold) {
    copy = (
      <>
        <b>Scaffold mode (advanced):</b> proposals render from the locked
        markdown below — AI and Gamma are both bypassed.
      </>
    );
  } else if (hasGammaTemplate) {
    copy = (
      <>
        <b>Gamma mode:</b> each proposal will be Gamma adapting the linked
        template with the client&apos;s data. Sales reps just click <i>Generate</i>.
      </>
    );
  } else {
    copy = (
      <>
        <b>AI mode:</b> proposals are written by your configured AI provider.
        Add a Gamma template id above to inherit a polished deck design instead.
      </>
    );
  }
  return (
    <div style={{
      marginTop: 8,
      fontSize: 11.5,
      color: 'var(--fg-muted)',
      lineHeight: 1.5,
    }}>
      {copy}
    </div>
  );
}

// ── Proposal scaffold editor ───────────────────────────────────────────────

const SCAFFOLD_TOKENS: ReadonlyArray<{ token: string; description: string }> = [
  { token: 'client_name',      description: "Recipient's name (best-guess from email)." },
  { token: 'client_email',     description: "Recipient's email address." },
  { token: 'opportunity_name', description: 'Opportunity label set when issuing.' },
  { token: 'tenant_name',      description: 'Your workspace name.' },
  { token: 'service_line',     description: "Template's service line." },
  { token: 'template_name',    description: "Template's display name." },
  { token: 'price',            description: 'Final price with currency, e.g. "INR 250,000".' },
  { token: 'currency',         description: 'ISO currency code only.' },
  { token: 'date_today',       description: 'Today\'s date, formatted "27 Apr 2026".' },
  { token: 'scope_summary',    description: 'Bulleted client-confirmed answers.' },
  { token: 'line_items',       description: 'Bulleted priced line items from the quote.' },
];

const SCAFFOLD_PLACEHOLDER = `# Proposal — {{client_name}}

**Prepared for:** {{client_name}} ({{client_email}})
**Date:** {{date_today}}
**Investment:** {{price}}

## About {{tenant_name}}
We help teams ship secure software, faster. Our values: clarity over jargon,
fixed-fee engagements, and zero last-minute surprises.

## Scope of work
{{scope_summary}}

## Investment
{{line_items}}

**Total:** {{price}}

## Next steps
Reply to this email to accept and we'll kick off within 5 business days.`;

function ProposalScaffoldEditor({
  value,
  onSave,
}: {
  value: string;
  onSave(next: string): void;
}) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Reflect external updates (e.g. another edit landed via patch) into
  // the local draft only when we're not actively editing.
  useEffect(() => { setDraft(value); }, [value]);

  const dirty = draft !== value;

  function copyToken(token: string) {
    navigator.clipboard.writeText(`{{${token}}}`);
  }

  function save() {
    onSave(draft);
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 1500);
  }

  const isSet = value.trim().length > 0;

  return (
    <section className="card" style={{ marginTop: 28, padding: 0, overflow: 'hidden' }}>
      <header
        style={{
          padding: '14px 18px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 10, cursor: 'pointer', userSelect: 'none',
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.005em', display: 'flex', alignItems: 'center', gap: 8 }}>
            Advanced — lock exact text
            <span className="chip outline" style={{ fontSize: 10, padding: '0 6px' }}>Optional</span>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
            Most teams don&apos;t need this. Set a <b>Gamma template id</b> above and each
            proposal inherits your deck&apos;s design automatically. Use this only to override
            that and lock exact prose word-for-word.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {isSet && <span className="chip warn"><Icon.Lock size={10} /> Overrides Gamma</span>}
          <Icon.ChevronDown size={13} style={{
            color: 'var(--fg-subtle)',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform .2s',
          }} />
        </div>
      </header>

      {open && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid var(--divider)' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 240px', gap: 16, marginTop: 14, alignItems: 'start',
          }}>
            <div>
              <textarea
                className="input mono"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={SCAFFOLD_PLACEHOLDER}
                rows={18}
                style={{ width: '100%', fontSize: 12.5, lineHeight: 1.55, padding: 12 }}
                spellCheck={false}
              />
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 8, marginTop: 8,
              }}>
                <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                  {savedAt
                    ? <><Icon.Check size={10} /> Saved</>
                    : dirty
                      ? 'Unsaved changes'
                      : isSet
                        ? `${value.length.toLocaleString()} characters`
                        : 'No scaffold — proposals are AI-generated'}
                </span>
                <div style={{ display: 'flex', gap: 6 }}>
                  {dirty && (
                    <button onClick={() => setDraft(value)} className="btn sm ghost">
                      Discard
                    </button>
                  )}
                  {isSet && !dirty && (
                    <button
                      onClick={() => { setDraft(''); onSave(''); }}
                      className="btn sm ghost"
                      title="Remove the scaffold and revert to AI-generated proposals"
                    >
                      Clear
                    </button>
                  )}
                  <button onClick={save} disabled={!dirty} className="btn sm accent">
                    <Icon.Check size={11} /> Save
                  </button>
                </div>
              </div>
            </div>

            <aside style={{
              padding: 12,
              background: 'var(--bg-sunk)',
              borderRadius: 8,
              fontSize: 11.5,
            }}>
              <div style={{ fontWeight: 600, color: 'var(--fg)', marginBottom: 6 }}>
                Available merge tokens
              </div>
              <div style={{ color: 'var(--fg-muted)', marginBottom: 10, lineHeight: 1.4 }}>
                Click a token to copy it. Paste it into the scaffold; values are filled when a proposal is generated.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {SCAFFOLD_TOKENS.map((t) => (
                  <button
                    key={t.token}
                    type="button"
                    onClick={() => copyToken(t.token)}
                    title={t.description}
                    style={{
                      appearance: 'none', cursor: 'pointer', textAlign: 'left',
                      padding: '6px 8px', background: 'var(--bg)',
                      border: '1px solid var(--border)', borderRadius: 6,
                      fontFamily: 'var(--font-mono)', fontSize: 11.5,
                      color: 'var(--fg)',
                      transition: 'background .12s, border-color .12s',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--bg)'; }}
                  >
                    {`{{${t.token}}}`}
                  </button>
                ))}
              </div>
            </aside>
          </div>
        </div>
      )}
    </section>
  );
}
