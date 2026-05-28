import { I } from '../lib/icons';
import { RHUD_WEB } from '../lib/api';

interface Props {
  created: { engagementId: string; linkUrl?: string };
  clientEmail: string;
  subject: string;
  fieldCount: number;
  askedCount: number;
}

/** Step 3 — what actually happened. Honest status checklist: opportunity
 *  created (done), scoping link (done or skipped), extraction + pricing
 *  (pending — they run async in the Rhud pipeline). */
export function StepSent({ created, clientEmail, subject, fieldCount, askedCount }: Props) {
  const oppUrl = `${RHUD_WEB}/opportunities/${created.engagementId}`;
  const hasLink = !!created.linkUrl;

  return (
    <div className="v3-page" style={{ padding: '44px 22px', textAlign: 'center' }}>
      <div className="v3-sent-badge">
        <I.check size={24} stroke={2.2} />
      </div>
      <h2 className="display" style={{ fontSize: 22 }}>Opportunity created.</h2>
      <p className="sub" style={{ marginTop: 10 }}>
        It's in Rhud now. Extraction and pricing run automatically — check the opportunity for the predicted quote.
      </p>

      <div className="v3-checklist">
        <Row done label="Opportunity created in Rhud" sub={`${clientEmail} · ${truncate(subject, 38)}`} />
        {hasLink ? (
          <Row done label="Scoping link ready" sub="Copy it to send to the client" />
        ) : askedCount > 0 ? (
          <Row label="Follow-up not sent" sub={`${askedCount} field${askedCount === 1 ? '' : 's'} queued — send a link from the opportunity`} muted />
        ) : null}
        <Row pending label="Reading the requirements" sub={fieldCount > 0 ? `Extracting ${fieldCount} fields` : 'Extracting from the email body'} />
        <Row pending label="Pricing prediction" sub="Triggers once extraction finishes" />
      </div>

      <div style={{ marginTop: 24, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
        <a href={oppUrl} target="_blank" rel="noopener" className="btn btn-primary" style={{ textDecoration: 'none' }}>
          Open opportunity <I.arrowRight size={14} />
        </a>
        {hasLink && (
          <a href={created.linkUrl} target="_blank" rel="noopener" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
            <I.link size={13} /> Copy link
          </a>
        )}
      </div>
    </div>
  );
}

function Row({ done, pending, label, sub, muted }: { done?: boolean; pending?: boolean; label: string; sub: string; muted?: boolean }) {
  return (
    <div className="v3-check-row">
      <span
        className="v3-check-dot"
        style={{
          background: done ? 'rgba(16,185,129,0.14)' : pending ? 'var(--rh-soft)' : 'transparent',
          border: done ? '1px solid rgba(16,185,129,0.35)' : pending ? '1px solid var(--rh-stroke)' : '1px dashed var(--v3-fg-5)',
          color: done ? '#059669' : pending ? 'var(--rh)' : 'var(--v3-fg-5)',
        }}
      >
        {done && <I.check size={10} stroke={3} />}
        {pending && <I.clock size={10} />}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="v3-check-label" style={{ color: muted ? 'var(--v3-fg-4)' : 'var(--v3-fg-1)' }}>{label}</div>
        <div className="v3-check-sub">{sub}</div>
      </div>
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
