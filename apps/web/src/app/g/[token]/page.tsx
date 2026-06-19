'use client';

/**
 * Client-facing gathering flow — port of prototype/client-form.jsx onto the
 * real /g/:token endpoint. The token in the URL is the only authority; no
 * login. State persists server-side so closing the tab and re-opening picks
 * up where the client left off.
 *
 * Layout: split view (left = section outline, right = current question card).
 * Sidebar groups top-level nodes by their section / loop divider, shows
 * per-group completion, and lets the responder click any group to jump
 * back to it. A Back button on the question card walks a local history
 * stack of visited (nodeId, iter) pairs — answers are never wiped on
 * back-nav, just re-entered if the responder edits.
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
import { downscaleImage, imageFromClipboard, isImageFile } from '@/lib/images';

type Answer = string | string[] | number | null;

// ── Outline derivation ─────────────────────────────────────────────────
// Walk the template's top-level nodes in `position` order and group them
// into sections. A `section` node OR a `loop` node starts a new group;
// every subsequent top-level node (until the next section/loop) joins
// the active group. Top-level nodes seen *before* any divider go into
// an implicit "Start" group so the sidebar isn't blank for them.

interface OutlineGroup {
  key: string;
  title: string;
  /** Singular iteration label for loops, e.g. "Web App". Used to render
   *  per-iteration sub-items as "Web App 1", "Web App 2", … */
  iterationLabel?: string;
  type: 'inline' | 'section' | 'loop';
  // Top-level node IDs whose answer counts toward this group's progress.
  // For loops, this is empty; iteration progress is computed from
  // loopAnswers instead.
  topLevelNodeIds: string[];
  // For loops only: the loop's id + body node ids (used to count
  // per-iteration completeness).
  loopId?: string;
  loopBodyNodeIds?: string[];
  // The node the sidebar will jump to when this group is clicked.
  jumpToNodeId: string;
}

function deriveOutline(nodes: TemplateNode[]): OutlineGroup[] {
  const top = nodes.filter((n) => !n.parentNodeId).slice().sort((a, b) => a.position - b.position);
  const bodyByLoop = new Map<string, TemplateNode[]>();
  for (const n of nodes) {
    if (!n.parentNodeId) continue;
    const list = bodyByLoop.get(n.parentNodeId) ?? [];
    list.push(n);
    bodyByLoop.set(n.parentNodeId, list);
  }
  for (const list of bodyByLoop.values()) list.sort((a, b) => a.position - b.position);

  const groups: OutlineGroup[] = [];
  let active: OutlineGroup | null = null;
  for (const n of top) {
    if (n.nodeType === 'loop') {
      const body = bodyByLoop.get(n.id) ?? [];
      const g: OutlineGroup = {
        key: `loop:${n.id}`,
        title: n.question,
        iterationLabel: n.loopConfig?.label ?? 'Item',
        type: 'loop',
        topLevelNodeIds: [],
        loopId: n.id,
        loopBodyNodeIds: body.map((b) => b.id),
        jumpToNodeId: body[0]?.id ?? n.id,
      };
      groups.push(g);
      active = null; // loops don't accumulate following top-level siblings
      continue;
    }
    if (n.nodeType === 'section') {
      const g: OutlineGroup = {
        key: `sec:${n.id}`,
        title: n.question,
        type: 'section',
        topLevelNodeIds: [n.id],
        jumpToNodeId: n.id,
      };
      groups.push(g);
      active = g;
      continue;
    }
    // Plain top-level node — append to active group if any, else start
    // an implicit "Start" group so it's reachable from the sidebar.
    if (!active || active.type === 'section') {
      if (active) {
        active.topLevelNodeIds.push(n.id);
        continue;
      }
      const g: OutlineGroup = {
        key: 'start',
        title: 'Start',
        type: 'inline',
        topLevelNodeIds: [n.id],
        jumpToNodeId: n.id,
      };
      groups.push(g);
      active = g;
      continue;
    }
    active.topLevelNodeIds.push(n.id);
  }
  return groups;
}

interface GroupProgress {
  completed: number;
  total: number;
  state: 'empty' | 'in_progress' | 'done';
}

function groupProgress(
  g: OutlineGroup,
  answers: Record<string, unknown>,
  loopAnswers: Record<string, Array<Record<string, unknown>>>,
  currentNodeId: string | null,
  currentLoopId: string | null,
): GroupProgress {
  if (g.type === 'loop' && g.loopId && g.loopBodyNodeIds) {
    const iters = loopAnswers[g.loopId] ?? [];
    const total = g.loopBodyNodeIds.length * Math.max(1, iters.length);
    let completed = 0;
    for (const it of iters) {
      for (const id of g.loopBodyNodeIds) {
        if (it && id in it) completed++;
      }
    }
    const state: GroupProgress['state'] =
      completed === 0 && currentLoopId !== g.loopId ? 'empty'
        : completed === total && total > 0 ? 'done'
          : 'in_progress';
    return { completed, total, state };
  }
  // Section / inline: count answered top-level node IDs.
  const ids = g.topLevelNodeIds.filter((id) => {
    // Section divider nodes don't capture answers; skip them in the count.
    return true;
  });
  let completed = 0;
  for (const id of ids) {
    if (id in answers) completed++;
  }
  const isCurrent = currentNodeId !== null && ids.includes(currentNodeId);
  const total = ids.length;
  const state: GroupProgress['state'] =
    completed === 0 && !isCurrent ? 'empty'
      : completed === total && total > 0 ? 'done'
        : 'in_progress';
  return { completed, total, state };
}

