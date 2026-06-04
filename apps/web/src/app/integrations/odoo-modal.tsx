'use client';

/**
 * Odoo connection modal — admin only.
 *
 * Walks the admin through generating an Odoo API key, pasting in
 * URL/database/login/key, then runs a connection test on save. Shows
 * the webhook URL the customer needs to paste into their Odoo Studio
 * Automation Rule.
 */

import { useEffect, useState } from 'react';
import {
  integrations,
  describeError,
  type OdooConnectionStatus,
  type OdooConnectionTestResult,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

interface Props {
  onClose(): void;
  onChanged?(): void;
}

export function OdooConnectModal({ onClose, onChanged }: Props) {
  const confirm = useConfirm();
  const [status, setStatus] = useState<OdooConnectionStatus | null>(null);
  const [url, setUrl] = useState('');
  const [database, setDatabase] = useState('');
  const [login, setLogin] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [autoSync, setAutoSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<OdooConnectionTestResult | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [copiedWebhook, setCopiedWebhook] = useState(false);

  useEffect(() => {
    integrations.odoo.status()
      .then((s) => {
        setStatus(s);
        if (s.configured) {
          // Reconstruct a URL-friendly form. We don't know the original
          // input casing/path; the API normalises it so showing
          // host-only is fine.
          if (s.host) setUrl(`https://${s.host}`);
          if (s.database) setDatabase(s.database);
          if (s.login) setLogin(s.login);
          setAutoSync(s.autoSyncEnabled);
        }
      })
      .catch((e) => setErr(describeError(e)));
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null); setTestResult(null);
    try {
      const updated = await integrations.odoo.upsert({
        url: url.trim(),
        database: database.trim(),
        login: login.trim(),
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        autoSyncEnabled: autoSync,
      });
      setStatus(updated);
      setApiKey('');
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
      onChanged?.();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (busy) return;
    setBusy(true); setErr(null); setTestResult(null);
    try {
      const res = await integrations.odoo.test();
      setTestResult(res);
      // Refresh status to show updated server version / lastConnectedAt
      const fresh = await integrations.odoo.status();
      setStatus(fresh);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy) return;
    const ok = await confirm({
      title: 'Disconnect Odoo?',
      body: 'Saved credentials and entity links will be removed. Records already synced into Odoo stay there. You can reconnect anytime.',
      tone: 'danger',
      confirmLabel: 'Disconnect',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.disconnect();
      setStatus({
        configured: false, connected: false, host: null, database: null,
        login: null, serverVersion: null, lastConnectedAt: null,
        lastErrorMessage: null, autoSyncEnabled: false,
        defaultTeamId: null, defaultUserId: null, webhookUrl: null,
      });
      setUrl(''); setDatabase(''); setLogin(''); setApiKey('');
      onChanged?.();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function copyWebhook() {
    if (!status?.webhookUrl) return;
    navigator.clipboard.writeText(status.webhookUrl);
    setCopiedWebhook(true);
    setTimeout(() => setCopiedWebhook(false), 1500);
  }

  return (
    <Portal>
      <div
        style={{
          position: 'fixed', inset: 0,
          background: 'color-mix(in oklch, black 40%, transparent)',
          display: 'grid', placeItems: 'center', zIndex: 'var(--z-modal)', padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 720, background: 'var(--bg)', maxHeight: '92vh', overflow: 'auto' }}>
          <header style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: 4,
                  background: 'oklch(0.5 0.16 270)', color: '#fff',
                  display: 'inline-grid', placeItems: 'center',
                  fontSize: 10, fontWeight: 700,
                }}>O</span>
                Connect Odoo (Online)
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
                Pushes opportunities + contacts to Odoo when an engagement is submitted, approved, or rejected.
                Pulls historical quotes for ML training. Reads/writes to <code>crm.lead</code>, <code>res.partner</code>, etc.
              </div>
            </div>
            <button onClick={onClose} disabled={busy} className="btn sm ghost"><Icon.X size={11} /></button>
          </header>

          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {status?.configured && status.connected && (
              <div style={{
                padding: 10, borderRadius: 8, fontSize: 12,
                background: 'var(--ok-tint)', color: 'var(--ok)',
                border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Icon.Check size={12} />
                Connected to <code>{status.host}</code> as <code>{status.login}</code>
                {status.serverVersion && <span style={{ marginLeft: 6 }}>· Odoo {status.serverVersion}</span>}
              </div>
            )}

            {status?.configured && !status.connected && status.lastErrorMessage && (
              <div style={{
                padding: 10, borderRadius: 8, fontSize: 12,
                background: 'var(--danger-tint)', color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              }}>
                <b>Connection error: </b>{status.lastErrorMessage}
              </div>
            )}

            <Step n={1} title="Pick or create an integration user in Odoo">
              <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                In Odoo Online: <b>Settings → Users &amp; Companies → Users</b> → <b>Create</b> a user (or pick one).
                Make sure the user has the <i>Sales: Administrator</i> group so they can read/write CRM leads.
                On the user&apos;s record click <b>Action → Change Password</b> and set one — Odoo Online users normally use SSO,
                but the API key requires a local password.
              </p>
            </Step>

            <Step n={2} title="Generate an API key for that user">
              <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                Sign in as that user → <b>Preferences → Account Security → New API Key</b>.
                Copy the key immediately — Odoo only shows it once.
              </p>
            </Step>

            <Step n={3} title="Paste credentials">
              <Field label="Odoo URL" hint="https://acme.odoo.com — no trailing path.">
                <input
                  className="input" value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://yourcompany.odoo.com"
                  style={{ height: 32, fontSize: 13, padding: '0 10px', fontFamily: 'var(--font-mono)' }}
                />
              </Field>
              <Field label="Database" hint="Usually your Odoo subdomain (e.g. 'acme').">
                <input
                  className="input" value={database} onChange={(e) => setDatabase(e.target.value)}
                  placeholder="acme"
                  style={{ height: 32, fontSize: 13, padding: '0 10px', fontFamily: 'var(--font-mono)' }}
                />
              </Field>
              <Field label="Integration user login" hint="The user's login email.">
                <input
                  className="input" value={login} onChange={(e) => setLogin(e.target.value)}
                  placeholder="integrations@yourcompany.com"
                  style={{ height: 32, fontSize: 13, padding: '0 10px' }}
                />
              </Field>
              <Field label={`API key${status?.configured ? ' (leave blank to keep current)' : ''}`} hint="Stored encrypted at rest with envelope encryption.">
                <input
                  className="input" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                  type="password"
                  placeholder={status?.configured ? '••••••••• (unchanged)' : 'Paste API key from Odoo Preferences'}
                  autoComplete="new-password"
                  style={{ height: 32, fontSize: 13, padding: '0 10px' }}
                />
              </Field>
            </Step>

            <Step n={4} title="Auto-sync behaviour">
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={(e) => setAutoSync(e.target.checked)}
                  style={{ width: 14, height: 14 }}
                />
                <span>Auto-sync on lifecycle events (submitted, approved, rejected)</span>
              </label>
              <p style={{ margin: '6px 0 0', fontSize: 11.5, color: 'var(--fg-subtle)', lineHeight: 1.5 }}>
                When off, you push opportunities to Odoo manually from the opportunity page. Settings page lets you fine-tune field mapping.
              </p>
            </Step>

            {status?.configured && status.webhookUrl && (
              <Step n={5} title="(Optional) Receive webhook updates from Odoo">
                <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                  In Odoo: <b>Studio → Automation Rules → New</b>. Trigger: <i>On Save</i>. Model: <code>crm.lead</code>.
                  Action: <i>Webhook</i>. Paste this URL — the secret in the path authenticates the call:
                </p>
                <div style={{
                  marginTop: 8, padding: '8px 10px', borderRadius: 6,
                  background: 'var(--bg-sunk)', fontFamily: 'var(--font-mono)', fontSize: 11.5,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <code style={{ wordBreak: 'break-all' }}>{status.webhookUrl}</code>
                  <button onClick={copyWebhook} className="btn sm">
                    {copiedWebhook ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
                  </button>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--fg-subtle)' }}>
                  Studio is part of Custom plans on Odoo Online. Without it, Rhud falls back to manual sync.
                </p>
              </Step>
            )}

            {testResult && (
              <div style={{
                padding: 10, fontSize: 12.5, borderRadius: 8,
                background: testResult.ok ? 'var(--ok-tint)' : 'var(--danger-tint)',
                color: testResult.ok ? 'var(--ok)' : 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
              }}>
                {testResult.ok
                  ? `✓ Authenticated (uid ${testResult.uid}, server ${testResult.serverVersion ?? 'unknown'})`
                  : `✗ ${testResult.message}`}
              </div>
            )}

            {err && (
              <div style={{
                padding: 10, fontSize: 12.5,
                background: 'var(--danger-tint)', color: 'var(--danger)',
                border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
                borderRadius: 8,
              }}>{err}</div>
            )}
          </div>

          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
          }}>
            <div>
              {status?.configured && (
                <button onClick={disconnect} disabled={busy} className="btn sm danger ghost">
                  Disconnect
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {savedAt && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Icon.Check size={11} /> Saved</span>}
              {status?.configured && (
                <button onClick={test} disabled={busy} className="btn sm ghost">
                  {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Test</>}
                </button>
              )}
              <button onClick={onClose} disabled={busy} className="btn sm ghost">Close</button>
              <button
                onClick={save}
                disabled={
                  busy ||
                  !url.trim() || !database.trim() || !login.trim() ||
                  (!apiKey.trim() && !status?.configured)
                }
                className="btn sm accent"
              >
                {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save</>}
              </button>
            </div>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <span style={{
        width: 22, height: 22, borderRadius: '50%',
        background: 'var(--accent-tint)', color: 'var(--accent)',
        display: 'grid', placeItems: 'center',
        fontSize: 11, fontWeight: 700, flexShrink: 0,
      }}>{n}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{title}</div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
      <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>{hint}</span>}
    </label>
  );
}
