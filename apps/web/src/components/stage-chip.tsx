'use client';

import { Icon } from './icon';

const TONE: Record<string, { chip: string; label: string; icon: keyof typeof Icon }> = {
  // Direct-ingest initial state — artifacts attached, extraction running.
  // See docs/direct-ingest.md §3.2.
  ingesting:        { chip: 'accent', label: 'Ingesting',        icon: 'Sparkle' },
  issued:           { chip: 'accent', label: 'Issued',           icon: 'Link' },
  in_progress:      { chip: 'accent', label: 'In progress',      icon: 'Thread' },
  submitted:        { chip: 'ok',     label: 'Submitted',        icon: 'Send' },
  predicted:        { chip: 'accent', label: 'Priced',           icon: 'Sparkle' },
  pending_approval: { chip: 'warn',   label: 'Awaiting approval',icon: 'Clock' },
  // Tiered sign-offs above the manager threshold.
  pending_vp_approval:  { chip: 'warn', label: 'VP approval',    icon: 'Clock' },
  pending_ceo_approval: { chip: 'warn', label: 'CEO approval',   icon: 'Clock' },
  // Reviewer holds — the opportunity is paused mid-pricing until sales acts.
  returned_to_sales:     { chip: 'warn', label: 'Returned to sales',     icon: 'Clock' },
  awaiting_clarification:{ chip: 'warn', label: 'Awaiting clarification', icon: 'Clock' },
  escalated:             { chip: 'warn', label: 'Escalated',             icon: 'Clock' },
  approved:         { chip: 'ok',     label: 'Approved',         icon: 'Check' },
  drafting:         { chip: '',       label: 'Drafting',         icon: 'Sparkles' },
  draft_ready:      { chip: 'accent', label: 'Draft ready',      icon: 'FileText' },
  sent:             { chip: 'ok',     label: 'Delivered',        icon: 'Send' },
  closed:           { chip: 'ok',     label: 'Won',              icon: 'CheckCircle' },
  lost:             { chip: 'danger', label: 'Lost',             icon: 'X' },
  rejected:         { chip: 'danger', label: 'Rejected',         icon: 'X' },
  expired:          { chip: '',       label: 'Expired',          icon: 'Clock' },
};

export function StageChip({ stage }: { stage: string }) {
  const tone = TONE[stage] ?? { chip: '', label: stage, icon: 'Dot' as const };
  const I = (Icon as Record<string, typeof Icon.Home>)[tone.icon] ?? Icon.Home;
  return (
    <span className={'chip ' + tone.chip}>
      <I size={10} />
      {tone.label}
    </span>
  );
}
