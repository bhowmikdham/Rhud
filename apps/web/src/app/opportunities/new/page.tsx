'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  opportunities,
  templates,
  type IssuedLink,
  type Template,
  type TemplateWithNodes,
  type TemplateNode,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { Toggle } from '@/components/toggle';
import { DirectIngestForm } from './direct-ingest-form';

const TTL_OPTIONS: Array<{ key: string; label: string; days: number; hint?: string }> = [
  { key: '24h', label: '24 hours', days: 1, hint: 'Tightest — clients respond same-day' },
  { key: '7d',  label: '7 days',   days: 7, hint: 'Recommended — comfortable working window' },
  { key: '14d', label: '14 days',  days: 14 },
  { key: '30d', label: '30 days',  days: 30, hint: 'Long-form RFPs only' },
];

type Step = 1 | 2 | 3;
/** Top-level mode selector — link-share wizard vs direct-ingest "I have it".
 *  See docs/direct-ingest.md §7.1. */
type Mode = 'link' | 'have_it';

export default function NewOpportunityPage() {
  const user = useRequireAuth();
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('link');
  const [step, setStep] = useState<Step>(1);
  const [list, setList] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Step 1
  const [clientEmail, setClientEmail] = useState('');
  const [companyHint, setCompanyHint] = useState('');
  const [title, setTitle] = useState('');
  // Phase C — additional client metadata captured at issuance.
  const [clientAddress, setClientAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  // Step 2
  const [templateId, setTemplateId] = useState('');
  const [ttlKey, setTtlKey] = useState<string>('7d');
  const [singleUse, setSingleUse] = useState(true);
  const [requireOtp, setRequireOtp] = useState(true);
  const [watermarkPii, setWatermarkPii] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Step 3
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!user) return;
    templates.list().then((all) => {
      const published = all.filter((t) => t.status === 'published');
      setList(published);
      if (published[0]) setTemplateId(published[0].id);
    }).catch((e) => setErr(String(e)));
  }, [user]);

  const selectedTemplate = useMemo(
    () => list?.find((t) => t.id === templateId) ?? null,
    [list, templateId],
  );

  const selectedTtl = useMemo(
    // Falls back to the recommended 7-day option. The type assertion
    // is safe — TTL_OPTIONS is a non-empty literal and TTL_OPTIONS[1]
    // is the canonical recommended pick.
    () => TTL_OPTIONS.find((t) => t.key === ttlKey) ?? (TTL_OPTIONS[1] as typeof TTL_OPTIONS[number]),
    [ttlKey],
  );

  // Lightweight client-side email validation. Used to guard step 1 → 2
  // and to surface inline feedback rather than letting the API reject.
  const emailIsValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clientEmail.trim());

  async function generate() {
    setErr(null);
    setBusy(true);
    try {
      const r = await opportunities.issue({
        templateId,
        clientEmail: clientEmail.trim(),
        ...(title.trim() ? { name: title.trim() } : {}),
        // Phase C — bind the form's Client company → clientName and
        // include the new fields when provided.
        ...(companyHint.trim()   ? { clientName:    companyHint.trim() }   : {}),
        ...(clientAddress.trim() ? { clientAddress: clientAddress.trim() } : {}),
        ...(contactName.trim()   ? { contactName:   contactName.trim() }   : {}),
        ...(contactPhone.trim()  ? { contactPhone:  contactPhone.trim() }  : {}),
        expiresInDays: selectedTtl.days,
      });
      setIssued(r);
      setStep(3);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!user) return null;

  return (
    <AppShell crumbs={[{ label: 'Opportunities', href: '/opportunities' }, { label: 'New' }]}>
      <div className="page-inner wide" style={{ maxWidth: 1200, paddingTop: 12 }}>
        <div style={{ marginBottom: 18 }}>
          <button className="btn ghost sm" onClick={() => router.push('/opportunities')}>
            <Icon.ChevronLeft size={13} /> Back to opportunities
          </button>
        </div>

        <div style={{ marginBottom: 18 }}>
          <h1 className="page-title" style={{ marginBottom: 4 }}>New opportunity</h1>
          <p className="page-subtitle" style={{ margin: 0, color: 'var(--fg-muted)' }}>
            {mode === 'link'
              ? 'Issue a tokenised scoping link. The client opens it in a browser — no account, no install.'
              : 'Already got the requirements? Drop a file or paste the notes. We extract structured points after the opportunity lands.'}
          </p>
        </div>

        {/* Mode toggle — Sprint 1 of the direct-ingest pipeline.
            See docs/direct-ingest.md §7.1. */}
        <div
          style={{
            display: 'inline-flex',
            gap: 4,
            padding: 4,
            background: 'var(--bg-sunk)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            marginBottom: 18,
          }}
        >
          <ModeButton active={mode === 'link'} onClick={() => setMode('link')} icon="Send">
            Send a scoping link
          </ModeButton>
          <ModeButton active={mode === 'have_it'} onClick={() => setMode('have_it')} icon="Paperclip">
            I already have it
          </ModeButton>
        </div>

        {err && (
          <div className="card" style={{
            padding: '10px 14px', color: 'var(--danger)', fontSize: 12.5,
            marginBottom: 16, background: 'var(--danger-tint)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          }}>
            {err}
          </div>
        )}

        {mode === 'have_it' && <DirectIngestForm />}

        {mode === 'link' && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 24,
          alignItems: 'start',
        }}>
          {/* MAIN — wizard */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Stepper step={step} canJumpTo={(target) => canJumpTo(step, target, { emailIsValid, templateId, issued })} onJump={setStep} />

            {step === 1 && (
              <StepCard
                title="Who is this for?"
                subtitle="The client receives a tokenised link scoped to this email on first open."
                icon="User"
              >
                <div style={{ display: 'grid', gap: 18 }}>
                  <Field
                    label="Client company"
                    hint="Surfaces prior opportunities with this company. Optional."
                  >
                    <input
                      className="input"
                      value={companyHint}
                      onChange={(e) => setCompanyHint(e.target.value)}
                      placeholder="Northwind Analytics"
                      autoFocus
                    />
                  </Field>
                  <Field
                    label="Primary contact email"
                    required
                    hint="The link is bound to this email on first open."
                    error={clientEmail && !emailIsValid ? 'Doesn\'t look like a valid email.' : null}
                  >
                    <input
                      className="input"
                      type="email"
                      value={clientEmail}
                      onChange={(e) => setClientEmail(e.target.value)}
                      placeholder="alex@northwind.io"
                    />
                  </Field>
                  <Field
                    label="Internal label"
                    hint="Optional — short tag shown on your dashboard. Leave blank to use the email."
                  >
                    <input
                      className="input"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Northwind Q3 VAPT"
                    />
                  </Field>

                  {/* Phase C — client details. Optional, but printed
                      on the proposal. Reps can fill in here or later
                      via the opportunity detail page. */}
                  <div style={{
                    fontSize: 11, fontWeight: 600, letterSpacing: 0.4,
                    color: 'var(--fg-muted)', textTransform: 'uppercase',
                    marginTop: 8,
                  }}>
                    Client details (optional)
                  </div>
                  <Field
                    label="Client address"
                    hint="Postal / billing address. Prints on the proposal."
                  >
                    <input
                      className="input"
                      value={clientAddress}
                      onChange={(e) => setClientAddress(e.target.value)}
                      placeholder="Building name, street, city, state"
                    />
                  </Field>
                  <Field
                    label="Contact name"
                    hint="Decision-maker or main point of contact."
                  >
                    <input
                      className="input"
                      value={contactName}
                      onChange={(e) => setContactName(e.target.value)}
                      placeholder="e.g. Priya Sharma"
                    />
                  </Field>
                  <Field
                    label="Contact phone"
                    hint="With country code, e.g. +91 98xxxxxxxx"
                  >
                    <input
                      className="input"
                      value={contactPhone}
                      onChange={(e) => setContactPhone(e.target.value)}
                      placeholder="+91 98xxxxxxxx"
                    />
                  </Field>
                </div>
                <Footer>
                  <button className="btn ghost" onClick={() => router.push('/opportunities')}>
                    Cancel
                  </button>
                  <button
                    className="btn accent"
                    disabled={!emailIsValid}
                    onClick={() => setStep(2)}
                  >
                    Continue <Icon.ArrowRight size={12} />
                  </button>
                </Footer>
              </StepCard>
            )}

            {step === 2 && (
              <>
                <StepCard
                  title="What scope are they answering?"
                  subtitle="Pick the questionnaire the client will fill out. Templates are managed in Templates."
                  icon="FileText"
                >
                  <div style={{ display: 'grid', gap: 8 }}>
                    {list === null && (
                      <div className="empty" style={{ padding: 24 }}><span className="spin" /></div>
                    )}
                    {list !== null && list.length === 0 && (
                      <div style={{
                        padding: '14px 16px', borderRadius: 10,
                        background: 'var(--warn-tint)', fontSize: 13,
                        border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
                        display: 'flex', alignItems: 'flex-start', gap: 10,
                      }}>
                        <Icon.FileText size={14} style={{ color: 'var(--warn)', marginTop: 2 }} />
                        <div>
                          <div style={{ fontWeight: 600 }}>No published templates</div>
                          <div style={{ color: 'var(--fg-muted)', fontSize: 12.5, marginTop: 2 }}>
                            Publish a template first.{' '}
                            <Link href="/templates" style={{ color: 'var(--fg)', textDecoration: 'underline' }}>
                              Go to Templates
                            </Link>
                            .
                          </div>
                        </div>
                      </div>
                    )}
                    {list?.map((t, i) => (
                      <TemplateChoice
                        key={t.id}
                        template={t}
                        suggested={i === 0}
                        selected={templateId === t.id}
                        onSelect={() => setTemplateId(t.id)}
                      />
                    ))}
                  </div>
                </StepCard>

                <StepCard
                  title="Link expiry"
                  subtitle="Tokens expire after this window. The client can resubmit until then."
                  icon="Clock"
                  compact
                >
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
                    {TTL_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        onClick={() => setTtlKey(opt.key)}
                        style={{
                          appearance: 'none', cursor: 'pointer',
                          padding: '10px 12px', borderRadius: 10,
                          background: ttlKey === opt.key ? 'var(--accent-tint)' : 'var(--bg)',
                          border: '1px solid ' + (ttlKey === opt.key ? 'var(--accent)' : 'var(--border)'),
                          color: 'var(--fg)',
                          textAlign: 'left',
                          transition: 'background .15s, border-color .15s',
                        }}
                      >
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{opt.label}</div>
                        {opt.hint && (
                          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                            {opt.hint}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </StepCard>

                <StepCard compact>
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((v) => !v)}
                    style={{
                      appearance: 'none', border: 0, background: 'transparent',
                      cursor: 'pointer', padding: 0,
                      display: 'flex', alignItems: 'center', gap: 6,
                      fontSize: 12.5, fontWeight: 500, color: 'var(--fg-muted)',
                    }}
                  >
                    <Icon.ChevronRight
                      size={12}
                      style={{
                        transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
                        transition: 'transform .15s',
                      }}
                    />
                    Advanced security
                    <span style={{ fontSize: 11.5, color: 'var(--fg-subtle)', marginLeft: 4 }}>
                      ({summarizeSecurity({ singleUse, requireOtp, watermarkPii })})
                    </span>
                  </button>
                  {showAdvanced && (
                    <div style={{
                      display: 'grid', gap: 12,
                      marginTop: 14, paddingTop: 14,
                      borderTop: '1px solid var(--divider)',
                    }}>
                      <SecurityToggle
                        label="Single-use link"
                        hint="Auto-revokes on first submission. Lower exposure if the email is forwarded."
                        value={singleUse}
                        onChange={setSingleUse}
                      />
                      <SecurityToggle
                        label="Require email verification"
                        hint="Client receives a 6-digit code on first open. Defends against forwarded URLs."
                        value={requireOtp}
                        onChange={setRequireOtp}
                      />
                      <SecurityToggle
                        label="Watermark PII in uploads"
                        hint="Stamps a visible audit trail on downloaded copies of client documents."
                        value={watermarkPii}
                        onChange={setWatermarkPii}
                      />
                    </div>
                  )}
                </StepCard>

                <Footer>
                  <button className="btn ghost" onClick={() => setStep(1)}>
                    <Icon.ChevronLeft size={12} /> Back
                  </button>
                  <button
                    className="btn accent"
                    onClick={generate}
                    disabled={busy || !templateId}
                  >
                    {busy ? <span className="spin" /> : <Icon.Zap size={13} />}
                    {busy ? 'Issuing link…' : 'Issue link'}
                  </button>
                </Footer>
              </>
            )}

            {step === 3 && issued && (
              <SharePanel
                issued={issued}
                clientEmail={clientEmail}
                companyHint={companyHint}
                title={title}
                onCopied={() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                copied={copied}
              />
            )}
          </div>

          {/* CONTEXT RAIL — live preview / next steps */}
          <ContextRail
            step={step}
            clientEmail={clientEmail}
            companyHint={companyHint}
            title={title}
            template={selectedTemplate}
            ttlOption={selectedTtl}
            issued={issued}
          />
        </div>
        )}
      </div>
    </AppShell>
  );
}

/** Small segmented-control button used by the mode toggle. */
function ModeButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick(): void;
  icon: keyof typeof Icon;
  children: React.ReactNode;
}) {
  const I = Icon[icon];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        appearance: 'none',
        cursor: 'pointer',
        padding: '8px 14px',
        borderRadius: 7,
        background: active ? 'var(--bg)' : 'transparent',
        border: '1px solid ' + (active ? 'var(--border)' : 'transparent'),
        boxShadow: active ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 12.5,
        fontWeight: active ? 600 : 500,
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
        transition: 'background .15s, color .15s',
      }}
    >
      <I size={12} />
      {children}
    </button>
  );
}

