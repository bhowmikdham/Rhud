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
  scope_submitted:           ['sales_employee', 'sales_manager'],
  price_predicted:           ['sales_employee', 'sales_manager'],
  approval_requested:        ['sales_manager'],
  approval_granted:          ['sales_employee'],
  approval_adjusted:         ['sales_employee'],
  approval_rejected:         ['sales_employee'],
  proposal_draft_requested:  ['sales_employee'],
  proposal_draft_ready:      ['sales_employee'],
  proposal_sent:             ['sales_employee', 'sales_manager', 'client'],
  engagement_synced:         ['sales_employee'],
  engagement_closed:         ['sales_employee', 'sales_manager'],
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
