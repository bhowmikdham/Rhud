/**
 * Notification fan-out contract — design doc §4.7.
 *
 * Each thread event has a default recipient set. Tenants may override per-
 * event toggles via `tenants.notification_config`; this module describes the
 * defaults and the recipient roles known to the system.
 *
 * Sprint 4: email + console only. Slack/Teams come in sprint 6.
 */
import type { ThreadEventType } from './thread-events.js';

export const RECIPIENT_ROLES = [
  'sales_employee',  // resolved to engagement.salesEmployee.email
  'sales_manager',   // resolved to engagement.salesManager.email
  'client',          // resolved to engagement.clientEmail
] as const;

export type RecipientRole = (typeof RECIPIENT_ROLES)[number];

/**
 * Default routing per event type. Slack/Teams entries from §4.7 are kept
 * as comments for the next sprint; sprint 4 only fans out via email.
 *
 * `node_answered` and `link_opened` are intentionally suppressed by default
 * — they fire often enough that immediate emails would be noise. A future
 * digest job rolls them up.
 */
export const DEFAULT_NOTIFICATION_ROUTES: Record<ThreadEventType, RecipientRole[]> = {
  link_issued:               ['sales_employee', 'sales_manager'],
  link_opened:               [],  // suppressed — too noisy as 1-per-event
  node_answered:             [],  // suppressed — debounced into digest later
  file_uploaded:             ['sales_employee'],
  // Document-extraction completion is system-internal; surfaced in the
  // UI thread + audit chain but not emailed (otherwise reps would get
  // 1 email per attached file, which is noisy on multi-doc engagements).
  file_extracted:            [],
  // Iteration removal is a client-side correction — recorded in the
  // audit timeline but not emailed (most reps don't want the noise).
  loop_iteration_removed:    [],
  // Mapper fallback is a quality-of-extraction signal — silent in
  // notifications, but the opportunity detail page surfaces it as a
  // re-run prompt so the rep can retry once the rate limit clears.
  mapper_fallback_heuristic: [],
  scope_submitted:           ['sales_employee', 'sales_manager'],
  price_predicted:           ['sales_employee', 'sales_manager'],
  price_tech_adjusted:       ['sales_employee', 'sales_manager'],
  approval_requested:        ['sales_manager'],
  approval_granted:          ['sales_employee'],
  approval_adjusted:         ['sales_employee'],
  approval_rejected:         ['sales_employee'],
  approval_reverted:         ['sales_employee', 'sales_manager'],
  proposal_draft_requested:  ['sales_employee'],
  proposal_draft_ready:      ['sales_employee'],
  proposal_sent:             ['sales_employee', 'sales_manager', 'client'],
  engagement_synced:         ['sales_employee'],
  engagement_closed:         ['sales_employee', 'sales_manager'],
  quote_computed:            [],  // background event, surfaced in the UI thread only
  quote_approved:            ['sales_employee'],
  // Site-enumeration is a rep-driven action; success surfaces in the
  // opportunity timeline (no email — they're already on the page).
  // Failure routes to both rep + manager because retries are exhausted
  // and someone has to decide what to do (try a different URL,
  // capture scope manually, …).
  site_enumerated:           [],
  site_enumeration_failed:   ['sales_employee', 'sales_manager'],
  // Lead-management events. Tickets fan out to whoever owns the
  // engagement; status changes only to the assigned rep + manager.
  // Follow-ups are quiet by default — the dashboard widget is the
  // primary surfacing.
  ticket_opened:             ['sales_employee', 'sales_manager'],
  ticket_status_changed:     ['sales_employee'],
  ticket_resolved:           ['sales_employee', 'sales_manager'],
  follow_up_scheduled:       [],
  follow_up_completed:       [],
  // Summary generation is silent — it's a UI-side digest, not an
  // event the team needs in their inbox.
  summary_generated:         [],
  // Phase A — reviewer actions. Routing:
  //   send-back / clarification → sales rep + sales manager so the
  //     ball is back in sales' court explicitly
  //   escalate → sales manager + admin (escalation by definition
  //     skips the rep)
  scope_returned_to_sales:   ['sales_employee', 'sales_manager'],
  clarification_requested:   ['sales_employee', 'sales_manager'],
  // Escalation routes to the sales_manager only — admins consume the
  // same inbox the manager does and the email-resolver doesn't have
  // an "admin" mapping yet. If we ever wire a dedicated admin email
  // route, add 'admin' to RECIPIENT_ROLES first.
  scope_escalated:           ['sales_manager'],
  // Field edits and quote line-item changes are silent in notifications
  // — they're informational, surfaced in the timeline only.
  scope_assumptions_updated: [],
  scope_exclusions_updated:  [],
  quote_line_item_added:     [],
  quote_line_item_removed:   [],
  // Phase B — classification + routing.
  // Classification itself is silent (informational, surfaced as a chip).
  // Reviewer assignment fans out to manager so they see who took it.
  engagement_classified:     [],
  engagement_reclassified:   [],
  reviewer_assigned:         ['sales_manager'],
  reviewer_reassigned:       ['sales_manager'],
};

/**
 * Per-tenant override. Stored in `tenants.notification_config` JSONB.
 * `disabled` short-circuits all email; `routes[event]` (if set) replaces
 * the default for that event. Missing entries fall back to defaults.
 */
export interface TenantNotificationConfig {
  disabled?: boolean;
  routes?: Partial<Record<ThreadEventType, RecipientRole[]>>;
}

export function resolveRoute(
  eventType: ThreadEventType,
  config: TenantNotificationConfig | null | undefined,
): RecipientRole[] {
  if (config?.disabled) return [];
  const override = config?.routes?.[eventType];
  return override ?? DEFAULT_NOTIFICATION_ROUTES[eventType];
}
