/**
 * Pure decision-tree engine.
 *
 * Lives in @rhud/shared so both the API (publish-time validation, future
 * server-side traversal) and the web client (live preview) use the exact
 * same logic. Zero runtime dependencies beyond TS types from this same
 * package — drop it into either Node or browser.
 *
 * Design doc §3.1: "next_rules evaluate on the answer and resolve to the next
 * node_id or END." The engine here is that evaluator.
 */

import type {
  NextRuleOp,
  NodeType,
  TemplateNode,
  TemplateWithNodes,
} from './templates.js';
import { END_NODE } from './templates.js';

export type Answer =
  | string
  | string[]
  | number
  | null;

export type AnswerMap = Record<string, Answer>;

export type ResolveResult =
  | { kind: 'next'; nodeId: string }
  | { kind: 'end' }
  | { kind: 'invalid'; reason: string };

// ── Predicate evaluation ─────────────────────────────────────────────────────

function evalPredicate(op: NextRuleOp, answer: Answer, value: unknown): boolean {
  switch (op) {
    case 'always':
      return true;
    case 'eq':
      return answer === value;
    case 'neq':
      return answer !== value;
    case 'in':
      return Array.isArray(value) && (value as unknown[]).includes(answer as unknown);
    case 'includes':
      return Array.isArray(answer) && (answer as unknown[]).includes(value as unknown);
    case 'gt':
      return typeof answer === 'number' && typeof value === 'number' && answer > value;
    case 'lt':
      return typeof answer === 'number' && typeof value === 'number' && answer < value;
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      return false;
    }
  }
}

/**
 * Resolve the next node given an answer. Rules are evaluated in array order,
 * first match wins. If no rule matches, the result is `invalid` — templates
 * must explicitly include a default (`{when: {op: 'always'}, goto: ...}`)
 * for fallback behavior. Strict on purpose: silent fall-through in decision
 * trees is one of the bugs that only surfaces in front of a paying client.
 */
export function resolveNext(node: TemplateNode, answer: Answer): ResolveResult {
  for (const rule of node.nextRules) {
    if (evalPredicate(rule.when.op, answer, rule.when.value)) {
      if (rule.goto === END_NODE) return { kind: 'end' };
      return { kind: 'next', nodeId: rule.goto };
    }
  }
  return {
    kind: 'invalid',
    reason: `no next_rule matched for answer on node ${node.id}`,
  };
}

// ── Answer shape validation ──────────────────────────────────────────────────

export function validateAnswerShape(
  nodeType: NodeType,
  answer: Answer,
): { ok: true } | { ok: false; reason: string } {
  switch (nodeType) {
    case 'single_select':
    case 'short_text':
    case 'long_text':
      return typeof answer === 'string'
        ? { ok: true }
        : { ok: false, reason: 'expected string answer' };
    case 'multi_select':
      return Array.isArray(answer) && answer.every((x) => typeof x === 'string')
        ? { ok: true }
        : { ok: false, reason: 'expected string[] answer' };
    case 'number':
      return typeof answer === 'number' && Number.isFinite(answer)
        ? { ok: true }
        : { ok: false, reason: 'expected finite numeric answer' };
    case 'file_upload':
      return answer === null || answer === ''
        ? { ok: true }
        : { ok: false, reason: 'file_upload nodes do not take an inline answer' };
    case 'section':
      // Section nodes are pure dividers: no answer captured. The runtime
      // sends null (or omits the call entirely) when advancing past one.
      return answer == null || answer === ''
        ? { ok: true }
        : { ok: false, reason: 'section nodes do not take an answer' };
    case 'loop':
      // Loop nodes are containers — they delegate answers to body
      // children, never capture a value of their own.
      return answer == null || answer === ''
        ? { ok: true }
        : { ok: false, reason: 'loop nodes do not take an answer' };
    default: {
      const _exhaustive: never = nodeType;
      void _exhaustive;
      return { ok: false, reason: 'unknown node type' };
    }
  }
}

// ── Template-level validation ────────────────────────────────────────────────

