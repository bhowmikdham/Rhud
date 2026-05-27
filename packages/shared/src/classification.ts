// Phase B — shared types for opportunity classification taxonomy + routing.

// ── Category taxonomy ────────────────────────────────────────────────

export interface OpportunityCategoryRow {
  id: string;
  /** Owning tenant. Every category row is tenant-scoped (see schema
   *  comment on the `OpportunityCategory` model — system rows were
   *  removed in Phase 4 of the industry-template work). */
  tenantId: string;
  slug: string;
  name: string;
  /** For subcategories, the parent's slug. Null for top-level rows. */
  parentSlug: string | null;
  position: number;
}

/** Convenience shape — top-level + grouped sub-categories. The
 *  controller exposes this so the UI doesn't have to flatten/group. */
export interface CategoryTree {
  topLevel: OpportunityCategoryRow[];
  /** Map from parent slug to its ordered subcategories. */
  childrenByParent: Record<string, OpportunityCategoryRow[]>;
}

// ── Classification on an engagement ──────────────────────────────────

export type ClassificationSource = 'llm' | 'manual';

export interface ClassificationResult {
  /** Resolved at submit-time when auto-classify runs, or by the user
   *  when they manually classify. Null when neither has happened. */
  categorySlug: string | null;
  subCategorySlug: string | null;
  classifiedBy: ClassificationSource | null;
  classifiedAt: string | null;
  /** When `classifiedBy='llm'`, the model id is captured for audit. */
  model?: string | null;
}

export interface ManualClassifyInput {
  categorySlug: string;
  /** Optional. When the category has no children, this is null. */
  subCategorySlug?: string | null;
}

// ── Routing rules ────────────────────────────────────────────────────

export interface RoutingRuleRow {
  id: string;
  categorySlug: string;
  reviewerUserId: string;
  /** Display email of the reviewer, resolved server-side. */
  reviewerEmail: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRoutingRuleInput {
  categorySlug: string;
  reviewerUserId: string;
  position?: number;
}

// ── Reviewer assignment on an engagement ─────────────────────────────

export interface ReviewerAssignment {
  /** User id of the assigned reviewer. Null when no rule matched. */
  assignedReviewerId: string | null;
  /** Display email of the assigned reviewer, resolved server-side. */
  assignedReviewerEmail: string | null;
}

export interface ReassignReviewerInput {
  /** Pass null to clear the assignment without picking a new reviewer. */
  reviewerUserId: string | null;
  /** Optional rationale — captured in the thread event for audit. */
  reason?: string;
}

// ── Industry templates ───────────────────────────────────────────────
//
// Global config: the pre-baked taxonomies a tenant picks from at signup
// or via "Reset taxonomy". `cybersecurity` is the default (back-compat
// with today's seed); `blank` ships zero categories. New templates land
// via DB migration.

export interface IndustryTemplateRow {
  slug: string;
  name: string;
  classifierPreamble: string;
  /** Slug the LLM falls back to when nothing matches. Null for `blank`. */
  fallbackSlug: string | null;
  version: number;
}

// ── Category CRUD inputs ─────────────────────────────────────────────

export interface CreateCategoryInput {
  /** Lowercase letters, digits, underscores. Stable identifier — once
   *  set, slug renames go via archive + recreate. */
  slug: string;
  name: string;
  /** Null / omitted → top-level. Otherwise must reference an existing
   *  top-level slug in the tenant's active taxonomy. */
  parentSlug?: string | null;
  position?: number;
}

export interface UpdateCategoryInput {
  name?: string;
  /** Explicit null promotes a child to top-level; a string re-parents.
   *  Omit the field to leave parent unchanged. */
  parentSlug?: string | null;
  position?: number;
}

export interface BulkReorderItem {
  slug: string;
  position: number;
  /** Optional — supports drag-across-parents in the tree UI. */
  parentSlug?: string | null;
}

export interface BulkReorderInput {
  items: BulkReorderItem[];
}

export interface ResetTaxonomyInput {
  /** Slug of the template to clone from. Must exist in industry_templates. */
  templateSlug: string;
  /** Literal string the user types in the modal. Server enforces
   *  exact-match to prevent accidental wipes. */
  confirmText: string;
}
