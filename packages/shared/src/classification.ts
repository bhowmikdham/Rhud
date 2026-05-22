// Phase B — shared types for opportunity classification taxonomy + routing.

// ── Category taxonomy ────────────────────────────────────────────────

export interface OpportunityCategoryRow {
  id: string;
  /** Null = system row (visible to every tenant). Non-null = tenant's
   *  custom category. */
  tenantId: string | null;
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
