import { I } from '../lib/icons';
import type { CreateAction, MessageContext, TemplateOption } from '../lib/types';

interface Props {
  msg: MessageContext;
  clientEmail: string;
  fieldCount: number;
  askedCount: number;
  action: CreateAction;
  setAction: (a: CreateAction) => void;
  templates: TemplateOption[];
  templateState: 'idle' | 'loading' | 'loaded' | 'error';
  retryTemplates: () => void;
  templateId: string;
  setTemplateId: (id: string) => void;
}

/** Step 2 — Confirm & choose what happens. The prototype showed a price
 *  quote here, but Rhud predicts pricing asynchronously after extraction
 *  (post-creation), so we don't fabricate a number. Instead: a summary of
 *  what's about to be created, and the real two-path action picker —
 *  create only, or create + send the client a scoping link. */
export function StepConfirm(props: Props) {
  const { msg, clientEmail, fieldCount, askedCount, action, setAction, templates, templateState, retryTemplates, templateId, setTemplateId } = props;

  // Placeholder reflects the load lifecycle so the dropdown never reads
  // "Loading…" forever when the request never resolves.
  const placeholder =
    templateState === 'loading' ? 'Loading…'
    : templateState === 'error' ? 'Couldn’t load — retry'
    : templates.length === 0 ? 'No published templates'
    : 'Choose a template…';

  return (
    <div className="v3-page">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <I.sparkles size={13} style={{ color: 'var(--rh)' }} />
        <span className="eyebrow">Ready to create</span>
      </div>

      {/* Summary card (replaces the prototype's quote hero) */}
      <div className="v3-summary">
        <div className="v3-summary-subj">{msg.subject || '(no subject)'}</div>
        <div className="v3-summary-client">{clientEmail}</div>
        <div style={{ marginTop: 16, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {fieldCount > 0 && <span className="chip"><span className="tnum">{fieldCount}</span> fields captured</span>}
          {askedCount > 0 && <span className="chip warn"><span className="tnum">{askedCount}</span> queued for client</span>}
        </div>
        <div className="v3-summary-note">
          <I.clock size={11} />
          <span>Rhud predicts the price once requirements are extracted — you'll see it on the opportunity.</span>
        </div>
      </div>

      {/* Action picker */}
      <div style={{ marginTop: 24 }}>
        <div className="eyebrow" style={{ marginBottom: 10 }}>What happens next</div>
        <div className="v3-actions">
          <button
            type="button"
            className={'v3-action ' + (action === 'opportunity-only' ? 'selected' : '')}
            onClick={() => setAction('opportunity-only')}
          >
            <span className="radio" />
            <span>
              <span className="label">Create opportunity</span>
              <span className="desc">Logs the opportunity in Rhud and starts extraction. Nothing goes to the client.</span>
            </span>
            <span className="pill">Default</span>
          </button>

          <button
            type="button"
            className={'v3-action ' + (action === 'with-link' ? 'selected' : '')}
            onClick={() => setAction('with-link')}
          >
            <span className="radio" />
            <span>
              <span className="label">Create &amp; send a scoping link</span>
              <span className="desc">Also mints a gathering link the client can fill out for the fields you queued.</span>
            </span>
          </button>
        </div>

        {action === 'with-link' && (
          <div className="v3-link-pick">
            <label className="v3-ident-label" htmlFor="v3-template-select">Template for the scoping link</label>
            <select id="v3-template-select" className="v3-select" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              <option value="">{placeholder}</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
            {templateState === 'error' && (
              <p className="v3-link-note">
                Couldn't load templates.{' '}
                <button type="button" className="v3-partner-clear" onClick={retryTemplates}>Retry</button>
              </p>
            )}
            {templateState === 'loaded' && templates.length === 0 && (
              <p className="v3-link-note">
                No published templates? You can still create the opportunity without a link.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
