import { I } from '../lib/icons';
import type { MessageContext } from '../lib/types';

interface Props {
  msg: MessageContext;
  detected: number;
  missing: number;
  total: number;
  clientEmail: string;
  forwardedFrom: string | null;
}

/** Step 0 — single-sentence framing of what Rhud read, three quiet stats,
 *  the source email pinned below. No quote (per design: nothing up front). */
export function StepDetected({ msg, detected, missing, total, clientEmail, forwardedFrom }: Props) {
  const company = domainCompany(clientEmail);
  const headline =
    total > 0
      ? `${total}-field scope ${company ? `from ${company}` : 'detected'}.`
      : `Email from ${company ?? clientEmail} ready to capture.`;

  return (
    <div className="v3-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 28 }}>
        <span className="v3-pulse" />
        <span className="eyebrow">Scope detected</span>
      </div>

      <h1 className="display">{headline}</h1>

      <p className="sub" style={{ marginTop: 14 }}>
        {total > 0
          ? "I read the email and pulled the scope table. Let's confirm what I found — takes a minute."
          : "I read the email. No structured scope table found, but you can still capture it as an opportunity."}
      </p>

      {total > 0 && (
        <div className="v3-statbox">
          <Stat n={detected} label="Recognized" tone="ok" />
          <Stat n={total - detected - missing} label="Edited / N-A" tone="muted" />
          <Stat n={missing} label="Blank" tone="warn" />
        </div>
      )}

      <div style={{ marginTop: 18 }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>Source</div>
        <div className="v3-source">
          <div className="src-mark"><I.mail size={13} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="v3-source-subj">{msg.subject || '(no subject)'}</div>
            <div className="v3-source-meta">
              {clientEmail}
              {msg.dateLabel ? ` · ${msg.dateLabel}` : ''}
            </div>
          </div>
          <I.chevRight size={13} style={{ color: 'var(--v3-fg-4)' }} />
        </div>
        {forwardedFrom && (
          <div className="v3-fwd-note">
            <I.sparkles size={11} />
            <span>Forwarded by {forwardedFrom} — I traced the original sender for the client field.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone: 'ok' | 'warn' | 'muted' }) {
  const c = tone === 'ok' ? '#059669' : tone === 'warn' ? '#B45309' : 'var(--v3-fg-3)';
  return (
    <div>
      <div className="tnum v3-stat-n" style={{ color: c }}>{n}</div>
      <div className="v3-stat-label">{label}</div>
    </div>
  );
}

/** Best-effort company name from an email domain ("acme.co.in" → "Acme"). */
function domainCompany(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  const host = email.slice(at + 1);
  const core = host.split('.')[0];
  if (!core) return null;
  return core.charAt(0).toUpperCase() + core.slice(1);
}