interface HistoryEntry {
  nodeId: string;
  iter: number;
}

interface IterationItem {
  iter: number;
  label: string;             // "Web App 1"
  completed: number;
  total: number;
  state: 'empty' | 'in_progress' | 'done';
  isCurrent: boolean;
  /** Per-question status within this iteration. Used by the sidebar to
   *  render a 3rd level of navigation — click any question to jump
   *  straight to it within this iteration's body, with the prior
   *  answer (if any) restored. */
  questions: Array<{
    nodeId: string;
    label: string;
    /** Full question text — used for the hover title so the responder
     *  can read it even when the sidebar trims the visible label. */
    fullLabel: string;
    answered: boolean;
    isCurrent: boolean;
  }>;
}

/** For a loop group, derive one item per iteration the responder has
 *  touched (or is currently on). Now also returns each iteration's
 *  body-question list so the sidebar can render a 3rd nav level. */
function loopIterations(
  g: OutlineGroup,
  loopAnswers: Record<string, Array<Record<string, unknown>>>,
  currentLoopId: string | null,
  currentIter: number,
  currentNodeId: string | null,
  bodyNodesById: Map<string, TemplateNode>,
): IterationItem[] {
  if (g.type !== 'loop' || !g.loopId || !g.loopBodyNodeIds) return [];
  const iters = loopAnswers[g.loopId] ?? [];
  const isCurrentLoop = currentLoopId === g.loopId;
  const maxIter = Math.max(iters.length, isCurrentLoop ? currentIter + 1 : 0);
  const out: IterationItem[] = [];
  for (let i = 0; i < maxIter; i++) {
    const ans = iters[i] ?? {};
    const completed = g.loopBodyNodeIds.filter((id) => id in ans).length;
    const total = g.loopBodyNodeIds.length;
    const isCurrent = isCurrentLoop && i === currentIter;
    const questions = g.loopBodyNodeIds.map((id) => {
      const node = bodyNodesById.get(id);
      const fullQuestion = node?.question ?? id;
      return {
        nodeId: id,
        label: shortLabel(fullQuestion),
        // Full text used as the title attribute so hover reveals the
        // whole question even when the sidebar trims it for layout.
        fullLabel: fullQuestion,
        answered: id in ans,
        isCurrent: isCurrent && currentNodeId === id,
      };
    });
    out.push({
      iter: i,
      label: `${g.iterationLabel ?? 'Item'} ${i + 1}`,
      completed,
      total,
      state:
        completed === 0 && !isCurrent ? 'empty'
          : completed === total && total > 0 ? 'done'
            : 'in_progress',
      isCurrent,
      questions,
    });
  }
  return out;
}

/** Trim a question to ~28 characters so sidebar question rows stay
 *  one-line. The full question still shows on the card. */
function shortLabel(s: string): string {
  const stripped = s.replace(/\s+/g, ' ').trim();
  if (stripped.length <= 32) return stripped;
  return stripped.slice(0, 30).trimEnd() + '…';
}

