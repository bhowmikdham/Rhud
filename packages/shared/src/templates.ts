// Decision-tree template contract — design doc §3.1 (scope gathering) + §4.4.
//
// A Template belongs to a tenant and describes a directed graph of questions
// rooted at one node. At runtime a client walks the graph, answering each
// node; `nextRules` resolve to the subsequent node id (or 'END').
//
// Types are deliberately kept as string-literal unions + plain object shapes
// so they cross the Prisma boundary (JSONB columns) and the HTTP boundary
// (JSON over the wire) without any class-based serialization ceremony.

export const NODE_TYPES = [
  'single_select',
  'multi_select',
  'short_text',
  'long_text',
  'number',
  'file_upload',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

export const TEMPLATE_STATUSES = ['draft', 'published', 'archived'] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

/**
 * Option for single_select / multi_select nodes.
 * `label` is user-facing; `value` is what gets stored in the answer.
 * `desc` is optional helper copy.
 */
export interface NodeOption {
  value: string;
  label: string;
  desc?: string;
}

/**
 * A transition rule out of a node. Evaluated in array order; first match wins.
 * `goto` is either a template-local node id or the literal string 'END'.
 *
 * `when` operators:
 *   - eq       — answer === value
 *   - neq      — answer !== value
 *   - in       — value is an array; answer is one of its elements (for selects/number/text)
 *   - includes — answer is an array and contains value (for multi_select)
 *   - gt / lt  — numeric comparison
 *   - always   — unconditional (use as the last rule to mean "default next")
 */
export type NextRuleOp = 'eq' | 'neq' | 'in' | 'includes' | 'gt' | 'lt' | 'always';

export interface NextRule {
  when: { op: NextRuleOp; value?: unknown };
  goto: string; // node id or 'END'
}

export const END_NODE = 'END' as const;
export type EndMarker = typeof END_NODE;

/**
 * A template node as persisted. `tenantId` is denormalized so RLS policies
 * can filter without joining through `templates`.
 */
export interface TemplateNode {
  id: string;
  templateId: string;
  tenantId: string;
  question: string;
  nodeType: NodeType;
  options: NodeOption[] | null;
  allowFiles: boolean;
  nextRules: NextRule[];
  position: number;
}

export interface Template {
  id: string;
  tenantId: string;
  serviceLine: string;
  name: string;
  version: number;
  status: TemplateStatus;
  rootNodeId: string | null;
  createdAt: string; // ISO 8601
  updatedAt: string;
}

/** Template + embedded node list, as returned from GET /templates/:id. */
export interface TemplateWithNodes extends Template {
  nodes: TemplateNode[];
}

// ── Validation helpers (pure, safe to import from both api and web) ──────────

export function isNodeType(v: unknown): v is NodeType {
  return typeof v === 'string' && (NODE_TYPES as readonly string[]).includes(v);
}

export function isTemplateStatus(v: unknown): v is TemplateStatus {
  return typeof v === 'string' && (TEMPLATE_STATUSES as readonly string[]).includes(v);
}