export interface ValidationIssue {
  code:
    | 'no_root'
    | 'no_nodes'
    | 'root_not_in_nodes'
    | 'dangling_goto'
    | 'empty_rules'
    | 'select_without_options'
    | 'unreachable_node';
  message: string;
  nodeId?: string;
}

export function validateTemplate(template: TemplateWithNodes): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (template.nodes.length === 0) {
    issues.push({ code: 'no_nodes', message: 'template has no nodes' });
    return issues;
  }

  if (!template.rootNodeId) {
    issues.push({ code: 'no_root', message: 'template has no rootNodeId set' });
  }

  const byId = new Map(template.nodes.map((n) => [n.id, n]));

  if (template.rootNodeId && !byId.has(template.rootNodeId)) {
    issues.push({
      code: 'root_not_in_nodes',
      message: `rootNodeId ${template.rootNodeId} does not exist in nodes`,
    });
  }

  for (const node of template.nodes) {
    if (
      (node.nodeType === 'single_select' || node.nodeType === 'multi_select') &&
      (!node.options || node.options.length === 0)
    ) {
      issues.push({
        code: 'select_without_options',
        message: `${node.nodeType} node has no options`,
        nodeId: node.id,
      });
    }

    if (node.nextRules.length === 0) {
      issues.push({
        code: 'empty_rules',
        message:
          'node has no nextRules — it can never transition. Use [{when:{op:"always"},goto:"END"}] for a terminal node.',
        nodeId: node.id,
      });
      continue;
    }

    for (const rule of node.nextRules) {
      if (rule.goto === END_NODE) continue;
      if (!byId.has(rule.goto)) {
        issues.push({
          code: 'dangling_goto',
          message: `nextRule goto references unknown node ${rule.goto}`,
          nodeId: node.id,
        });
      }
    }
  }

  if (template.rootNodeId && byId.has(template.rootNodeId)) {
    const reachable = reachableFrom(template.rootNodeId, byId);
    for (const node of template.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({
          code: 'unreachable_node',
          message: 'node is not reachable from the root',
          nodeId: node.id,
        });
      }
    }
  }

  return issues;
}

function reachableFrom(rootId: string, byId: Map<string, TemplateNode>): Set<string> {
  // Reachability follows nextRules + loop-body containment: when a loop is
  // reachable, every node whose parentNodeId points at it is reachable too,
  // and those body nodes' nextRules continue the trail (within the body).
  const childrenByParent = new Map<string, TemplateNode[]>();
  for (const n of byId.values()) {
    if (!n.parentNodeId) continue;
    const list = childrenByParent.get(n.parentNodeId) ?? [];
    list.push(n);
    childrenByParent.set(n.parentNodeId, list);
  }

  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    if (!node) continue;
    for (const rule of node.nextRules) {
      if (rule.goto !== END_NODE && !seen.has(rule.goto)) {
        stack.push(rule.goto);
      }
    }
    if (node.nodeType === 'loop') {
      for (const child of childrenByParent.get(node.id) ?? []) {
        if (!seen.has(child.id)) stack.push(child.id);
      }
    }
  }
  return seen;
}

// ── Walker: playback helper for previews/tests ───────────────────────────────

export interface WalkStep {
  node: TemplateNode;
  answer: Answer;
  next: ResolveResult;
}

export function walk(template: TemplateWithNodes, answers: AnswerMap): WalkStep[] {
  const steps: WalkStep[] = [];
  const byId = new Map(template.nodes.map((n) => [n.id, n]));

  let cursor = template.rootNodeId;
  const visited = new Set<string>();

  while (cursor) {
    if (visited.has(cursor)) {
      throw new Error(`walk: cycle detected at ${cursor}`);
    }
    visited.add(cursor);

    const node = byId.get(cursor);
    if (!node) throw new Error(`walk: node ${cursor} not found`);

    const answer = answers[node.id] ?? null;
    const next = resolveNext(node, answer);
    steps.push({ node, answer, next });

    if (next.kind === 'end' || next.kind === 'invalid') break;
    cursor = next.nodeId;
  }

  return steps;
}
