'use client';

/**
 * Outlook integration setup modal — admin only.
 *
 * Lives in the Connections page. Walks the admin through the
 * one-time Microsoft Entra app registration in plain English,
 * surfaces the exact redirect URI to paste, then takes the
 * resulting Application (client) ID + client secret. Stored
 * encrypted server-side; once saved, every rep in the workspace
 * sees a working "Connect Outlook" button on the same page.
 */

import { useEffect, useState } from 'react';
import {
  integrations,
  describeError,
  type OutlookAppConfig,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';

interface Props {
  onClose(): void;
  /** Fires after a save / clear so the parent page can refresh
   *  status pills + tile state. */
  onChanged?(): void;
}

export function OutlookSetupModal({ onClose, onChanged }: Props) {
  const confirm = useConfirm();
  const [cfg, setCfg] = useState<OutlookAppConfig | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copiedRedirect, setCopiedRedirect] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    integrations.outlook.getAppConfig()
      .then((c) => {
        setCfg(c);
        if (c.clientId) setClientId(c.clientId);
      })
      .catch((e) => {
        // If the read fails (e.g. the API hasn't picked up the new
        // routes yet, or a transient 5xx), still render the wizard so
        // the admin can see the steps + try a Save. Falling back to
        // an "unconfigured" shell is much better UX than a stuck
        // spinner. The error banner above explains what went wrong.
        setErr(describeError(e));
        setCfg({
          isConfigured: false,
          clientId: null,
          // Best-effort default — if the API is down we can't ask it
          // for the right URI. Localhost matches the dev default.
          redirectUri: 'http://localhost:8000/integrations/outlook/callback',
          updatedAt: null,
        });
      });
  }, []);

  function copyRedirect() {
    if (!cfg) return;
    navigator.clipboard.writeText(cfg.redirectUri);
    setCopiedRedirect(true);
    setTimeout(() => setCopiedRedirect(false), 1500);
  }

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const updated = await integrations.outlook.saveAppConfig({
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setCfg(updated);
      setClientSecret('');
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 2000);
      onChanged?.();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (busy) return;
    const ok = await confirm({
      title: 'Remove Outlook integration?',
      body: 'Every rep\'s connected mailbox in this workspace will be revoked. They\'ll need to reconnect after you set up a new app.',
      tone: 'danger',
      confirmLabel: 'Remove integration',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await integrations.outlook.clearAppConfig();
      setCfg({ isConfigured: false, clientId: null, redirectUri: cfg?.redirectUri ?? '', updatedAt: null });
      setClientId('');
      setClientSecret('');
      onChanged?.();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
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
        <div
          className="card"
          style={{ width: '100%', maxWidth: 620, background: 'var(--bg)', maxHeight: '92vh', overflow: 'auto' }}
        >
          <header style={{
            padding: '14px 18px', borderBottom: '1px solid var(--divider)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: 4,
                  background: '#0078d4', color: '#fff',
                  display: 'inline-grid', placeItems: 'center',
                  fontSize: 10, fontWeight: 700,
                }}>O</span>
                Set up Outlook for this workspace
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4, lineHeight: 1.5 }}>
                One-time setup, ~5 minutes. After this, every rep in your workspace just clicks
                <i> Connect Outlook</i> on this page.
              </div>
            </div>
            <button onClick={onClose} disabled={busy} className="btn sm ghost"><Icon.X size={11} /></button>
          </header>

          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            {cfg == null && <div className="empty" style={{ padding: 16 }}><span className="spin" /></div>}

            {cfg != null && (
              <>
                {cfg.isConfigured && (
                  <div style={{
                    padding: 10, borderRadius: 8, fontSize: 12,
                    background: 'var(--ok-tint)', color: 'var(--ok)',
                    border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
                    display: 'flex', alignItems: 'center', gap: 8,
                  }}>
                    <Icon.Check size={12} />
                    Outlook is set up. Reps can connect their mailboxes from the Connections page.
                  </div>
                )}

                <Step n={1} title="Open Microsoft Entra">
                  <a
                    href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn sm"
                  >
                    <Icon.ArrowUpRight size={11} /> Open App registrations
                  </a>
                  <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                    Sign in with your Microsoft 365 admin account. Click <b>New registration</b>.
                  </p>
                </Step>

                <Step n={2} title="Fill in the registration">
                  <ul style={{ margin: 0, padding: '0 0 0 18px', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                    <li><b>Name:</b> Rhud — Outlook integration</li>
                    <li><b>Supported account types:</b> Accounts in any organizational directory and personal Microsoft accounts</li>
                    <li><b>Redirect URI:</b> Web → paste this exact value:</li>
                  </ul>
                  <div style={{
                    marginTop: 8, padding: '8px 10px', borderRadius: 6,
                    background: 'var(--bg-sunk)', fontFamily: 'var(--font-mono)', fontSize: 12,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                  }}>
                    <code style={{ wordBreak: 'break-all' }}>{cfg.redirectUri}</code>
                    <button onClick={copyRedirect} className="btn sm">
                      {copiedRedirect ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Copy</>}
                    </button>
                  </div>
                </Step>

                <Step n={3} title="Add API permissions">
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                    Once the app is created → <b>API permissions</b> → <b>Add a permission</b> →{' '}
                    <b>Microsoft Graph</b> → <b>Delegated permissions</b>. Check:
                  </p>
                  <ul style={{ margin: '6px 0 0', padding: '0 0 0 18px', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
                    <li><code>Mail.Send</code></li>
                    <li><code>User.Read</code></li>
                    <li><code>offline_access</code></li>
                  </ul>
                </Step>

                <Step n={4} title="Generate a client secret">
                  <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
                    <b>Certificates &amp; secrets</b> → <b>New client secret</b>. Copy the <b>Value</b>
                    (not the Secret ID). It&apos;s only shown once — paste it below before leaving Microsoft.
                  </p>
                </Step>

                <Step n={5} title="Paste credentials here">
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
                      Application (client) ID
                    </span>
                    <input
                      className="input"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      placeholder="00000000-0000-0000-0000-000000000000"
                      style={{ height: 32, fontSize: 13, padding: '0 10px', fontFamily: 'var(--font-mono)' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                      Found on the app&apos;s <i>Overview</i> page in Entra.
                    </span>
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                    <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
                      Client secret {cfg.isConfigured && '(leave blank to keep the current one)'}
                    </span>
                    <input
                      className="input"
                      type="password"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      placeholder={cfg.isConfigured ? '••••••••• (unchanged)' : 'Value from Certificates & secrets'}
                      autoComplete="new-password"
                      style={{ height: 32, fontSize: 13, padding: '0 10px' }}
                    />
                    <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                      Stored encrypted at rest with envelope encryption. Plaintext never leaves the API process.
                    </span>
                  </label>
                </Step>
              </>
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
              {cfg?.isConfigured && (
                <button onClick={clear} disabled={busy} className="btn sm danger ghost">
                  Remove integration
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {savedAt && <span style={{ fontSize: 12, color: 'var(--ok)' }}><Icon.Check size={11} /> Saved</span>}
              <button onClick={onClose} disabled={busy} className="btn sm ghost">Close</button>
              <button
                onClick={save}
                disabled={
                  busy
                  || !clientId.trim()
                  // Allow keeping the existing secret unchanged on re-save.
                  || (!clientSecret.trim() && !cfg?.isConfigured)
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