function canJumpTo(
  current: Step,
  target: Step,
  ctx: { emailIsValid: boolean; templateId: string; issued: IssuedLink | null },
): boolean {
  if (target === current) return true;
  // Once the link is issued, the wizard is effectively over — don't let
  // the rep wander back into editing fields that no longer matter.
  if (ctx.issued) return target === 3;
  if (target < current) return true;
  if (target === 2) return ctx.emailIsValid;
  if (target === 3) return ctx.emailIsValid && !!ctx.templateId;
  return false;
}

function summarizeSecurity({
  singleUse, requireOtp, watermarkPii,
}: { singleUse: boolean; requireOtp: boolean; watermarkPii: boolean }): string {
  const flags: string[] = [];
  if (singleUse) flags.push('single-use');
  if (requireOtp) flags.push('OTP');
  if (watermarkPii) flags.push('watermark');
  return flags.length ? flags.join(', ') : 'standard';
}

function Stepper({
  step,
  canJumpTo,
  onJump,
}: {
  step: Step;
  canJumpTo(target: Step): boolean;
  onJump(target: Step): void;
}) {
  const labels: Array<{ n: Step; label: string }> = [
    { n: 1, label: 'Client' },
    { n: 2, label: 'Scope & link' },
    { n: 3, label: 'Share' },
  ];
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '10px 14px',
      background: 'var(--bg-sunk)',
      border: '1px solid var(--border)',
      borderRadius: 10,
    }}>
      {labels.map((s, i) => {
        const done = step > s.n;
        const active = step === s.n;
        const can = canJumpTo(s.n);
        return (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center', flex: i < 2 ? 1 : 0 }}>
            <button
              type="button"
              disabled={!can}
              onClick={() => can && onJump(s.n)}
              style={{
                appearance: 'none',
                border: 0,
                background: 'transparent',
                cursor: can ? 'pointer' : 'default',
                display: 'inline-flex', alignItems: 'center', gap: 8,
                padding: '4px 8px',
                borderRadius: 6,
                color: active || done ? 'var(--fg)' : 'var(--fg-muted)',
                opacity: can ? 1 : 0.6,
                fontSize: 13, fontWeight: active ? 600 : 500,
              }}
            >
              <span style={{
                width: 22, height: 22, borderRadius: 999,
                display: 'grid', placeItems: 'center',
                background: done ? 'var(--fg)' : active ? 'var(--accent)' : 'var(--bg)',
                border: '1px solid ' + (done ? 'var(--fg)' : active ? 'var(--accent)' : 'var(--border)'),
                color: done || active ? 'var(--bg)' : 'var(--fg-subtle)',
                fontSize: 11, fontWeight: 600,
              }}>
                {done ? <Icon.Check size={12} /> : s.n}
              </span>
              <span style={{ whiteSpace: 'nowrap' }}>{s.label}</span>
            </button>
            {i < 2 && (
              <div style={{
                flex: 1, height: 1,
                background: done ? 'var(--fg)' : 'var(--border)',
                margin: '0 6px',
                transition: 'background .25s',
              }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function StepCard({
  title, subtitle, icon, compact, children,
}: {
  title?: string;
  subtitle?: string;
  icon?: keyof typeof Icon;
  compact?: boolean;
  children: React.ReactNode;
}) {
  const I = icon ? Icon[icon] : null;
  return (
    <div className="card" style={{ padding: compact ? '16px 20px' : '24px 28px' }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          marginBottom: subtitle ? 14 : 16,
        }}>
          {I && (
            <span style={{
              width: 32, height: 32, borderRadius: 8,
              background: 'var(--accent-tint)',
              color: 'var(--accent)',
              display: 'grid', placeItems: 'center',
              flexShrink: 0,
            }}>
              <I size={15} />
            </span>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--fg)' }}>{title}</div>
            {subtitle && (
              <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.5 }}>
                {subtitle}
              </div>
            )}
          </div>
        </div>
      )}
      {children}
    </div>
  );
}

function Footer({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', gap: 8,
      paddingTop: 4,
    }}>
      {children}
    </div>
  );
}

function Field({
  label, hint, required, error, children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
        {label}
        {required && <span style={{ color: 'var(--danger)', fontSize: 11 }}>*</span>}
      </div>
      {children}
      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Icon.X size={11} /> {error}
        </div>
      )}
      {hint && !error && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 6 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function TemplateChoice({
  template, suggested, selected, onSelect,
}: {
  template: Template;
  suggested: boolean;
  selected: boolean;
  onSelect(): void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        appearance: 'none', cursor: 'pointer',
        textAlign: 'left',
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px',
        borderRadius: 10,
        background: selected ? 'var(--accent-tint)' : 'var(--bg)',
        border: '1px solid ' + (selected ? 'var(--accent)' : 'var(--border)'),
        transition: 'background .15s, border-color .15s',
      }}
    >
      <span style={{
        width: 18, height: 18, borderRadius: 999,
        border: '2px solid ' + (selected ? 'var(--accent)' : 'var(--border-strong)'),
        background: selected ? 'var(--accent)' : 'transparent',
        display: 'grid', placeItems: 'center',
        flexShrink: 0,
      }}>
        {selected && <Icon.Check size={10} style={{ color: 'var(--bg)' }} />}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--fg)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {template.name}
          {suggested && (
            <span className="chip accent" style={{ fontSize: 10 }}>
              <Icon.Sparkle size={9} /> Suggested
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
          {template.serviceLine} · v{template.version}
        </div>
      </div>
    </button>
  );
}

function SecurityToggle({
  label, hint, value, onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange(v: boolean): void;
}) {
  return (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      cursor: 'pointer',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2, lineHeight: 1.5 }}>
          {hint}
        </div>
      </div>
      <Toggle value={value} onChange={onChange} />
    </label>
  );
}

