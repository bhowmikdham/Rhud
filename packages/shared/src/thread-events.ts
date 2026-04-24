// Thread event contract — matches design doc §4.7.
// Every row in `thread_events` MUST have one of these event_type values.
// The UI, notifications, and audit tooling all key off this list.

export const THREAD_EVENT_TYPES = [
  'link_issued',
  'link_opened',
  'node_answered',
  'file_uploaded',
  'scope_submitted',
  'price_predicted',
  'approval_requested',
  'approval_granted',
  'approval_adjusted',
  'approval_rejected',
  'proposal_draft_requested',
  'proposal_draft_ready',
  'proposal_sent',
  'engagement_synced',
  'engagement_closed',
] as const;

export type ThreadEventType = (typeof THREAD_EVENT_TYPES)[number];

export const ACTOR_TYPES = ['user', 'client', 'system', 'integration'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export interface ThreadEvent<P = Record<string, unknown>> {
  id: string;
  engagementId: string;
  tenantId: string;
  eventType: ThreadEventType;
  actorType: ActorType;
  actorId: string | null;
  payload: P;
  createdAt: string; // ISO 8601
}
