'use client';

/**
 * Source chip — surfaces how an opportunity entered Rhud (link-share,
 * pasted notes, dropped file, voice note, email import, WhatsApp,
 * etc.). Shown next to the opportunity title on the list and detail
 * pages so reps can scan their pipeline by channel at a glance.
 *
 * Per docs/direct-ingest.md §7.3.
 */

import { Icon } from './icon';

interface Style {
  label: string;
  icon: keyof typeof Icon;
}

// Map matches packages/shared/src/ingestion.ts ENGAGEMENT_SOURCES.
// The label here is the short chip text; the icon hints at the channel
// without being too literal (WhatsApp doesn't have a brand icon in our
// stock set, so we fall back to MessageSquare; same for Voice using Mic).
const STYLE: Record<string, Style> = {
  manual_form:     { label: 'Link',     icon: 'Link' },
  direct_upload:   { label: 'Upload',   icon: 'Paperclip' },
  paste_text:      { label: 'Notes',    icon: 'FileText' },
  // No mic icon in the stock set yet — Sparkle hints at "AI processed
  // audio" without misleading the rep into thinking they can play it
  // from the chip. Swap when we add a Mic icon.
  voice_note:      { label: 'Voice',    icon: 'Sparkle' },
  email_import:    { label: 'Email',    icon: 'Mail' },
  // Slack icon is the closest "chat-app" affordance we have. Replace
  // when a dedicated WhatsApp glyph lands.
  whatsapp_import: { label: 'WhatsApp', icon: 'Slack' },
  rfp_import:      { label: 'RFP',      icon: 'FileText' },
  sow_import:      { label: 'SOW',      icon: 'FileText' },
  odoo_import:     { label: 'Odoo',     icon: 'Refresh' },
  api:             { label: 'API',      icon: 'Zap' },
};

export function SourceChip({ source }: { source: string }) {
  // Unknown sources (forward-compat: a future enum value lands before
  // the UI is redeployed) render with the raw value so we don't hide
  // the data.
  const style = STYLE[source] ?? { label: source, icon: 'Dot' as const };
  const I = (Icon as Record<string, typeof Icon.Home>)[style.icon] ?? Icon.Home;
  return (
    <span className="chip" title={`Source: ${style.label}`}>
      <I size={10} />
      {style.label}
    </span>
  );
}
