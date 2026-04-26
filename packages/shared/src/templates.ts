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
  // Heading + description divider. No answer is captured; flow advances on
  // the default `always` rule. Lets templates have visual sections like
  // "Engagement Details", "Current Security Posture" etc. matching real-
  // world cybersec/services intake questionnaires.
  'section',
  // Repeating-group container. Has a body of child nodes (linked via
  // parentNodeId) that the runtime iterates 1..N times. Each iteration
  // captures discrete answers under the body. Used for "describe each
  // application", "list each connected SaaS", etc.
  'loop',
] as const;

export type NodeType = (typeof NODE_TYPES)[number];

/**
 * Node types that capture an answer from the responder. `section` and
 * `loop` are excluded — neither captures a value of its own; loops
 * capture iteration data via their body children. This is the canonical
 * predicate to branch on in engine/runtime code.
 */
export function isInputNode(t: NodeType): boolean {
  return t !== 'section' && t !== 'loop';
}

/**
 * Open-ended loops prompt "Add another?" after each body iteration.
 * Bound loops (mode: 'count') will read the count from another node's
 * answer — left as a follow-up; only 'open_ended' is implemented today.
 */
export interface LoopConfig {
  mode: 'open_ended';
  /** Singular label shown in the iteration header, e.g. "Application". */
  label?: string;
  /**
   * Slug into the engagement's rate card. Each iteration of the loop
   * becomes one priceable entity of this service line. Null = the
   * loop is informational and never produces a priceable entity.
   */
  serviceLineSlug?: string;
}

/**
 * Stage-1 binding: tells the scope normaliser how this node's answer
 * fills the rate-card lookup for its parent loop.
 *
 *   field === 'scope_value'   → the answer is the dimension count
 *                                (pages / screens / apis / loc / devices …).
 *   field === 'methodology'   → the answer is the methodology code
 *                                ('grey_box' | 'black_box' | 'va' | 'pt' | …).
 *   field === 'customer_type' → the answer maps to 'internal' or 'external'.
 *
 * `valueMap` rewrites the raw answer to a canonical value before the
 * pricing engine sees it. Useful when the gathering form uses
 * human-friendly labels ('Public', 'Private') that differ from the
 * rate-card vocabulary ('external', 'internal').
 */
export interface NodeBinding {
  field: 'scope_value' | 'methodology' | 'customer_type';
  valueMap?: Record<string, string>;
}

/**
 * Per-engagement runtime cursor for a loop node. Persisted on the
 * engagement so resume picks up at the right iteration.
 */
export interface LoopCursor {
  iter: number;          // current iteration index (0-based)
  status: 'iterating' | 'done';
}
export type LoopState = Record<string, LoopCursor>;

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
  /** Guidance shown under the field; for `section` nodes, the body copy. */
  helpText?: string | null;
  /** Optional placeholder for text/number inputs. */
  placeholder?: string | null;
  /** When false, the responder may skip this node. Defaults true. */
  required?: boolean;
  nodeType: NodeType;
  options: NodeOption[] | null;
  allowFiles: boolean;
  nextRules: NextRule[];
  position: number;
  /** ID of the parent loop node when this node is a body member. */
  parentNodeId?: string | null;
  /** Loop-specific config; only populated when nodeType === 'loop'. */
  loopConfig?: LoopConfig | null;
  /** Stage-1 dimension binding; null when the answer doesn't price. */
  binding?: NodeBinding | null;
}

export interface Template {
  id: string;
  tenantId: string;
  serviceLine: string;
  name: string;
  version: number;
  status: TemplateStatus;
  rootNodeId: string | null;
  /** Default rate card the template prices engagements against. */
  rateCardId?: string | null;
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
