// Shared types for the PM workflow stage 4 — reviewer action screen.
//
// Three reviewer actions (Send Back / Request Clarification / Escalate)
// share a common shape: a free-text reason and a resulting thread event
// + status transition. Plus the quote-line-items CRUD types.

// ── Reviewer hold actions ─────────────────────────────────────────────

export const REVIEWER_ACTIONS = ['send_back', 'request_clarification', 'escalate'] as const;
export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

export interface ReviewerActionInput {
  /** Free-text reason explaining why. Required, max 2000 chars. */
  reason: string;
  /** For escalate only — who you're escalating to.
   *  Defaults to 'sales_manager' if omitted. */
  escalateToRole?: 'sales_manager' | 'admin';
}

export interface ReviewerActionResult {
  engagementId: string;
  /** Resulting engagement status (e.g. 'returned_to_sales'). */
  status: string;
  /** Thread event id we just emitted, for debugging. */
  threadEventId: string | null;
}

// ── Scope-edit fields the reviewer can fill in ──────────────────────

export interface UpdateEngagementScopeInput {
  /** Free-text assumptions list. Pass null/empty to clear. */
  assumptions?: string | null;
  /** Free-text exclusions list. Pass null/empty to clear. */
  exclusions?: string | null;
  /** Reviewer-overridden delivery timeline string. */
  deliveryTimelineOverride?: string | null;
}

export interface EngagementScopeFields {
  assumptions: string | null;
  exclusions: string | null;
  deliveryTimelineOverride: string | null;
}

// ── Quote line items (travel / tool / resource / discount / custom) ─

export const QUOTE_LINE_ITEM_KINDS = ['travel', 'tool', 'resource', 'discount', 'custom'] as const;
export type QuoteLineItemKind = (typeof QUOTE_LINE_ITEM_KINDS)[number];

export interface QuoteLineItemRow {
  id: string;
  engagementQuoteId: string;
  kind: QuoteLineItemKind;
  /** User-facing label, e.g. "Mumbai onsite — 2 trips". */
  label: string;
  /** Signed cents. Positive for charges, negative for discounts. */
  amountCents: number;
  /** When the reviewer typed a percentage discount, the % is preserved
   *  in basis points (1250 = 12.5%). Null otherwise. */
  percentageBps: number | null;
  position: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateQuoteLineItemInput {
  kind: QuoteLineItemKind;
  label: string;
  /** Signed cents. For discounts, pass either a negative `amountCents`
   *  directly OR provide `percentageBps` and omit `amountCents` —
   *  the service will compute it from the base total. */
  amountCents?: number;
  /** Optional for discount kind only. 1250 = 12.5%. */
  percentageBps?: number;
  position?: number;
}

export interface UpdateQuoteLineItemInput {
  kind?: QuoteLineItemKind;
  label?: string;
  amountCents?: number;
  percentageBps?: number | null;
  position?: number;
}

/** What the UI calls "the full total after extras." Returned by the
 *  quote endpoint so both pricing card and proposal render consistent
 *  numbers without duplicating the math client-side. */
export interface QuoteTotalsBreakdown {
  baseTotalCents: number;
  lineItemTotalCents: number;
  /** baseTotalCents + lineItemTotalCents. Always >= 0; clamped at 0
   *  if discounts somehow exceed base + extras. */
  grandTotalCents: number;
  /** Per-line snapshot for display in the proposal + UI. */
  lineItems: QuoteLineItemRow[];
}