function ContextRail({
  step,
  clientEmail,
  companyHint,
  title,
  template,
  ttlOption,
  issued,
}: {
  step: Step;
  clientEmail: string;
  companyHint: string;
  title: string;
  template: Template | null;
  ttlOption: typeof TTL_OPTIONS[number];
  issued: IssuedLink | null;
}) {
  // Step 3: timeline of what comes next, animating the active stage.
  if (step === 3 && issued) {
    return <NextStepsRail clientEmail={clientEmail} engagementId={issued.engagementId} />;
  }

  return (
    <aside style={{
      position: 'sticky', top: 16,
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <ClientPreviewCard
        template={template}
        companyHint={companyHint}
        clientEmail={clientEmail}
        title={title}
        ttlLabel={ttlOption.label}
        step={step}
      />
    </aside>
  );
}

/**
 * The "live preview" card — a small mock of what the client sees when
 * they open the gathering link. It does two jobs:
 *   1) Reassures the rep that what they're about to send looks correct.
 *   2) Updates as the rep changes the template — so picking a template
 *      isn't a leap of faith, the first question previews inline.
 *
 * We deliberately don't ship the full gathering form here. The point is
 * a glance, not a working form — the rep clicks "Preview client view"
 * on step 3 to actually walk it.
 */
function ClientPreviewCard({
  template,
  companyHint,
  clientEmail,
  title,
  ttlLabel,
  step,
}: {
  template: Template | null;
  companyHint: string;
  clientEmail: string;
  title: string;
  ttlLabel: string;
  step: Step;
}) {
  const [full, setFull] = useState<TemplateWithNodes | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!template) { setFull(null); return; }
    let cancelled = false;
    setLoading(true);
    templates.get(template.id)
      .then((t) => { if (!cancelled) setFull(t); })
      .catch(() => { if (!cancelled) setFull(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [template?.id]);

  const firstQuestion = full ? pickFirstQuestion(full.nodes) : null;
  const totalQuestions = full
    ? full.nodes.filter((n) => n.nodeType !== 'section' && !n.parentNodeId).length
    : 0;

  // Greeting that adapts as the rep types — feels alive even on step 1.
  const greeting = companyHint
    ? `Welcome, ${companyHint}`
    : title
      ? `Welcome — ${title}`
      : clientEmail
        ? `Welcome, ${clientEmail.split('@')[0]}`
        : 'Welcome';

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <div style={{
        padding: '12px 14px',
        borderBottom: '1px solid var(--divider)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      }}>
        <div>
          <div style={{
            fontSize: 11, letterSpacing: '.06em',
            textTransform: 'uppercase', fontWeight: 600, color: 'var(--fg-subtle)',
          }}>
            Live preview
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 1 }}>
            What the client sees
          </div>
        </div>
        <span style={{
          fontSize: 10, color: 'var(--fg-subtle)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 8px', borderRadius: 999,
          background: 'var(--bg-sunk)',
        }}>
          <span style={{
            width: 6, height: 6, borderRadius: 999,
            background: 'var(--ok)',
            animation: 'pulse 1.6s ease-in-out infinite',
          }} />
          live
        </span>
      </div>

      {/* Browser-frame — purely visual, simulates the client's window. */}
      <div style={{
        background: 'var(--bg-sunk)',
        padding: '10px 12px 4px',
        borderBottom: '1px solid var(--divider)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: '#FF6058' }} />
          <span style={{ width: 7, height: 7, borderRadius: 999, background: '#FFBD2E' }} />
          <span style={{ width: 7, height: 7, borderRadius: 999, background: '#28C941' }} />
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 10px',
          background: 'var(--bg)',
          borderRadius: 6,
          fontSize: 10.5, color: 'var(--fg-subtle)',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          border: '1px solid var(--divider)',
        }}>
          <Icon.Lock size={9} />
          rhud.app/g/<span style={{ opacity: 0.5 }}>•••••••••••</span>
        </div>
      </div>

      {/* Body — animated swap when template changes. */}
      <div
        key={(template?.id ?? 'empty') + step}
        style={{
          padding: '18px 16px 16px',
          minHeight: 220,
          animation: 'previewFadeIn .35s cubic-bezier(.22,.8,.3,1) both',
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)', marginBottom: 4 }}>
          {greeting}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 14 }}>
          {template
            ? `${totalQuestions || '—'} ${totalQuestions === 1 ? 'question' : 'questions'} · auto-saves · ${ttlLabel} link`
            : 'Pick a template in the next step to preview the first question.'}
        </div>

        {loading && !full && (
          <div style={{
            padding: 14, borderRadius: 8, background: 'var(--bg-sunk)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span className="spin" />
          </div>
        )}

        {!loading && firstQuestion && (
          <PreviewQuestion node={firstQuestion} />
        )}

        {!loading && !firstQuestion && (
          <div style={{
            padding: 24, borderRadius: 10,
            background: 'var(--bg-sunk)',
            border: '1px dashed var(--border)',
            textAlign: 'center',
            color: 'var(--fg-subtle)',
            fontSize: 12,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
          }}>
            <Icon.Sparkle size={16} style={{ opacity: 0.6 }} />
            <span>Template preview appears here.</span>
          </div>
        )}

        <div style={{
          marginTop: 14,
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
        }}>
          <div style={{ fontSize: 10.5, color: 'var(--fg-subtle)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon.Lock size={9} /> tokenised · OTP on first open
          </div>
          <div
            aria-hidden
            style={{
              fontSize: 11, fontWeight: 600,
              padding: '5px 12px', borderRadius: 6,
              background: 'color-mix(in oklch, var(--accent) 35%, transparent)',
              color: 'color-mix(in oklch, var(--accent) 60%, var(--fg))',
              opacity: 0.6,
              userSelect: 'none',
            }}
          >
            Continue →
          </div>
        </div>
      </div>

      <style>{`
        @keyframes previewFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

/**
 * Render a single template node as the client would see it. Inputs are
 * disabled so the rep can't accidentally interact — this is a preview,
 * not the form itself.
 */
function PreviewQuestion({ node }: { node: TemplateNode }) {
  const required = node.required !== false;
  return (
    <div style={{
      padding: 14, borderRadius: 10,
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      boxShadow: '0 1px 3px rgba(0,0,0,.04)',
    }}>
      <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)', display: 'flex', alignItems: 'center', gap: 4 }}>
        {node.question}
        {required && <span style={{ color: 'var(--danger)', fontSize: 11 }}>*</span>}
      </div>
      {node.helpText && (
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
          {node.helpText}
        </div>
      )}
      <div style={{ marginTop: 10 }}>
        <PreviewInput node={node} />
      </div>
    </div>
  );
}

function PreviewInput({ node }: { node: TemplateNode }) {
  const fakeStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    fontSize: 12,
    background: 'var(--bg-sunk)',
    border: '1px dashed var(--border)',
    borderRadius: 6,
    color: 'var(--fg-subtle)',
    pointerEvents: 'none',
  };
  switch (node.nodeType) {
    case 'single_select':
    case 'multi_select': {
      const opts = node.options ?? [];
      const limited = opts.slice(0, 4);
      const more = opts.length - limited.length;
      const isMulti = node.nodeType === 'multi_select';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {limited.map((o, i) => (
            <div key={(o.value ?? '') + i} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px', borderRadius: 6,
              border: '1px solid var(--divider)',
              background: 'var(--bg)',
              fontSize: 12, color: 'var(--fg-muted)',
            }}>
              <span style={{
                width: 12, height: 12,
                borderRadius: isMulti ? 3 : 999,
                border: '1.5px solid var(--border-strong)',
              }} />
              <span>{o.label}</span>
            </div>
          ))}
          {more > 0 && (
            <div style={{ fontSize: 11, color: 'var(--fg-subtle)', paddingLeft: 4 }}>
              + {more} more
            </div>
          )}
        </div>
      );
    }
    case 'number':
      return <div style={fakeStyle}>{node.placeholder || '0'}</div>;
    case 'long_text':
      return (
        <div style={{ ...fakeStyle, minHeight: 60 }}>
          {node.placeholder || 'Type a detailed answer…'}
        </div>
      );
    case 'file_upload':
      return (
        <div style={{
          ...fakeStyle,
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px',
          background: 'var(--bg-sunk)',
          borderStyle: 'dashed',
        }}>
          <Icon.Paperclip size={11} />
          <span>Drop a file or click to upload</span>
        </div>
      );
    case 'loop':
      return (
        <div style={{
          ...fakeStyle,
          padding: '10px 12px',
          background: 'var(--bg-sunk)',
          fontSize: 11.5,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Icon.Plus size={11} />
          Add {node.loopConfig?.label?.toLowerCase() ?? 'item'} (repeats)
        </div>
      );
    case 'short_text':
    default:
      return <div style={fakeStyle}>{node.placeholder || 'Type your answer…'}</div>;
  }
}

function pickFirstQuestion(nodes: TemplateNode[]): TemplateNode | null {
  // Top-level (no parent) nodes ordered by position. Skip pure section
  // headers so the preview lands on actual question content.
  const top = nodes
    .filter((n) => !n.parentNodeId)
    .slice()
    .sort((a, b) => a.position - b.position);
  return (
    top.find((n) => n.nodeType !== 'section' && n.nodeType !== 'loop')
      ?? top.find((n) => n.nodeType === 'loop')
      ?? top[0]
      ?? null
  );
}

/**
 * Step 3 rail — replaces the preview with a vertical timeline of what
 * happens next. The current stage pulses; future stages are dimmed.
 * Gives the rep a sense of "you're not done — here's what to expect"
 * without interrupting their flow.
 */
function NextStepsRail({
  clientEmail,
  engagementId,
}: { clientEmail: string; engagementId: string }) {
  const stages: Array<{ icon: keyof typeof Icon; label: string; sub: string; active?: boolean }> = [
    { icon: 'Send',      label: 'Link delivered',      sub: 'You copy → email it', active: true },
    { icon: 'Eye',       label: 'Client opens',        sub: 'OTP, then scope form' },
    { icon: 'FileText',  label: 'Scope submitted',     sub: 'Files extracted automatically' },
    { icon: 'Sparkle',   label: 'Price predicted',     sub: 'AI quotes from rate card' },
    { icon: 'Check',     label: 'Manager approves',    sub: 'Adjust or accept' },
    { icon: 'Sparkles',  label: 'Proposal drafts',     sub: 'Gamma deck or text' },
    { icon: 'CheckCircle', label: 'Sent to client',    sub: 'Outlook or mailto bridge' },
  ];
  return (
    <aside style={{
      position: 'sticky', top: 16,
      display: 'flex', flexDirection: 'column', gap: 12,
    }}>
      <div className="card" style={{ padding: 18 }}>
        <div className="section-label" style={{ marginBottom: 4 }}>What happens next</div>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 14, lineHeight: 1.5 }}>
          Each event lands in your thread for <b style={{ color: 'var(--fg)' }}>{clientEmail}</b>.
        </div>
        <ol style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stages.map((s, i) => {
            const I = Icon[s.icon];
            return (
              <li key={s.label} style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 999,
                  display: 'grid', placeItems: 'center',
                  background: s.active ? 'var(--accent-tint)' : 'var(--bg-sunk)',
                  color: s.active ? 'var(--accent)' : 'var(--fg-subtle)',
                  border: '1px solid ' + (s.active ? 'var(--accent)' : 'var(--divider)'),
                  flexShrink: 0,
                  animation: s.active ? 'pulse 1.8s ease-in-out infinite' : 'none',
                }}>
                  <I size={11} />
                </span>
                <div style={{ minWidth: 0, flex: 1, opacity: i === 0 ? 1 : 0.55 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--fg)' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 1 }}>{s.sub}</div>
                </div>
              </li>
            );
          })}
        </ol>
        <Link
          href={`/opportunities/${engagementId}`}
          className="btn sm accent"
          style={{ width: '100%', marginTop: 14, justifyContent: 'center' }}
        >
          Open thread <Icon.ArrowRight size={11} />
        </Link>
      </div>
    </aside>
  );
}

function SharePanel({
  issued, clientEmail, companyHint, title, copied, onCopied,
}: {
  issued: IssuedLink;
  clientEmail: string;
  companyHint: string;
  title: string;
  copied: boolean;
  onCopied(): void;
}) {
  const [copyErr, setCopyErr] = useState<string | null>(null);
  // The token URL is shown only once, so a silently-failed copy (non-HTTPS
  // host, restricted browser, Clipboard API unavailable) would lose the
  // link. Only mark "Copied" on success; otherwise tell the rep to copy
  // the (now user-selectable) URL manually.
  async function writeClipboard(text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setCopyErr(null);
      onCopied();
    } catch {
      setCopyErr('Copy failed — select the link above and copy it manually.');
    }
  }
  function copy() {
    void writeClipboard(issued.url);
  }
  function copyMessage() {
    const subject = title || `your ${companyHint || 'opportunity'}`;
    const msg = `Hi — here's a secure scoping link for ${subject}: ${issued.url}\n\nIt's tokenised and expires soon. Open it in any browser; no account needed.`;
    void writeClipboard(msg);
  }
  const subject = encodeURIComponent(`Scoping link${title ? ` — ${title}` : ''}`);
  const body = encodeURIComponent(
    `Hi,\n\nHere's the scoping link: ${issued.url}\n\nIt's tokenised and tied to your email — open it in any browser, no account needed.\n\nThanks,`,
  );
  const mailto = `mailto:${encodeURIComponent(clientEmail)}?subject=${subject}&body=${body}`;

  return (
    <>
      <div className="card" style={{ padding: 28 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
          <span className="chip ok"><Icon.Check size={10} /> Live</span>
          <span className="chip"><Icon.Lock size={10} /> Scoped to {clientEmail}</span>
          <span className="chip">
            <Icon.Clock size={10} />
            Expires {new Date(issued.expiresAt).toLocaleDateString()}
          </span>
        </div>

        <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.015em', margin: '14px 0 4px' }}>
          Link ready for {companyHint || clientEmail}
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0, lineHeight: 1.55 }}>
          A thread has been opened — every event lands there, in your inbox, and (when configured) in Slack.
        </p>

        <div style={{
          marginTop: 18, padding: '14px 16px',
          border: '1px solid var(--border)', borderRadius: 12,
          background: 'var(--bg-sunk)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Icon.Link size={15} style={{ color: 'var(--fg-subtle)', flexShrink: 0 }} />
          <span className="mono" style={{
            flex: 1, color: 'var(--fg)', fontSize: 12.5,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            userSelect: 'all', cursor: 'text',
          }}>
            {issued.url}
          </span>
          <button className="btn sm accent" onClick={copy}>
            {copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
          </button>
        </div>

        {copyErr && (
          <div role="alert" style={{ marginTop: 8, fontSize: 11.5, color: 'var(--danger)' }}>
            {copyErr}
          </div>
        )}

        <div style={{
          marginTop: 12, padding: '10px 12px',
          background: 'var(--warn-tint)',
          border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
          borderRadius: 8, fontSize: 12, color: 'var(--fg-muted)',
          display: 'flex', alignItems: 'flex-start', gap: 8, lineHeight: 1.5,
        }}>
          <Icon.Lock size={12} style={{ color: 'var(--warn)', marginTop: 2, flexShrink: 0 }} />
          <span>
            The token is shown <b style={{ color: 'var(--fg)', fontWeight: 600 }}>only once</b>.
            We persist an argon2id hash; if you lose the URL, revoke and reissue.
          </span>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10, marginTop: 18,
        }}>
          <a href={mailto} className="btn" style={{ height: 36, justifyContent: 'center' }}>
            <Icon.Mail size={13} /> Email to client
          </a>
          <button
            className="btn"
            style={{ height: 36, justifyContent: 'center' }}
            onClick={copyMessage}
          >
            <Icon.Copy size={13} /> Copy rich message
          </button>
          <Link
            href={`/g/${issued.token}`}
            target="_blank"
            className="btn"
            style={{ height: 36, justifyContent: 'center' }}
          >
            <Icon.Eye size={13} /> Preview client view
          </Link>
        </div>

        <Footer>
          <Link href="/opportunities" className="btn ghost">
            Back to opportunities
          </Link>
          <Link href={`/opportunities/${issued.engagementId}`} className="btn accent">
            Open opportunity thread <Icon.ArrowRight size={12} />
          </Link>
        </Footer>
      </div>
    </>
  );
}
