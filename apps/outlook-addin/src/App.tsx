import { useCallback, useEffect, useRef, useState } from 'react';
import { I } from './lib/icons';
import {
  AuthExpiredError,
  createOpportunity,
  issueLink,
  loadTemplates,
  preview as fetchPreview,
} from './lib/api';
import { cacheAuth, clearAuth, readCachedAuth, signIn } from './lib/auth';
import { awaitMessageItem, readMessage } from './lib/office';
import type {
  CachedAuth,
  CreateAction,
  MessageContext,
  ReviewField,
  TemplateOption,
} from './lib/types';
import { StepDetected } from './steps/StepDetected';
import { StepReview } from './steps/StepReview';
import { StepConfirm } from './steps/StepConfirm';
import { StepSent } from './steps/StepSent';

type Boot = 'loading' | 'no-message' | 'signin' | 'ready';

/** Derive review fields from the server's flat extraction. Empty / "-"
 *  value cells become "missing"; everything else is "detected". */
function deriveFields(structured: Array<{ label: string; value: string }>): ReviewField[] {
  return structured.map((f, i) => {
    const v = f.value.trim();
    return {
      id: i,
      label: f.label,
      value: f.value,
      status: v && v !== '-' ? 'detected' : 'missing',
    };
  });
}

export function App() {
  const [boot, setBoot] = useState<Boot>('loading');
  const [step, setStep] = useState(0); // 0 Detected · 1 Review · 2 Confirm · 3 Sent
  const [error, setError] = useState<string | null>(null);

  const [msg, setMsg] = useState<MessageContext | null>(null);
  const [auth, setAuth] = useState<CachedAuth | null>(null);

  // Editable client identity (seeded from message + LLM preview).
  const [clientEmail, setClientEmail] = useState('');
  const [contactName, setContactName] = useState('');
  const [clientName, setClientName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [forwardedFrom, setForwardedFrom] = useState<string | null>(null);

  // Partner / distributor party (external intermediary). Empty for direct
  // deals; seeded from the LLM extraction when one is detected.
  const [partnerCompany, setPartnerCompany] = useState('');
  const [partnerContact, setPartnerContact] = useState('');
  const [partnerEmail, setPartnerEmail] = useState('');
  const [partnerRole, setPartnerRole] = useState<'partner' | 'distributor'>('partner');

  const [fields, setFields] = useState<ReviewField[]>([]);
  const [askClient, setAskClient] = useState<Set<number>>(() => new Set());
  // 'heuristic' when the tenant has no LLM configured (or it errored) and
  // we fell back to regex extraction — the Review step nudges toward AI.
  const [extractionSource, setExtractionSource] = useState<'llm' | 'heuristic' | null>(null);

  const [action, setAction] = useState<CreateAction>('opportunity-only');
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [templateId, setTemplateId] = useState('');

  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ engagementId: string; linkUrl?: string } | null>(null);

  const booted = useRef(false);

  const runPreview = useCallback(async (a: CachedAuth, m: MessageContext) => {
    // Seed identity from the raw message first, so the form is never empty.
    setClientEmail(m.fromEmail);
    setContactName(m.fromName);
    try {
      const p = await fetchPreview(a.token, m);
      setFields(deriveFields(p.structuredFields));
      setExtractionSource(p.source);
      // The LLM resolves the real external client (company/contact/email/
      // phone/address) — disambiguating internal forwarders. Each field
      // overrides the raw-message seed only when the model found it.
      const c = p.client;
      if (c.email) setClientEmail(c.email);
      if (c.contactName) setContactName(c.contactName);
      if (c.company) setClientName(c.company);
      if (c.phone) setContactPhone(c.phone);
      if (c.address) setClientAddress(c.address);
      if (p.forwardedFrom) setForwardedFrom(p.forwardedFrom);
      // Seed the partner section when the LLM found an external intermediary.
      if (p.partner) {
        if (p.partner.company) setPartnerCompany(p.partner.company);
        if (p.partner.contactName) setPartnerContact(p.partner.contactName);
        if (p.partner.email) setPartnerEmail(p.partner.email);
        // Default role is 'partner'; rep can switch to 'distributor'.
      }
    } catch (e) {
      if (e instanceof AuthExpiredError) {
        clearAuth();
        setAuth(null);
        setBoot('signin');
        return;
      }
      // Preview is enrichment, not load-blocking — leave fields empty,
      // the rep can still create from the basic identity.
      setFields([]);
    }
  }, []);

  // Boot: wait for Office + an open message, read it, then preview if signed in.
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      const item = await awaitMessageItem();
      if (!item) {
        setBoot('no-message');
        return;
      }
      const m = await readMessage(item);
      setMsg(m);
      const cached = readCachedAuth();
      if (cached) {
        setAuth(cached);
        await runPreview(cached, m);
        setBoot('ready');
      } else {
        setBoot('signin');
      }
    })();
  }, [runPreview]);

  const handleSignIn = useCallback(async () => {
    setError(null);
    try {
      const a = await signIn();
      cacheAuth(a);
      setAuth(a);
      if (msg) await runPreview(a, msg);
      setBoot('ready');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [msg, runPreview]);

  const handleSignOut = useCallback(() => {
    clearAuth();
    setAuth(null);
    setBoot('signin');
    setStep(0);
  }, []);

  // Field mutations (Review step).
  const updateField = useCallback((id: number, value: string) => {
    setFields((prev) =>
      prev.map((f) => {
        if (f.id !== id) return f;
        const v = value.trim();
        return { ...f, value, status: v ? 'edited' : 'missing' };
      }),
    );
  }, []);
  const markNA = useCallback((id: number) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, value: 'N/A', status: 'na' } : f)));
  }, []);
  const toggleAsk = useCallback((id: number) => {
    setAskClient((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Lazy-load templates once, when the rep chooses the "with link" path.
  const templatesReq = useRef<Promise<void> | null>(null);
  const ensureTemplates = useCallback(() => {
    if (templatesReq.current || !auth) return;
    templatesReq.current = loadTemplates(auth.token)
      .then(setTemplates)
      .catch((e: unknown) => {
        templatesReq.current = null;
        setError(`Couldn't load templates: ${(e as Error).message}`);
      });
  }, [auth]);

  const handleCreate = useCallback(async () => {
    if (!auth || !msg) return;
    setBusy(true);
    setError(null);
    try {
      const res = await createOpportunity(auth.token, {
        msg,
        fromEmail: clientEmail,
        fromName: contactName,
        clientNameOverride: clientName,
        contactPhone,
        clientAddress,
        partnerCompany,
        partnerContact,
        partnerEmail,
        partnerRole,
      });
      let linkUrl: string | undefined;
      if (action === 'with-link' && templateId) {
        try {
          const link = await issueLink(auth.token, res.engagementId, templateId);
          linkUrl = link.url;
        } catch {
          // Partial success — opportunity exists; link mint failed. Surface
          // on the Sent step rather than rolling back.
          linkUrl = undefined;
        }
      }
      setCreated({ engagementId: res.engagementId, ...(linkUrl ? { linkUrl } : {}) });
      setStep(3);
    } catch (e) {
      if (e instanceof AuthExpiredError) {
        clearAuth();
        setAuth(null);
        setBoot('signin');
        setStep(0);
        setError('Session expired — sign in again.');
        return;
      }
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [
    auth, msg, clientEmail, contactName, clientName, contactPhone, clientAddress,
    partnerCompany, partnerContact, partnerEmail, partnerRole, action, templateId,
  ]);

  // ── Render ────────────────────────────────────────────────────────────
  const detected = fields.filter((f) => f.status === 'detected').length;
  const missing = fields.filter((f) => f.status === 'missing' && !askClient.has(f.id)).length;
  const askedCount = askClient.size;

  return (
    <div className="v3">
      <div className="v3-top">
        <div className="v3-top-left">
          <div className="v3-mark">R</div>
          <span>Rhud</span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {auth && (
            <button className="v3-icon-btn" title="Sign out" onClick={handleSignOut}>
              <I.close size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="v3-body">
        {boot === 'loading' && <Centered>Reading this email…</Centered>}
        {boot === 'no-message' && (
          <Centered>Open an email message to create an opportunity.</Centered>
        )}
        {boot === 'signin' && (
          <div className="v3-page">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
              <span className="v3-pulse" />
              <span className="eyebrow">Rhud</span>
            </div>
            <h1 className="display">Turn this email into an opportunity.</h1>
            <p className="sub" style={{ marginTop: 14 }}>
              Sign in to Rhud and I'll read the scope out of this thread for you.
            </p>
            <button className="btn btn-primary btn-block" style={{ marginTop: 28 }} onClick={handleSignIn}>
              Sign in <I.arrowRight size={14} />
            </button>
            {error && <p className="v3-error">{error}</p>}
          </div>
        )}

        {boot === 'ready' && msg && (
          <>
            {step === 0 && (
              <StepDetected
                msg={msg}
                detected={detected}
                missing={missing}
                total={fields.length}
                company={clientName}
                clientEmail={clientEmail}
                forwardedFrom={forwardedFrom}
              />
            )}
            {step === 1 && (
              <StepReview
                fields={fields}
                askClient={askClient}
                source={extractionSource}
                clientEmail={clientEmail}
                contactName={contactName}
                clientName={clientName}
                contactPhone={contactPhone}
                clientAddress={clientAddress}
                forwardedFrom={forwardedFrom}
                partnerCompany={partnerCompany}
                partnerContact={partnerContact}
                partnerEmail={partnerEmail}
                partnerRole={partnerRole}
                setClientEmail={setClientEmail}
                setContactName={setContactName}
                setClientName={setClientName}
                setContactPhone={setContactPhone}
                setClientAddress={setClientAddress}
                setPartnerCompany={setPartnerCompany}
                setPartnerContact={setPartnerContact}
                setPartnerEmail={setPartnerEmail}
                setPartnerRole={setPartnerRole}
                updateField={updateField}
                markNA={markNA}
                toggleAsk={toggleAsk}
              />
            )}
            {step === 2 && (
              <StepConfirm
                msg={msg}
                clientEmail={clientEmail}
                fieldCount={fields.length}
                askedCount={askedCount}
                action={action}
                setAction={(a) => {
                  setAction(a);
                  if (a === 'with-link') ensureTemplates();
                }}
                templates={templates}
                templateId={templateId}
                setTemplateId={setTemplateId}
              />
            )}
            {step === 3 && created && (
              <StepSent
                created={created}
                clientEmail={clientEmail}
                subject={msg.subject}
                fieldCount={fields.length}
                askedCount={askedCount}
              />
            )}
          </>
        )}
      </div>

      {/* Footer — per step */}
      {boot === 'ready' && step === 0 && (
        <div className="v3-footer">
          <button className="btn btn-primary btn-block" onClick={() => setStep(1)}>
            Review with me <I.arrowRight size={14} />
          </button>
        </div>
      )}
      {boot === 'ready' && step === 1 && (
        <div className="v3-footer">
          <div className="v3-review-foot">
            <div className="v3-review-foot-left">
              <span className="tnum">{detected + fields.filter((f) => f.status === 'edited' || f.status === 'na').length}</span>
              <span> of </span>
              <span className="tnum">{fields.length}</span>
              <span> confirmed</span>
              {askedCount > 0 && (
                <span className="v3-review-foot-aside">
                  · <span className="tnum">{askedCount}</span> queued for client
                </span>
              )}
            </div>
            <button className="btn btn-primary" onClick={() => setStep(2)}>
              Continue <I.arrowRight size={14} />
            </button>
          </div>
        </div>
      )}
      {boot === 'ready' && step === 2 && (
        <div className="v3-footer">
          {error && <p className="v3-error" style={{ marginBottom: 8 }}>{error}</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-ghost" onClick={() => setStep(1)} disabled={busy}>
              Back
            </button>
            <button
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={handleCreate}
              disabled={busy || (action === 'with-link' && !templateId)}
            >
              {busy ? 'Creating…' : action === 'with-link' ? (
                <>Create &amp; send link <I.arrowRight size={14} /></>
              ) : (
                <>Create opportunity <I.arrowRight size={14} /></>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="v3-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
      <p className="sub" style={{ textAlign: 'center' }}>{children}</p>
    </div>
  );
}
