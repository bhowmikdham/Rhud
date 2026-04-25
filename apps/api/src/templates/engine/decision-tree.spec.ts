import { describe, it, expect } from 'vitest';
import type { TemplateNode, TemplateWithNodes } from '@rhud/shared';
import {
  resolveNext,
  validateAnswerShape,
  validateTemplate,
  walk,
} from './decision-tree.js';

// ── Test helpers ─────────────────────────────────────────────────────────────

function node(partial: Partial<TemplateNode> & Pick<TemplateNode, 'id' | 'nodeType'>): TemplateNode {
  return {
    templateId: 't1',
    tenantId: 'tenant-a',
    question: 'q',
    options: null,
    allowFiles: false,
    nextRules: [],
    position: 0,
    ...partial,
  };
}

function tmpl(nodes: TemplateNode[], rootId?: string): TemplateWithNodes {
  return {
    id: 't1',
    tenantId: 'tenant-a',
    serviceLine: 'test',
    name: 'test tmpl',
    version: 1,
    status: 'draft',
    rootNodeId: rootId ?? (nodes[0]?.id ?? null),
    createdAt: '2026-04-25T00:00:00Z',
    updatedAt: '2026-04-25T00:00:00Z',
    nodes,
  };
}

// ── resolveNext ──────────────────────────────────────────────────────────────

describe('resolveNext', () => {
  it('matches eq', () => {
    const n = node({
      id: 'a',
      nodeType: 'single_select',
      nextRules: [
        { when: { op: 'eq', value: 'yes' }, goto: 'b' },
        { when: { op: 'always' }, goto: 'c' },
      ],
    });
    expect(resolveNext(n, 'yes')).toEqual({ kind: 'next', nodeId: 'b' });
  });

  it('falls through to always', () => {
    const n = node({
      id: 'a',
      nodeType: 'single_select',
      nextRules: [
        { when: { op: 'eq', value: 'yes' }, goto: 'b' },
        { when: { op: 'always' }, goto: 'c' },
      ],
    });
    expect(resolveNext(n, 'no')).toEqual({ kind: 'next', nodeId: 'c' });
  });

  it('resolves END marker', () => {
    const n = node({
      id: 'a',
      nodeType: 'single_select',
      nextRules: [{ when: { op: 'always' }, goto: 'END' }],
    });
    expect(resolveNext(n, 'anything')).toEqual({ kind: 'end' });
  });

  it('returns invalid when no rule matches (strict — no silent fall-through)', () => {
    const n = node({
      id: 'a',
      nodeType: 'single_select',
      nextRules: [{ when: { op: 'eq', value: 'yes' }, goto: 'b' }],
    });
    const r = resolveNext(n, 'no');
    expect(r.kind).toBe('invalid');
  });

  it('in: answer one of a list', () => {
    const n = node({
      id: 'a',
      nodeType: 'single_select',
      nextRules: [{ when: { op: 'in', value: ['a', 'b', 'c'] }, goto: 'ok' }],
    });
    expect(resolveNext(n, 'b')).toEqual({ kind: 'next', nodeId: 'ok' });
    expect(resolveNext(n, 'z').kind).toBe('invalid');
  });

  it('includes: multi_select contains value', () => {
    const n = node({
      id: 'a',
      nodeType: 'multi_select',
      nextRules: [{ when: { op: 'includes', value: 'snowflake' }, goto: 'ok' }],
    });
    expect(resolveNext(n, ['dbt', 'snowflake'])).toEqual({ kind: 'next', nodeId: 'ok' });
    expect(resolveNext(n, ['dbt', 'looker']).kind).toBe('invalid');
  });

  it('gt / lt numeric', () => {
    const n = node({
      id: 'a',
      nodeType: 'number',
      nextRules: [
        { when: { op: 'gt', value: 100 }, goto: 'big' },
        { when: { op: 'lt', value: 10 }, goto: 'small' },
        { when: { op: 'always' }, goto: 'medium' },
      ],
    });
    expect(resolveNext(n, 500)).toEqual({ kind: 'next', nodeId: 'big' });
    expect(resolveNext(n, 5)).toEqual({ kind: 'next', nodeId: 'small' });
    expect(resolveNext(n, 50)).toEqual({ kind: 'next', nodeId: 'medium' });
  });
});

