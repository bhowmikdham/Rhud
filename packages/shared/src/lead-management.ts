// Lead-management — shared types for tickets, follow-ups, and the
// AI summariser surfaced on every opportunity detail page.

export const TICKET_CATEGORIES = ['complaint', 'question', 'change_request', 'check_in', 'internal_note'] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'wont_fix'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export const TICKET_RAISED_BY = ['client', 'sales_rep', 'sales_manager', 'admin', 'system'] as const;
export type TicketRaisedBy = (typeof TICKET_RAISED_BY)[number];

export interface TicketRow {
  id: string;
  engagementId: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  title: string;
  description: string | null;
  raisedBy: TicketRaisedBy;
  raisedByUserId: string | null;
  raisedByEmail: string | null;
  /** Display email of the raiser (for UI), resolved server-side from
   *  raisedByUserId or raisedByEmail. Null when the system raised it. */
  raisedByDisplay: string | null;
  assignedTo: string | null;
  /** Display email of the assignee, resolved server-side. */
  assignedToDisplay: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTicketInput {
  category: TicketCategory;
  /** Defaults to 'medium' when omitted. */
  priority?: TicketPriority;
  title: string;
  description?: string;
  /** Defaults to the calling user's role-derived raisedBy. */
  raisedBy?: TicketRaisedBy;
  /** When the ticket is on behalf of a client (e.g. logged from a call). */
  raisedByEmail?: string;
  assignedTo?: string;
}

export interface UpdateTicketInput {
  category?: TicketCategory;
  priority?: TicketPriority;
  status?: TicketStatus;
  title?: string;
  description?: string | null;
  assignedTo?: string | null;
  resolutionNote?: string | null;
}

// ── Follow-ups ────────────────────────────────────────────────────────

export interface FollowUpRow {
  id: string;
  engagementId: string;
  scheduledFor: string;
  reason: string;
  assignedTo: string | null;
  /** Display email of the assignee. */
  assignedToDisplay: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completedByDisplay: string | null;
  completionNote: string | null;
  relatedTicketId: string | null;
  createdBy: string;
  createdByDisplay: string | null;
  createdAt: string;
  updatedAt: string;
  /** True when scheduledFor is in the past + completedAt is null —
   *  flagged in the UI as "overdue". */
  overdue: boolean;
}

export interface CreateFollowUpInput {
  scheduledFor: string;
  reason: string;
  assignedTo?: string;
  relatedTicketId?: string;
}

export interface UpdateFollowUpInput {
  scheduledFor?: string;
  reason?: string;
  assignedTo?: string | null;
  relatedTicketId?: string | null;
}

export interface CompleteFollowUpInput {
  completionNote?: string;
}

// ── AI Lead Summary ───────────────────────────────────────────────────

export const SUMMARY_RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type SummaryRiskLevel = (typeof SUMMARY_RISK_LEVELS)[number];

export const SUMMARY_ACTION_URGENCIES = ['low', 'medium', 'high'] as const;
export type SummaryActionUrgency = (typeof SUMMARY_ACTION_URGENCIES)[number];

export interface SummaryNextAction {
  title: string;
  urgency: SummaryActionUrgency;
  owner?: string | null;
}

export interface LeadSummaryRow {
  engagementId: string;
  summaryText: string;
  riskLevel: SummaryRiskLevel;
  nextActions: SummaryNextAction[];
  recommendedFollowUpDays: number | null;
  generatedBy: 'llm' | 'manual';
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  generatedByUserId: string | null;
  generatedAt: string;
  /** True when the summary's generatedAt is within the freshness
   *  window (default 24h) — UI uses this to show "stale" badge. */
  fresh: boolean;
}

export type GenerateSummaryResult =
  | { mode: 'auto'; summary: LeadSummaryRow }
  | { mode: 'manual'; prompt: string };

export interface AcceptManualSummaryInput {
  /** The text the manager pasted from a chat tool. We try to parse a
   *  JSON object out of it (the prompt instructs the LLM to return
   *  one); if that fails, we fall back to using the whole text as
   *  summaryText with default risk + empty actions. */
  text: string;
}

// ── Aggregations for the manager dashboard ──────────────────────────

export interface OpenTicketSummary {
  id: string;
  engagementId: string;
  engagementName: string | null;
  clientEmail: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  title: string;
  raisedByDisplay: string | null;
  assignedToDisplay: string | null;
  createdAt: string;
  ageDays: number;
}

export interface UpcomingFollowUp {
  id: string;
  engagementId: string;
  engagementName: string | null;
  clientEmail: string;
  scheduledFor: string;
  reason: string;
  assignedToDisplay: string | null;
  overdue: boolean;
}
