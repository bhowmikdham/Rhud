'use client';

/**
 * "I already have it" mode of /opportunities/new — see
 * docs/direct-ingest.md §7.1.
 *
 * Two sub-tabs in Sprint 1:
 *   - Paste text: rep pastes an email body / WhatsApp transcript /
 *     call notes; we one-shot through POST /ingest/text.
 *   - Drop files: rep drags one or more PDF/DOCX/XLSX files; each
 *     file is uploaded directly to S3 via a presigned PUT URL
 *     (POST /ingest/file/presign returns the URL + artifactId);
 *     after all uploads finish, we promote via POST
 *     /opportunities/from-ingest.
 *
 * Below the tabs: a shared client-metadata form (clientEmail
 * required, the rest optional). Mirrors the link-share wizard's
 * step-1 fields so reps don't have to learn a second form.
 */

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ingest, opportunities } from '@/lib/api';
import { Icon } from '@/components/icon';

type Mode = 'paste' | 'drop';

interface UploadedArtifact {
  artifactId: string;
  filename: string;
  sizeBytes: number;
  status: 'uploading' | 'ready' | 'failed';
  error?: string;
  /** The original File, kept so a failed upload can be retried in place. */
  file?: File;
}

export function DirectIngestForm() {
  const router = useRouter();

  const [mode, setMode] = useState<Mode>('paste');

  // Paste-text content.
  const [rawText, setRawText] = useState('');

  // File-drop state — one entry per artifact the rep has uploaded
  // (or tried to upload) so far in this session.
  const [artifacts, setArtifacts] = useState<UploadedArtifact[]>([]);
  const [dragOver, setDragOver] = useState(false);

  // Client metadata — required: clientEmail. Mirrors the link-share
  // step-1 fields.
  const [clientEmail, setClientEmail] = useState('');
  const [name, setName] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientAddress, setClientAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clientEmail.trim());
  const readyArtifactIds = artifacts.filter((a) => a.status === 'ready').map((a) => a.artifactId);

  // Validation per mode: paste needs non-empty text, drop needs at
  // least one fully-uploaded artifact. Email is required in both.
  const canSubmit =
    !submitting &&
    emailValid &&
    (mode === 'paste' ? rawText.trim().length > 0 : readyArtifactIds.length > 0);

  /**
   * Drop / pick handler. For each file:
   *   1. POST /ingest/file/presign → returns presigned URL + artifactId
   *   2. PUT bytes directly to S3
   *   3. Update local state with status='ready' (or 'failed')
   */
  async function handleFiles(files: FileList | File[]) {
    const arr = Array.from(files);
    for (const file of arr) {
      const placeholder: UploadedArtifact = {
        artifactId: `pending-${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name,
        sizeBytes: file.size,
        status: 'uploading',
        file,
      };
      setArtifacts((prev) => [...prev, placeholder]);

      try {
        const presign = await ingest.filePresign({
          filename: file.name,
          contentType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
        });
        const res = await fetch(presign.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) {
          throw new Error(`s3_put_${res.status}`);
        }
        setArtifacts((prev) =>
          prev.map((a) =>
            a.artifactId === placeholder.artifactId
              ? { ...a, artifactId: presign.artifactId, status: 'ready' as const }
              : a,
          ),
        );
      } catch (e) {
        setArtifacts((prev) =>
          prev.map((a) =>
            a.artifactId === placeholder.artifactId
              ? { ...a, status: 'failed' as const, error: String(e) }
              : a,
          ),
        );
      }
    }
  }

  /** Drop a row (a failed upload, or one the rep changed their mind on). */
  function removeArtifact(artifactId: string) {
    setArtifacts((prev) => prev.filter((a) => a.artifactId !== artifactId));
  }

  /** Re-upload a failed file in place — we kept the original File object. */
  function retryArtifact(artifact: UploadedArtifact) {
    if (!artifact.file) return;
    removeArtifact(artifact.artifactId);
    void handleFiles([artifact.file]);
  }

  async function submit() {
    setErr(null);
    setSubmitting(true);
    try {
      if (mode === 'paste') {
        const r = await ingest.text({
          rawText: rawText.trim(),
          clientEmail: clientEmail.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(clientName.trim() ? { clientName: clientName.trim() } : {}),
          ...(clientAddress.trim() ? { clientAddress: clientAddress.trim() } : {}),
          ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        });
        router.push(`/opportunities/${r.engagementId}`);
      } else {
        const r = await opportunities.fromIngest({
          artifactIds: readyArtifactIds,
          clientEmail: clientEmail.trim(),
          ...(name.trim() ? { name: name.trim() } : {}),
          ...(clientName.trim() ? { clientName: clientName.trim() } : {}),
          ...(clientAddress.trim() ? { clientAddress: clientAddress.trim() } : {}),
          ...(contactName.trim() ? { contactName: contactName.trim() } : {}),
          ...(contactPhone.trim() ? { contactPhone: contactPhone.trim() } : {}),
        });
        router.push(`/opportunities/${r.engagementId}`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {err && (
        <div
          className="card"
          style={{
            padding: '10px 14px',
            color: 'var(--danger)',
            fontSize: 12.5,
            background: 'var(--danger-tint)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          }}
        >
          {err}
        </div>
      )}

      {/* Tabs */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          padding: 4,
          background: 'var(--bg-sunk)',
          borderRadius: 10,
          border: '1px solid var(--border)',
          alignSelf: 'flex-start',
        }}
      >
        <TabButton active={mode === 'paste'} onClick={() => setMode('paste')} icon="FileText">
          Paste text
        </TabButton>
        <TabButton active={mode === 'drop'} onClick={() => setMode('drop')} icon="Paperclip">
          Drop files
        </TabButton>
      </div>

      {/* Artifact panel */}
      {mode === 'paste' ? (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Paste the requirements
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
            Email body, WhatsApp thread, call notes — anything the client sent you. We&apos;ll
            extract structured points after you create the opportunity.
          </div>
          <textarea
            className="input"
            rows={10}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Paste here…"
            style={{ resize: 'vertical', minHeight: 180, fontFamily: 'inherit' }}
            // 256KB hard cap matches the API DTO. The warn-at-200KB
            // hint nudges the rep toward dropping a file before they
            // hit the limit.
            maxLength={256 * 1024}
          />
          <div
            style={{
              marginTop: 6,
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 11.5,
              color: 'var(--fg-subtle)',
            }}
          >
            <span>
              {rawText.length.toLocaleString()} characters
              {rawText.length > 200 * 1024 && (
                <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
                  · Long paste — consider dropping a file instead
                </span>
              )}
            </span>
            <span>Max 256 KB</span>
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>
            Drop the file(s)
          </div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 12 }}>
            PDF, DOCX, XLSX, or any RFP/SOW document. Uploaded straight to storage — the
            API never sees the bytes. Each file is queued for extraction once you create
            the opportunity.
          </div>

          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              if (e.dataTransfer.files.length) {
                void handleFiles(e.dataTransfer.files);
              }
            }}
            style={{
              display: 'block',
              padding: 28,
              borderRadius: 10,
              border: '2px dashed ' + (dragOver ? 'var(--accent)' : 'var(--border)'),
              background: dragOver ? 'var(--accent-tint)' : 'var(--bg-sunk)',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'background .15s, border-color .15s',
            }}
          >
            <input
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void handleFiles(e.target.files);
                // Reset so picking the same file twice re-fires.
                e.target.value = '';
              }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Icon.Download size={20} style={{ color: 'var(--fg-subtle)' }} />
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                Drag files here or click to choose
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                Up to 50 MB per file · multiple files OK
              </div>
            </div>
          </label>

          {artifacts.length > 0 && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {artifacts.map((a) => (
                <div
                  key={a.artifactId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 12px',
                    borderRadius: 8,
                    border: '1px solid var(--divider)',
                    background: 'var(--bg)',
                  }}
                >
                  <Icon.FileText size={14} style={{ color: 'var(--fg-subtle)' }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 12.5,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {a.filename}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--fg-subtle)', marginTop: 2 }}>
                      {(a.sizeBytes / 1024).toFixed(1)} KB
                      {a.error && (
                        <span style={{ color: 'var(--danger)', marginLeft: 8 }}>
                          · {a.error}
                        </span>
                      )}
                    </div>
                  </div>
                  {a.status === 'uploading' && <span className="spin" />}
                  {a.status === 'ready' && (
                    <span className="chip ok">
                      <Icon.Check size={9} /> Uploaded
                    </span>
                  )}
                  {a.status === 'failed' && (
                    <span className="chip danger">
                      <Icon.X size={9} /> Failed
                    </span>
                  )}
                  {a.status === 'failed' && a.file && (
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={() => retryArtifact(a)}
                    >
                      Retry
                    </button>
                  )}
                  {a.status !== 'uploading' && (
                    <button
                      type="button"
                      aria-label={`Remove ${a.filename}`}
                      title="Remove"
                      onClick={() => removeArtifact(a.artifactId)}
                      style={{
                        appearance: 'none',
                        border: 0,
                        background: 'transparent',
                        cursor: 'pointer',
                        color: 'var(--fg-subtle)',
                        display: 'grid',
                        placeItems: 'center',
                        padding: 4,
                        borderRadius: 6,
                        flexShrink: 0,
                      }}
                    >
                      <Icon.X size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Client metadata */}
      <div className="card" style={{ padding: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Client details</div>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 14 }}>
          Required: client email. Everything else prints on the eventual proposal and can be
          edited later from the opportunity detail page.
        </div>
        <div style={{ display: 'grid', gap: 14 }}>
          <Field
            label="Client email"
            required
            error={clientEmail && !emailValid ? "Doesn't look like a valid email." : null}
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
            hint="Short tag shown on the dashboard. Leave blank to use the email."
          >
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Northwind Q3 VAPT"
            />
          </Field>
          <Field label="Client company">
            <input
              className="input"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Northwind Analytics"
            />
          </Field>
          <Field label="Client address">
            <input
              className="input"
              value={clientAddress}
              onChange={(e) => setClientAddress(e.target.value)}
              placeholder="Building, street, city, state"
            />
          </Field>
          <Field label="Contact name">
            <input
              className="input"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="e.g. Priya Sharma"
            />
          </Field>
          <Field label="Contact phone">
            <input
              className="input"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="+91 98xxxxxxxx"
            />
          </Field>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <button className="btn ghost" onClick={() => router.push('/opportunities')}>
          Cancel
        </button>
        <button className="btn accent" onClick={submit} disabled={!canSubmit}>
          {submitting ? <span className="spin" /> : <Icon.Zap size={12} />}
          {submitting ? 'Creating…' : 'Create opportunity'}
        </button>
      </div>
    </div>
  );
}

function TabButton({
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

function Field({
  label,
  hint,
  required,
  error,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 12.5,
          fontWeight: 500,
          marginBottom: 6,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        {label}
        {required && <span style={{ color: 'var(--danger)', fontSize: 11 }}>*</span>}
      </div>
      {children}
      {error && (
        <div
          style={{
            fontSize: 11.5,
            color: 'var(--danger)',
            marginTop: 6,
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
        >
          <Icon.X size={11} /> {error}
        </div>
      )}
      {hint && !error && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 6 }}>{hint}</div>
      )}
    </div>
  );
}
