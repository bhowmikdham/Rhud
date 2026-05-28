import { useEffect, useState } from 'react';
import { I } from '../lib/icons';
import type { ReviewField } from '../lib/types';

interface Props {
  fields: ReviewField[];
  askClient: Set<number>;
  source: 'llm' | 'heuristic' | null;
  clientEmail: string;
  contactName: string;
  clientName: string;
  contactPhone: string;
  clientAddress: string;
  forwardedFrom: string | null;
  setClientEmail: (v: string) => void;
  setContactName: (v: string) => void;
  setClientName: (v: string) => void;
  setContactPhone: (v: string) => void;
  setClientAddress: (v: string) => void;
  updateField: (id: number, value: string) => void;
  markNA: (id: number) => void;
  toggleAsk: (id: number) => void;
}

const isResolved = (f: ReviewField, asked: Set<number>) =>
  f.status === 'detected' || f.status === 'edited' || f.status === 'na' || asked.has(f.id);

/** Step 1 — scannable triage. Identity at top, then two buckets: the fields
 *  that need a decision (blank), and the ones Rhud already captured. The
 *  design's per-category grouping needs semantic AI (future) — until then,
 *  "needs attention vs captured" is the honest, data-derivable split that
 *  still solves the "dense, hard to scan" problem. */
