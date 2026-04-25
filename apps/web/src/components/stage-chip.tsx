'use client';

import { Icon } from './icon';

const TONE: Record<string, { chip: string; label: string; icon: keyof typeof Icon }> = {
  issued:           { chip: 'accent', label: 'Issued',           icon: 'Link' },
  in_progress:      { chip: 'accent', label: 'In progress',      icon: 'Thread' },
  submitted:        { chip: 'ok',     label: 'Submitted',        icon: 'Send' },
  predicted:        { chip: 'accent', label: 'Priced',           icon: 'Sparkle' },
  pending_approval: { chip: 'warn',   label: 'Awaiting approval',icon: 'Clock' },
  approved:         { chip: 'ok',     label: 'Approved',         icon: 'Check' },
  drafting:         { chip: '',       label: 'Drafting',         icon: 'Sparkles' },
  draft_ready:      { chip: 'accent', label: 'Draft ready',      icon: 'FileText' },
  sent:             { chip: 'ok',     label: 'Delivered',        icon: 'Send' },
  closed:           { chip: '',       label: 'Closed',           icon: 'CheckCircle' },
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