export default function GatheringFlowPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [state, setState] = useState<GatheringStateResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [answer, setAnswer] = useState<Answer>(null);
  // True when the current `answer` was pre-filled from extraction (cached
  // inferredEntities → matched to this node's binding.serviceLineSlug).
  // Lets the UI show a "Pre-filled from your document — review and edit"
  // hint so the responder doesn't accidentally rubber-stamp a wrong number.
  const [fromSuggestion, setFromSuggestion] = useState(false);
  // Confidence of the active suggestion (when fromSuggestion=true) so
  // the UI can render a "Strong / Approximate / Borderline" chip on
  // borderline pre-fills the responder shouldn't rubber-stamp.
  const [suggestionConfidence, setSuggestionConfidence] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  // History stack of visited (nodeId, iter) pairs — the Back button
  // pops the top entry and routes back to that node. Answers are NOT
  // wiped on back-nav; the responder sees their previous answer and
  // either confirms or edits it. Forward navigation re-pushes onto
  // this stack at every successful submit.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Which loop iterations the responder has expanded in the sidebar.
  // Key: `${loopId}:${iter}`. Auto-populated as iterations become
  // current; the responder can toggle others manually via the chevron.
  const [expandedIters, setExpandedIters] = useState<Set<string>>(new Set());
  // Local override for the cursor returned by the server. Lets us advance
  // the UI immediately after submitAnswer / loopStep without re-fetching
  // /state every step (which is more polite to the API + smoother UX).
  const [cursor, setCursor] = useState<{
    node: TemplateNode | null;
    loopContext: GatheringLoopContext | null;
    loopStep: GatheringLoopStep | null;
  }>({ node: null, loopContext: null, loopStep: null });

  function toggleIterExpanded(key: string) {
    setExpandedIters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

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
        // If no actual answer yet, fall back to the extraction-derived
        // suggestion (if the API surfaced one for this node). Tracks the
        // source so the UI can show a "review pre-filled value" hint.
        const suggestion = s.suggestedAnswers?.[s.currentNode.id];
        if (existing === undefined && suggestion !== undefined && suggestion !== null) {
          setAnswer(suggestion as Answer);
          setFromSuggestion(true);
          setSuggestionConfidence(s.suggestionConfidence?.[s.currentNode.id] ?? null);
        } else {
          setAnswer((existing as Answer) ?? null);
          setFromSuggestion(false);
          setSuggestionConfidence(null);
        }
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

  // Poll /state every 2s while extraction is in flight. Once all files
  // settle (ready or failed), polling stops and the form proceeds. The
  // poll is gentle — only fires when there's something to wait on.
  useEffect(() => {
    if (!state?.extraction) return;
    if (state.extraction.inFlightFiles === 0) return;
    const id = setInterval(() => {
      void reload();
    }, 2_000);
    return () => clearInterval(id);
  }, [state?.extraction?.inFlightFiles, reload]);

  // Quick-fill kickoff state. When the responder hasn't started the
  // form yet (zero answers) AND hasn't dismissed the upload prompt,
  // we offer the upload-first path before walking questions.
  const [quickFillDismissed, setQuickFillDismissed] = useState(false);
  const [quickFillBusy, setQuickFillBusy] = useState(false);
  const [quickFillToast, setQuickFillToast] = useState<string | null>(null);
  // True from the moment the responder uploads a Quick-fill doc until
  // the extraction-settled effect opens the Review modal. Distinguishes
  // "client just landed and there happen to be ready files" (don't
  // auto-open) from "client uploaded right now, parsing finished" (auto-
  // open Review so they see what we extracted instead of being dumped
  // on Q1).
  const [quickFillJustUploaded, setQuickFillJustUploaded] = useState(false);
  // Whether the review-summary overlay is open. The overlay shows every
  // template node with its current answer (real or pre-filled), grouped
  // by section + iteration, with a click-to-edit affordance per row and
  // a Submit button at the bottom for the "trust the doc, just submit"
  // flow.
  const [reviewOpen, setReviewOpen] = useState(false);

  // After Quick-fill upload + extraction settles, auto-open the Review
  // modal so the responder lands on "here's what we extracted, confirm
  // or edit" instead of being dropped onto Q1 of the form. Without this
  // the auto-promoted answers are buried — the responder has no signal
  // that the doc actually did anything.
  useEffect(() => {
    if (!quickFillJustUploaded) return;
    if (!state?.extraction) return;
    if (state.extraction.inFlightFiles > 0) return;
    if (state.extraction.totalFiles === 0) return; // no upload happened yet
    setQuickFillJustUploaded(false);
    setReviewOpen(true);
  }, [quickFillJustUploaded, state?.extraction?.inFlightFiles, state?.extraction?.totalFiles]);

  /** Upload a scoping doc at the very start of the form. The file is
   *  recorded engagement-level with `kind='scoping_doc'` and `nodeId=null`
   *  so it doesn't appear in any per-question file list. Extraction runs
   *  server-side; the polling effect takes over until everything settles. */
  async function quickFillUpload(rawFile: File) {
    setQuickFillBusy(true);
    setErr(null);
    try {
      // Shrink + normalise screenshots before upload (keeps vision-token
      // cost + upload time low; converts HEIC/BMP to PNG). Docs pass through.
      const file = isImageFile(rawFile) ? await downscaleImage(rawFile) : rawFile;
      const url = await gathering.scopingDocUploadUrl(token, {
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
      setQuickFillToast(`Parsing ${file.name}…`);
      // Mark this session as having just uploaded — once extraction
      // settles, the effect below opens the Review modal so the
      // responder lands on "here's what we extracted" instead of being
      // dumped on Q1 of the form.
      setQuickFillJustUploaded(true);
      await reload();
    } catch (e) {
      setErr(String(e));
    } finally {
      setQuickFillBusy(false);
    }
  }

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
    setFromSuggestion(false);
    setStepIdx((i) => i + 1);
  }

  /**
   * Jump the UI to a specific node by id without going through the
   * server's cursor walk. Used by sidebar clicks and the Back button.
   * The server still owns answer persistence — when the responder hits
   * Continue from the jumped-to node, that answer is POSTed and the
   * server walks `nextRules` forward from there as usual. Their prior
   * answers downstream are unchanged.
   */
  function jumpToNode(nodeId: string, iter = 0) {
    if (!state) return;
    const target = state.templateNodes?.find((n) => n.id === nodeId);
    if (!target) return;
    // Reconstruct loopContext if the target lives inside a loop body.
    let loopContext: GatheringLoopContext | null = null;
    if (target.parentNodeId) {
      const loop = state.templateNodes?.find((n) => n.id === target.parentNodeId);
      if (loop) {
        loopContext = {
          loopId: loop.id,
          label: loop.loopConfig?.label ?? 'Item',
          iter,
        };
      }
    }
    setCursor({ node: target, loopContext, loopStep: null });
    // Restore the previously-submitted answer for this (node, iter) so
    // the responder sees what they had before.
    let priorAnswer: Answer | undefined;
    if (target.parentNodeId) {
      priorAnswer = state.loopAnswers?.[target.parentNodeId]?.[iter]?.[target.id] as Answer | undefined;
    } else {
      priorAnswer = state.answers?.[target.id] as Answer | undefined;
    }
    setAnswer((priorAnswer as Answer) ?? null);
    setFromSuggestion(false);
  }

  /** Pop the most recent (nodeId, iter) entry off the history stack and
   *  route back to it. No-op if the stack is empty (we're at the start). */
  function goBack() {
    if (history.length === 0) return;
    const previous = history[history.length - 1]!;
    setHistory((h) => h.slice(0, -1));
    jumpToNode(previous.nodeId, previous.iter);
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
      // Push current cursor onto history so Back can return here.
      const currentIter = cursor.loopContext?.iter ?? 0;
      setHistory((h) => [...h, { nodeId: node.id, iter: currentIter }]);
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

  async function uploadFile(rawFile: File) {
    setBusy(true);
    setErr(null);
    try {
      const file = isImageFile(rawFile) ? await downscaleImage(rawFile) : rawFile;
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
  const loopAnsweredCount = Object.values(state.loopAnswers).reduce(
    (sum, arr) => sum + arr.reduce((s2, dict) => s2 + Object.keys(dict).length, 0),
    0,
  );
  const totalAllAnswers = totalAnswered + loopAnsweredCount;
  const segs = Math.max(totalAnswered + 1, 5);

  // Outline derivation runs whenever templateNodes is available (older
  // API builds may omit it; fall back to flat layout if so).
  const outline: OutlineGroup[] = state.templateNodes ? deriveOutline(state.templateNodes) : [];
  const currentLoopId = cursor.loopContext?.loopId ?? null;
  const currentNodeId = cursor.node?.id ?? null;
  // Lookup so the sidebar can render question labels per iteration.
  const bodyNodesById = new Map<string, TemplateNode>(
    (state.templateNodes ?? []).map((n) => [n.id, n] as const),
  );

  // Quick-fill / extraction-progress flags.
  const totalFiles = state.extraction?.totalFiles ?? 0;
  const inFlightFiles = state.extraction?.inFlightFiles ?? 0;
  const quickFillEligible =
    totalAllAnswers === 0 &&
    !quickFillDismissed &&
    totalFiles === 0;
  const extractionInProgress = inFlightFiles > 0;

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

      <div className="client-frame">
        {outline.length > 0 && (
          <aside className="client-outline">
            <div className="client-outline-hdr">Sections</div>
            <ul className="client-outline-list">
              {outline.map((g) => {
                const p = groupProgress(g, state.answers, state.loopAnswers, currentNodeId, currentLoopId);
                const isCurrent = g.type === 'loop'
                  ? currentLoopId === g.loopId
                  : g.topLevelNodeIds.includes(currentNodeId ?? '');
                const iters =
                  g.type === 'loop'
                    ? loopIterations(
                        g,
                        state.loopAnswers,
                        currentLoopId,
                        cursor.loopContext?.iter ?? 0,
                        currentNodeId,
                        bodyNodesById,
                      )
                    : [];
                return (
                  <li key={g.key}>
                    <button
                      type="button"
                      className={
                        'client-outline-item' +
                        (isCurrent ? ' current' : '') +
                        (p.state === 'done' ? ' done' : '') +
                        (p.state === 'in_progress' && !isCurrent ? ' partial' : '')
                      }
                      onClick={() => jumpToNode(g.jumpToNodeId)}
                      disabled={busy}
                    >
                      <span className="dot" aria-hidden>
                        {p.state === 'done' ? <Icon.Check size={9} /> : isCurrent ? '▸' : ''}
                      </span>
                      <span className="title">{g.title}</span>
                      {p.total > 0 && (
                        <span className="count">{p.completed}/{p.total}</span>
                      )}
                    </button>
                    {iters.length > 0 && (
                      <ul className="client-outline-sub">
                        {iters.map((it) => {
                          const iterKey = `${g.key}:${it.iter}`;
                          const expanded = expandedIters.has(iterKey) || it.isCurrent;
                          return (
                            <li key={iterKey}>
                              <div className="client-outline-iter-row">
                                <button
                                  type="button"
                                  className="client-outline-iter-toggle"
                                  onClick={() => toggleIterExpanded(iterKey)}
                                  aria-label={expanded ? 'Collapse' : 'Expand'}
                                  title={expanded ? 'Hide questions' : 'Show questions'}
                                >
                                  <span className={'caret' + (expanded ? ' open' : '')}>›</span>
                                </button>
                                <button
                                  type="button"
                                  className={
                                    'client-outline-item sub' +
                                    (it.isCurrent ? ' current' : '') +
                                    (it.state === 'done' ? ' done' : '') +
                                    (it.state === 'in_progress' && !it.isCurrent ? ' partial' : '')
                                  }
                                  onClick={() => {
                                    if (g.loopBodyNodeIds && g.loopBodyNodeIds[0]) {
                                      jumpToNode(g.loopBodyNodeIds[0], it.iter);
                                    }
                                  }}
                                  disabled={busy}
                                >
                                  <span className="dot" aria-hidden>
                                    {it.state === 'done' ? <Icon.Check size={9} /> : it.isCurrent ? '▸' : ''}
                                  </span>
                                  <span className="title">{it.label}</span>
                                  <span className="count">{it.completed}/{it.total}</span>
                                </button>
                                <button
                                  type="button"
                                  className="client-outline-iter-remove"
                                  onClick={async () => {
                                    if (!g.loopId) return;
                                    if (!confirm(
                                      `Remove ${it.label}? This deletes its ${it.completed} answer${it.completed === 1 ? '' : 's'}.`,
                                    )) return;
                                    setBusy(true);
                                    try {
                                      await gathering.removeIteration(token, {
                                        loopId: g.loopId,
                                        iterIndex: it.iter,
                                      });
                                      await reload();
                                    } catch (e) {
                                      setErr(String(e));
                                    } finally {
                                      setBusy(false);
                                    }
                                  }}
                                  disabled={busy}
                                  title={`Remove ${it.label}`}
                                  aria-label={`Remove ${it.label}`}
                                >
                                  <Icon.X size={11} />
                                </button>
                              </div>
                              {expanded && it.questions.length > 0 && (
                                <ul className="client-outline-questions">
                                  {it.questions.map((q) => (
                                    <li key={`${iterKey}:${q.nodeId}`}>
                                      <button
                                        type="button"
                                        className={
                                          'client-outline-item q' +
                                          (q.isCurrent ? ' current' : '') +
                                          (q.answered ? ' done' : '')
                                        }
                                        onClick={() => jumpToNode(q.nodeId, it.iter)}
                                        disabled={busy}
                                        title={q.fullLabel}
                                      >
                                        <span className="dot" aria-hidden>
                                          {q.answered ? <Icon.Check size={8} /> : q.isCurrent ? '▸' : '·'}
                                        </span>
                                        <span className="title">{q.label}</span>
                                      </button>
                                    </li>
                                  ))}
                                </ul>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            <div className="client-outline-foot">
              <span><Icon.Shield size={10} /> {totalAllAnswers} answered</span>
              <button
                className="client-outline-review"
                onClick={() => setReviewOpen(true)}
                disabled={busy}
              >
                Review all <Icon.ArrowRight size={10} />
              </button>
            </div>
          </aside>
        )}

      {quickFillEligible ? (
        <QuickFillCard
          busy={quickFillBusy}
          onUpload={quickFillUpload}
          onSkip={() => setQuickFillDismissed(true)}
        />
      ) : extractionInProgress ? (
        <ExtractionProgressCard
          inFlight={inFlightFiles}
          total={totalFiles}
          message={quickFillToast}
          onSkip={() => setQuickFillDismissed(true)}
        />
      ) : (
      <div className="client-card">

        <div className="client-body">
          {/* Breadcrumb stitches together "Section › Iteration › Question 3 of 5" so the
           *  responder always knows where they are. Replaces the redundant
           *  iteration badge + sequential "Question 20" label that was
           *  visually noisy and didn't convey position within the iteration. */}
          {(() => {
            const crumbs: string[] = [];
            const breadcrumbGroup = outline.find((g) =>
              g.type === 'loop' ? g.loopId === currentLoopId : g.topLevelNodeIds.includes(node.id),
            );
            if (breadcrumbGroup) crumbs.push(breadcrumbGroup.title);
            if (loopContext) {
              crumbs.push(`${loopContext.label} ${loopContext.iter + 1}`);
            }
            // Within-iteration question position: "Question 3 of 5".
            if (loopContext && breadcrumbGroup?.loopBodyNodeIds) {
              const idx = breadcrumbGroup.loopBodyNodeIds.indexOf(node.id);
              if (idx >= 0) {
                crumbs.push(`Question ${idx + 1} of ${breadcrumbGroup.loopBodyNodeIds.length}`);
              }
            } else if (breadcrumbGroup) {
              const idx = breadcrumbGroup.topLevelNodeIds.indexOf(node.id);
              if (idx >= 0 && breadcrumbGroup.topLevelNodeIds.length > 1) {
                crumbs.push(`${idx + 1} of ${breadcrumbGroup.topLevelNodeIds.length}`);
              }
            }
            return crumbs.length > 0 ? (
              <div className="client-crumb">
                {crumbs.map((c, i) => (
                  <span key={i}>
                    {i > 0 && <span className="sep">›</span>}
                    <span className={i === crumbs.length - 1 ? 'now' : ''}>{c}</span>
                  </span>
                ))}
                {isSection && <span className="badge">Section</span>}
                {isOptional && !isSection && <span className="badge muted">Optional</span>}
              </div>
            ) : null;
          })()}
          <div className="client-title">{node.question}</div>

          {node.helpText && (
            <p style={{ marginTop: 10, fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {node.helpText}
            </p>
          )}

          {!isSection && (
            <NodeInput
              node={node as TemplateNode}
              value={answer}
              onChange={(v) => {
                setAnswer(v);
                if (fromSuggestion) setFromSuggestion(false);
              }}
            />
          )}
          {fromSuggestion && !isSection && (() => {
            // Confidence buckets — same thresholds the API uses for
            // promotion (≥0.6 minimum, with sub-bands for "Strong /
            // Approximate / Borderline" so the responder can spot
            // which suggestions to scrutinise).
            const c = suggestionConfidence ?? 0;
            const tier =
              c >= 0.85 ? { label: 'Strong match', cls: 'strong' }
                : c >= 0.7 ? { label: 'Approximate', cls: 'approx' }
                  : { label: 'Borderline', cls: 'borderline' };
            return (
              <div className="qf-hint">
                <span className={`qf-conf-chip ${tier.cls}`}>{tier.label}</span>
                <span>Pre-filled from your uploaded document. Review and edit if it&apos;s wrong.</span>
              </div>
            );
          })()}

          {allowFiles && !isSection && <FileSection node={node as TemplateNode} state={state} onUpload={uploadFile} />}
        </div>

        <div className="client-foot">
          <span className="hint">
            <Icon.Shield size={12} /> End-to-end encrypted · single-use link
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn ghost"
              disabled={busy || history.length === 0}
              onClick={goBack}
              title={history.length === 0 ? 'Nothing to go back to' : 'Go back to the previous question'}
            >
              <Icon.ArrowLeft size={12} /> Back
            </button>
            <button className="btn accent" disabled={busy || !canAdvance} onClick={next}>
              {busy ? <span className="spin" /> : <><Icon.ArrowRight size={12} />Continue</>}
            </button>
          </div>
        </div>
      </div>
      )}
      </div>{/* /.client-frame */}

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

      {reviewOpen && (
        <ReviewModal
          state={state}
          outline={outline}
          bodyNodesById={bodyNodesById}
          busy={busy}
          onClose={() => setReviewOpen(false)}
          onJump={(nodeId, iter) => {
            setReviewOpen(false);
            jumpToNode(nodeId, iter);
          }}
          onSubmit={async () => {
            setBusy(true);
            setErr(null);
            try {
              const sub = await gathering.submit(token);
              if (sub.status === 'submitted') setDone(true);
              setReviewOpen(false);
            } catch (e) {
              setErr(String(e));
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
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

/**
 * Review-summary overlay — every answered + unanswered question grouped
 * by section / iteration. Lets the responder skim everything that's been
 * pre-filled, click any row to edit, or one-click Submit if it all looks
 * right. The "trust the doc, just submit" path the user asked for.
 */
function ReviewModal({
  state,
  outline,
  bodyNodesById,
  busy,
  onClose,
  onJump,
  onSubmit,
}: {
  state: GatheringStateResponse;
  outline: OutlineGroup[];
  bodyNodesById: Map<string, TemplateNode>;
  busy: boolean;
  onClose: () => void;
  onJump: (nodeId: string, iter: number) => void;
  onSubmit: () => Promise<void>;
}) {
  // Every renderable row: section/iteration header + question rows.
  type Row =
    | { kind: 'header'; key: string; title: string; depth: number }
    | { kind: 'question'; key: string; nodeId: string; iter: number; label: string; value: unknown; suggested: boolean; confidence: number | null };

  const rows: Row[] = [];
  let totalAnswered = 0;
  let totalQuestions = 0;
  for (const g of outline) {
    if (g.type === 'loop' && g.loopId && g.loopBodyNodeIds) {
      const iters = state.loopAnswers[g.loopId] ?? [];
      // If no iterations exist, still show a placeholder row for the loop.
      if (iters.length === 0) {
        rows.push({ kind: 'header', key: g.key, title: g.title, depth: 0 });
        rows.push({ kind: 'header', key: `${g.key}:none`, title: '— No items yet —', depth: 1 });
        continue;
      }
      rows.push({ kind: 'header', key: g.key, title: g.title, depth: 0 });
      for (let iter = 0; iter < iters.length; iter++) {
        rows.push({
          kind: 'header',
          key: `${g.key}:i${iter}`,
          title: `${g.iterationLabel ?? 'Item'} ${iter + 1}`,
          depth: 1,
        });
        for (const id of g.loopBodyNodeIds) {
          const node = bodyNodesById.get(id);
          const value = iters[iter]?.[id];
          const suggested = value === undefined && state.suggestedAnswers?.[id] !== undefined;
          const conf = suggested ? state.suggestionConfidence?.[id] ?? null : null;
          rows.push({
            kind: 'question',
            key: `${id}:${iter}`,
            nodeId: id,
            iter,
            label: node?.question ?? id,
            value: value ?? state.suggestedAnswers?.[id],
            suggested,
            confidence: conf,
          });
          totalQuestions++;
          if (value !== undefined) totalAnswered++;
        }
      }
    } else {
      // Section / inline group of top-level nodes.
      rows.push({ kind: 'header', key: g.key, title: g.title, depth: 0 });
      for (const id of g.topLevelNodeIds) {
        const node = bodyNodesById.get(id);
        if (!node) continue;
        if (node.nodeType === 'section') continue; // dividers don't capture answers
        const value = state.answers[id];
        const suggested = value === undefined && state.suggestedAnswers?.[id] !== undefined;
        const conf = suggested ? state.suggestionConfidence?.[id] ?? null : null;
        rows.push({
          kind: 'question',
          key: `${id}:0`,
          nodeId: id,
          iter: 0,
          label: node.question,
          value: value ?? state.suggestedAnswers?.[id],
          suggested,
          confidence: conf,
        });
        totalQuestions++;
        if (value !== undefined) totalAnswered++;
      }
    }
  }

  // Per-section + per-loop summary chips so the responder sees at a
  // glance what the document contributed before scrolling through every
  // row. Shown beneath the title only when there's at least one chip
  // worth showing.
  const summaryChips = outline.flatMap((g) => {
    if (g.type === 'loop' && g.loopId) {
      const iters = state.loopAnswers[g.loopId] ?? [];
      if (iters.length === 0) return [];
      return [{ key: g.key, label: g.title, count: iters.length, isLoop: true }];
    }
    const filled = g.topLevelNodeIds.filter((id) => state.answers[id] !== undefined);
    if (filled.length === 0) return [];
    return [{ key: g.key, label: g.title, count: filled.length, isLoop: false }];
  });
  const totalSuggestions = Object.keys(state.suggestedAnswers ?? {}).length;

  return (
    <div className="client-modal-backdrop" onClick={onClose}>
      <div className="client-modal" onClick={(e) => e.stopPropagation()}>
        <div className="client-modal-hdr">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="client-modal-title">Review your answers</div>
            <div className="client-modal-sub">
              {totalAnswered} of {totalQuestions} answered.
              {totalSuggestions > 0 && (
                <> {totalSuggestions} pre-filled from your document — confidence chip per row.</>
              )}
            </div>
            {summaryChips.length > 0 && (
              <div className="rev-summary-chips">
                {summaryChips.map((c) => (
                  <span key={c.key} className="rev-summary-chip">
                    {c.label}
                    <span className="rev-summary-count">
                      {c.isLoop ? `${c.count} ${c.count === 1 ? 'item' : 'items'}` : `${c.count} answered`}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
          <button className="btn ghost sm" onClick={onClose}>Close</button>
        </div>
        <div className="client-modal-body">
          {/*
            Scope Summary — what the LLM mapper read from uploaded
            documents, in plain English. Surfaces at the TOP so the
            client sees "we read 1 web app + 1 API + 2 roles" before
            scrolling through any blank form rows. Without this, a
            doc-driven engagement looks like an empty form even when
            the LLM correctly priced 3 entities server-side.

            Only renders when there's something to show — empty
            scopeSummary or no uploaded files → falls back to the
            normal form-row rendering below.
          */}
          {state.scopeSummary && !state.scopeSummary.isEmpty && (
            <ScopeSummaryBlock
              summary={state.scopeSummary}
              unprojected={state.unprojectedEntities ?? []}
            />
          )}
          {rows.map((r) => {
            if (r.kind === 'header') {
              return (
                <div key={r.key} className={'rev-hdr depth-' + r.depth}>
                  {r.title}
                </div>
              );
            }
            const tier =
              r.confidence == null ? null
                : r.confidence >= 0.85 ? 'strong'
                  : r.confidence >= 0.7 ? 'approx'
                    : 'borderline';
            return (
              <button
                key={r.key}
                className="rev-row"
                onClick={() => onJump(r.nodeId, r.iter)}
                disabled={busy}
              >
                <span className="rev-label">{r.label}</span>
                <span className={'rev-value' + (r.value === undefined ? ' empty' : '')}>
                  {r.value === undefined ? '—' : String(r.value)}
                  {r.suggested && tier && (
                    <span className={`qf-conf-chip ${tier}`} style={{ marginLeft: 8 }}>{
                      tier === 'strong' ? 'Strong'
                        : tier === 'approx' ? 'Approx'
                          : 'Borderline'
                    }</span>
                  )}
                </span>
                <Icon.ArrowRight size={11} />
              </button>
            );
          })}
        </div>
        <div className="client-modal-foot">
          <span className="hint">
            <Icon.Shield size={11} /> Submitting locks the link. You won&apos;t be able to edit after.
          </span>
          <button className="btn accent" onClick={() => void onSubmit()} disabled={busy}>
            {busy ? <span className="spin" /> : <><Icon.Check size={12} /> Submit</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Plain-English summary of what the LLM mapper extracted from uploaded
 * documents. Lives at the TOP of the Review modal so the client sees
 * "we read 1 web app + 1 API + 2 roles" before any blank form rows.
 *
 * Renders three things:
 *  1. A header banner with totals + source files.
 *  2. One block per domain group (Web Apps, APIs, Network, etc.) with
 *     the items and their bullet drivers.
 *  3. (Optional) An "unprojected" section listing entities the form
 *     can't auto-fill — surfacing the silent-data-loss case so the rep
 *     knows to follow up manually.
 */
function ScopeSummaryBlock({
  summary,
  unprojected,
}: {
  summary: NonNullable<GatheringStateResponse['scopeSummary']>;
  unprojected: NonNullable<GatheringStateResponse['unprojectedEntities']>;
}) {
  const allFiles = new Set<string>();
  for (const g of summary.groups) {
    for (const it of g.items) {
      for (const f of it.sourceFiles) allFiles.add(f);
    }
  }
  return (
    <div className="rev-scope-summary">
      <div className="rev-scope-hdr">
        <span className="rev-scope-icon" aria-hidden>
          <Icon.Sparkle size={12} />
        </span>
        <div className="rev-scope-hdr-text">
          <div className="rev-scope-title">From your document</div>
          <div className="rev-scope-sub">
            We read {summary.totalItems} {summary.totalItems === 1 ? 'item' : 'items'}
            {allFiles.size > 0 && (
              <> from {allFiles.size === 1 ? <strong>{[...allFiles][0]}</strong> : `${allFiles.size} files`}</>
            )}
            . Confirm below or open any row to edit.
          </div>
        </div>
      </div>
      <div className="rev-scope-groups">
        {summary.groups.map((g) => (
          <div key={g.domain + ':' + g.label} className="rev-scope-group">
            <div className="rev-scope-group-label">{g.label}</div>
            <div className="rev-scope-items">
              {g.items.map((item, idx) => {
                const tier =
                  item.confidence >= 0.85 ? 'strong'
                    : item.confidence >= 0.7 ? 'approx'
                      : 'borderline';
                return (
                  <div key={idx} className="rev-scope-item">
                    <div className="rev-scope-item-hdr">
                      <span className="rev-scope-item-title">{item.title}</span>
                      <span className={`qf-conf-chip ${tier}`}>
                        {tier === 'strong' ? 'Strong' : tier === 'approx' ? 'Approx' : 'Borderline'}
                      </span>
                    </div>
                    {item.subtitle && (
                      <div className="rev-scope-item-sub">{item.subtitle}</div>
                    )}
                    <ul className="rev-scope-bullets">
                      {item.bullets.map((b, bi) => (
                        <li key={bi}>{b}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      {unprojected.length > 0 && (
        <div className="rev-scope-unprojected">
          <div className="rev-scope-unprojected-label">
            <Icon.Shield size={11} /> Found but not in your form
          </div>
          <div className="rev-scope-unprojected-sub">
            We extracted these from your document but the questionnaire has no place
            to put them. They&apos;ll still be priced — please confirm with your account team.
          </div>
          <ul className="rev-scope-unprojected-list">
            {unprojected.map((u) => (
              <li key={u.serviceLineSlug}>
                <span className="rev-scope-unprojected-title">{u.displayName}</span>
                <span className="rev-scope-unprojected-scope"> · {u.scopeValue}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Upload-first opening screen — shown when the responder lands on a
 * fresh form with zero answers and zero uploaded files. Lets them drop
 * a scoping doc and have us pre-fill everything we can extract, instead
 * of walking 30+ questions cold. Skipping falls back to the manual flow.
 */
function QuickFillCard({
  busy,
  onUpload,
  onSkip,
}: {
  busy: boolean;
  onUpload: (file: File) => Promise<void>;
  onSkip: () => void;
}) {
  const [drag, setDrag] = useState(false);

  // Paste-a-screenshot: catch Cmd/Ctrl+V on the quick-fill screen and
  // upload the pasted image, same as dropping a file.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      if (busy) return;
      const img = imageFromClipboard(e);
      if (!img) return;
      e.preventDefault();
      void onUpload(img);
    }
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [busy, onUpload]);

  return (
    <div className="client-card client-quickfill">
      <div className="client-body" style={{ padding: '52px 56px' }}>
        <div className="qf-icon" aria-hidden>
          <Icon.Sparkle size={20} />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 16, lineHeight: 1.25 }}>
          Have a scoping sheet or screenshot? Drop it in.
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginTop: 8, lineHeight: 1.55, maxWidth: 540 }}>
          We&apos;ll read your Excel / PDF / screenshot and pre-fill the form so you only review what
          we found — no need to retype questions you&apos;ve already documented elsewhere.
        </p>
        <label
          className={'qf-drop' + (drag ? ' active' : '')}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void onUpload(f);
          }}
        >
          <input
            type="file"
            accept=".xlsx,.xls,.csv,.pdf,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/pdf,image/*"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onUpload(f);
            }}
          />
          {busy ? (
            <span className="hint"><span className="spin" /> Uploading…</span>
          ) : (
            <>
              <span className="qf-drop-title"><Icon.Plus size={14} /> Drop file, click to choose, or paste a screenshot</span>
              <span className="hint">Excel / CSV / PDF / image · up to 50 MB</span>
            </>
          )}
        </label>
        <div className="client-foot" style={{ marginTop: 24, padding: 0, background: 'transparent', border: 'none' }}>
          <span className="hint">
            <Icon.Shield size={12} /> Encrypted in transit · processed only for this scoping
          </span>
          <button className="btn ghost" onClick={onSkip} disabled={busy}>
            I&apos;ll fill it manually <Icon.ArrowRight size={12} />
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Inline progress shown while extraction is in flight after the
 * responder uploaded a doc via Quick-fill. Polling drives the counts;
 * once `inFlight === 0` the parent flips back to the standard form
 * (which now has pre-filled answers + auto-created iterations).
 */
function ExtractionProgressCard({
  inFlight,
  total,
  message,
  onSkip,
}: {
  inFlight: number;
  total: number;
  message: string | null;
  onSkip: () => void;
}) {
  return (
    <div className="client-card client-quickfill">
      <div className="client-body" style={{ padding: '52px 56px' }}>
        <div className="qf-icon" aria-hidden>
          <span className="spin" style={{ width: 20, height: 20 }} />
        </div>
        <h2 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 16, lineHeight: 1.25 }}>
          Parsing your scoping document…
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 14, marginTop: 8, lineHeight: 1.55, maxWidth: 540 }}>
          {message ?? `Reading ${inFlight} of ${total} file${total === 1 ? '' : 's'}.`} Usually 5–15 seconds.
          You can skip ahead to start filling the form manually if you prefer.
        </p>
        <div className="client-foot" style={{ marginTop: 28, padding: 0, background: 'transparent', border: 'none' }}>
          <span className="hint">
            <Icon.Shield size={12} /> {total > 0 ? `${total} file${total === 1 ? '' : 's'} uploaded` : ''}
          </span>
          <button className="btn ghost" onClick={onSkip}>
            Start filling now <Icon.ArrowRight size={12} />
          </button>
        </div>
      </div>
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