export function StepReview(props: Props) {
  const { fields, askClient, updateField, markNA, toggleAsk } = props;

  const needsAttention = fields.filter((f) => f.status === 'missing' && !askClient.has(f.id));
  const captured = fields.filter((f) => !(f.status === 'missing' && !askClient.has(f.id)));

  const [openNeeds, setOpenNeeds] = useState(true);
  const [openCaptured, setOpenCaptured] = useState(false);

  const resolvedCount = fields.filter((f) => isResolved(f, askClient)).length;
  const pct = fields.length === 0 ? 100 : Math.round((resolvedCount / fields.length) * 100);

  const missingIds = fields.filter((f) => f.status === 'missing').map((f) => f.id);
  const allMissingQueued = missingIds.length > 0 && missingIds.every((id) => askClient.has(id));

  return (
    <div className="v3-page">
      <span className="eyebrow">Step 2 · Review</span>
      <h2 className="display" style={{ fontSize: 22, marginTop: 6, marginBottom: 8 }}>
        Quick check of what I read.
      </h2>
      <p className="sub" style={{ fontSize: 13, marginBottom: 14 }}>
        Confirm the client, then tap any value to edit. Blank fields can take a value or get queued for the client.
      </p>

      {props.source === 'heuristic' && (
        <div className="v3-ai-note">
          <I.sparkles size={12} />
          <span>Read with basic parsing. Connect an AI provider in Rhud settings for sharper client + scope extraction.</span>
        </div>
      )}

      <div className="v3-prog">
        <div style={{ width: pct + '%' }} />
      </div>

      {/* Client identity — seeded by the LLM (real external client, traced
          through forwards), every field editable before create. */}
      <div className="v3-ident">
        <IdentityRow label="Client email" hint={props.forwardedFrom ? `forwarded by ${props.forwardedFrom}` : undefined}>
          <input className="v3-ident-input" type="email" value={props.clientEmail} onChange={(e) => props.setClientEmail(e.target.value)} />
        </IdentityRow>
        <IdentityRow label="Company">
          <input className="v3-ident-input" type="text" placeholder="Client organisation" value={props.clientName} onChange={(e) => props.setClientName(e.target.value)} />
        </IdentityRow>
        <IdentityRow label="Contact name">
          <input className="v3-ident-input" type="text" value={props.contactName} onChange={(e) => props.setContactName(e.target.value)} />
        </IdentityRow>
        <IdentityRow label="Phone">
          <input className="v3-ident-input" type="tel" placeholder="Not in the email" value={props.contactPhone} onChange={(e) => props.setContactPhone(e.target.value)} />
        </IdentityRow>
        <IdentityRow label="Address">
          <input className="v3-ident-input" type="text" placeholder="Not in the email" value={props.clientAddress} onChange={(e) => props.setClientAddress(e.target.value)} />
        </IdentityRow>
      </div>

      {fields.length === 0 ? (
        <p className="sub" style={{ fontSize: 13 }}>
          No structured scope table in this email — that's fine. Continue to create the opportunity from the body, and Rhud will extract what it can.
        </p>
      ) : (
        <>
          {/* Bulk action */}
          {missingIds.length > 0 && !allMissingQueued && (
            <div className="v3-bulk">
              <I.sparkles size={13} style={{ color: 'var(--rh)', flexShrink: 0, marginTop: 1 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="v3-bulk-title">Skip the tedium</div>
                <div className="v3-bulk-actions">
                  <button
                    className="v3-bulk-btn"
                    onClick={() => missingIds.forEach((id) => { if (!askClient.has(id)) toggleAsk(id); })}
                  >
                    Ask client for all <span className="tnum">{missingIds.filter((id) => !askClient.has(id)).length}</span> blank
                  </button>
                </div>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gap: 10 }}>
            {needsAttention.length > 0 && (
              <ReviewGroup
                title="Needs attention"
                icon="alert"
                tone="warn"
                count={needsAttention.length}
                isOpen={openNeeds}
                onToggle={() => setOpenNeeds((o) => !o)}
              >
                {needsAttention.map((f) => (
                  <ReviewRow key={f.id} field={f} isAsking={askClient.has(f.id)} update={updateField} markNA={markNA} toggleAsk={toggleAsk} />
                ))}
              </ReviewGroup>
            )}
            {captured.length > 0 && (
              <ReviewGroup
                title="Captured"
                icon="check"
                tone="ok"
                count={captured.length}
                isOpen={openCaptured}
                onToggle={() => setOpenCaptured((o) => !o)}
              >
                {captured.map((f) => (
                  <ReviewRow key={f.id} field={f} isAsking={askClient.has(f.id)} update={updateField} markNA={markNA} toggleAsk={toggleAsk} />
                ))}
              </ReviewGroup>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function IdentityRow({ label, hint, children }: { label: string; hint?: string | undefined; children: React.ReactNode }) {
  return (
    <div className="v3-ident-row">
      <span className="v3-ident-label">
        {label}
        {hint && <span className="field-hint hint-accent">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

function ReviewGroup({
  title, icon, tone, count, isOpen, onToggle, children,
}: {
  title: string;
  icon: 'alert' | 'check';
  tone: 'warn' | 'ok';
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const Ic = icon === 'alert' ? I.alert : I.check;
  return (
    <div className="v3-grp">
      <button type="button" className="v3-grp-head" onClick={onToggle}>
        <span
          className="v3-grp-icon"
          style={{
            background: tone === 'ok' ? 'rgba(16,185,129,0.10)' : 'rgba(245,158,11,0.12)',
            color: tone === 'ok' ? '#059669' : '#B45309',
          }}
        >
          <Ic size={13} stroke={tone === 'ok' ? 2.8 : 1.8} />
        </span>
        <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="v3-grp-label">{title}</span>
            <span className="v3-grp-count tnum">{count}</span>
          </div>
        </div>
        <I.chevDown size={13} style={{ color: 'var(--v3-fg-4)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s', flexShrink: 0 }} />
      </button>
      {isOpen && <div className="v3-grp-body">{children}</div>}
    </div>
  );
}

function ReviewRow({
  field, isAsking, update, markNA, toggleAsk,
}: {
  field: ReviewField;
  isAsking: boolean;
  update: (id: number, value: string) => void;
  markNA: (id: number) => void;
  toggleAsk: (id: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(field.value || '');
  useEffect(() => { setVal(field.value || ''); }, [field.value]);

  const isMissing = field.status === 'missing';
  const isDetected = field.status === 'detected';
  const isEdited = field.status === 'edited';
  const isNA = field.status === 'na';

  const save = () => {
    update(field.id, val.trim());
    setEditing(false);
  };

  let stateLabel = '', stateClass = '';
  if (isAsking) { stateLabel = 'Will ask client'; stateClass = 'v3-state-ask'; }
  else if (isNA) { stateLabel = 'N/A'; stateClass = 'v3-state-na'; }
  else if (isEdited) { stateLabel = 'Edited'; stateClass = 'v3-state-ok'; }
  else if (isDetected) { stateLabel = 'Detected'; stateClass = 'v3-state-ok'; }
  else { stateLabel = 'Blank'; stateClass = 'v3-state-miss'; }

  return (
    <div className={'v3-row' + (isAsking ? ' v3-row-ask' : '') + (isDetected || isEdited || isNA ? ' v3-row-done' : '') + (editing ? ' v3-row-editing' : '')}>
      <div className="v3-row-main">
        <div className="v3-row-label">{field.label}</div>
        {editing ? (
          <input
            autoFocus
            className="v3-row-input"
            value={val}
            placeholder="Type a value…"
            onChange={(e) => setVal(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setVal(field.value || ''); setEditing(false); }
            }}
          />
        ) : (
          <div
            className={'v3-row-value' + (isMissing && !isAsking ? ' v3-row-empty' : '')}
            onClick={() => !isAsking && setEditing(true)}
          >
            {field.value || (isAsking ? '— (asking client)' : 'Not in the email')}
          </div>
        )}
      </div>

      <div className="v3-row-right">
        <span className={'v3-state ' + stateClass}>
          {isAsking && <I.send size={9} />}
          {(isDetected || isEdited) && !isAsking && <I.check size={9} stroke={3} />}
          {stateLabel}
        </span>

        {!editing && (
          <div className="v3-row-actions">
            {!isAsking && (
              <button className="v3-mini" onClick={() => setEditing(true)} title={isMissing ? 'Add value' : 'Edit'}>
                <I.edit size={10} />
              </button>
            )}
            <button
              className={'v3-mini ' + (isAsking ? 'v3-mini-active' : '')}
              onClick={() => toggleAsk(field.id)}
              title={isAsking ? "Don't ask" : 'Ask client'}
            >
              {isAsking ? <I.close size={10} /> : <I.send size={10} />}
            </button>
            {!isAsking && !isNA && (
              <button className="v3-mini" onClick={() => markNA(field.id)} title="Mark N/A">
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '-0.03em' }}>N/A</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
