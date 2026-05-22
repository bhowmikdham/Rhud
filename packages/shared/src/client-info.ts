// Phase C — client metadata + multi-level approval shared types.

// ── Client metadata on an engagement ─────────────────────────────────

export interface ClientInfo {
  /** Company / organisation name as it should appear on the proposal.
   *  Null until the rep fills it in. */
  clientName: string | null;
  /** Postal / billing address. Null when unknown. */
  clientAddress: string | null;
  /** Contact person at the client side. Often different from the
   *  email contact (e.g. procurement vs technical decision-maker). */
  contactName: string | null;
  /** Phone number for the contact person. */
  contactPhone: string | null;
}

export interface UpdateClientInfoInput {
  clientName?: string | null;
  clientAddress?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

// ── Tenant approval thresholds ──────────────────────────────────────

export interface ApprovalThresholds {
  /** Cents. Above this, sales_manager approval gates into
   *  'pending_vp_approval'. Null = single-stage approval (no VP step). */
  requiresVpApprovalAboveCents: number | null;
  /** Cents. Above this, sales_manager approval gates into
   *  'pending_ceo_approval'. Null = no CEO step. */
  requiresCeoApprovalAboveCents: number | null;
}

// ── Final approval action ───────────────────────────────────────────

export type FinalApprovalLevel = 'vp' | 'ceo';

export interface FinalApprovalGrantInput {
  /** Optional note — captured in the audit event. */
  comment?: string;
}

export interface FinalApprovalRejectInput {
  reason: string;
}

export interface FinalApprovalResult {
  engagementId: string;
  status: string;
  level: FinalApprovalLevel;
}