// ── validateAnswerShape ──────────────────────────────────────────────────────

describe('validateAnswerShape', () => {
  it('accepts the expected shape per node type', () => {
    expect(validateAnswerShape('single_select', 'x').ok).toBe(true);
    expect(validateAnswerShape('multi_select', ['a', 'b']).ok).toBe(true);
    expect(validateAnswerShape('number', 42).ok).toBe(true);
    expect(validateAnswerShape('short_text', 'hi').ok).toBe(true);
    expect(validateAnswerShape('long_text', 'longer').ok).toBe(true);
    expect(validateAnswerShape('file_upload', null).ok).toBe(true);
  });

  it('rejects mismatches', () => {
    expect(validateAnswerShape('number', '42' as unknown as number).ok).toBe(false);
    expect(validateAnswerShape('multi_select', 'not an array' as unknown as string[]).ok).toBe(false);
    expect(validateAnswerShape('number', Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

// ── validateTemplate ─────────────────────────────────────────────────────────

describe('validateTemplate', () => {
  it('accepts a minimal valid template', () => {
    const t = tmpl([
      node({
        id: 'a',
        nodeType: 'single_select',
        options: [{ value: 'x', label: 'X' }],
        nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      }),
    ], 'a');
    expect(validateTemplate(t)).toEqual([]);
  });

  it('flags no nodes', () => {
    const t = tmpl([], null as unknown as string);
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'no_nodes')).toBe(true);
  });

  it('flags missing root', () => {
    const t = tmpl([
      node({ id: 'a', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'END' }] }),
    ]);
    t.rootNodeId = null;
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'no_root')).toBe(true);
  });

  it('flags dangling gotos', () => {
    const t = tmpl([
      node({
        id: 'a',
        nodeType: 'single_select',
        options: [{ value: 'x', label: 'X' }],
        nextRules: [{ when: { op: 'always' }, goto: 'does-not-exist' }],
      }),
    ], 'a');
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'dangling_goto')).toBe(true);
  });

  it('flags unreachable nodes', () => {
    const t = tmpl([
      node({
        id: 'a',
        nodeType: 'single_select',
        options: [{ value: 'x', label: 'X' }],
        nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      }),
      node({ id: 'b', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'END' }] }),
    ], 'a');
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'unreachable_node' && i.nodeId === 'b')).toBe(true);
  });

  it('flags selects without options', () => {
    const t = tmpl([
      node({
        id: 'a',
        nodeType: 'single_select',
        options: null,
        nextRules: [{ when: { op: 'always' }, goto: 'END' }],
      }),
    ], 'a');
    const issues = validateTemplate(t);
    expect(issues.some((i) => i.code === 'select_without_options')).toBe(true);
  });
});

// ── walk ─────────────────────────────────────────────────────────────────────

describe('walk', () => {
  it('walks a 3-node tree to END', () => {
    const t = tmpl(
      [
        node({
          id: 'a',
          nodeType: 'single_select',
          options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
          nextRules: [
            { when: { op: 'eq', value: 'yes' }, goto: 'b' },
            { when: { op: 'always' }, goto: 'c' },
          ],
        }),
        node({ id: 'b', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'c' }] }),
        node({ id: 'c', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'END' }] }),
      ],
      'a',
    );

    const steps = walk(t, { a: 'yes', b: 'some detail', c: 'final' });
    expect(steps.map((s) => s.node.id)).toEqual(['a', 'b', 'c']);
    expect(steps[steps.length - 1]?.next.kind).toBe('end');
  });

  it('detects cycles in malformed templates', () => {
    const t = tmpl(
      [
        node({ id: 'a', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'b' }] }),
        node({ id: 'b', nodeType: 'short_text', nextRules: [{ when: { op: 'always' }, goto: 'a' }] }),
      ],
      'a',
    );
    expect(() => walk(t, {})).toThrow(/cycle/);
  });
});
