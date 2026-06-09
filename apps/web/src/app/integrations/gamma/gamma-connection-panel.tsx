'use client';

/**
 * Gamma connection panel — the API key + workspace fields + proposal-driver
 * picker, lifted verbatim out of gamma-modal.tsx so the modal can host it
 * under a "Connection" tab alongside the template library. Behaviour and
 * state are unchanged; only the outer modal chrome (Portal/header/title)
 * stays in the modal shell.
 */

import { useEffect, useState } from 'react';
import {
  gamma,
  describeError,
  type GammaConfig,
  type ProposalDriver,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';

interface Props {
  /** Close the whole modal (footer "Close" button). */
  onClose(): void;
  /** Called after a successful save so the parent can refresh its view. */
  onSaved?(config: GammaConfig): void;
}

export function GammaConnectionPanel({ onClose, onSaved }: Props) {
  const confirm = useConfirm();
  const [config, setConfig] = useState<GammaConfig | null | 'unset'>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [driver, setDriver] = useState<ProposalDriver>('llm');
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    gamma.get()
      .then((c) => {
        if (c) {
          setConfig(c);
          setWorkspaceName(c.workspaceName ?? '');
          setWorkspaceId(c.workspaceId ?? '');
          setDriver(c.proposalDriver);
          setEnabled(c.enabled);
        } else {
          setConfig('unset');
        }
      })
      .catch((e) => { setErr(describeError(e)); setConfig('unset'); });
  }, []);

  async function save() {
    if (busy) return;
    setBusy(true); setErr(null); setTestResult(null);
    try {
      const dto = {
        workspaceName: workspaceName.trim() || null,
        workspaceId: workspaceId.trim() || null,
        proposalDriver: driver,
        enabled,
        ...(apiKey.trim().length > 0 && { apiKey: apiKey.trim() }),
      };
      const updated = await gamma.upsert(dto);
      setConfig(updated);
      setApiKey('');
      onSaved?.(updated);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    if (busy) return;
    setBusy(true); setTestResult(null);
    try {
      const r = await gamma.test();
      setTestResult({
        ok: r.ok,
        message: r.ok ? 'Authenticated and reachable.' : (r.error ?? 'Unknown error'),
      });
    } catch (e) {
      const msg = describeError(e);
      // The decryption-failed error happens when the master encryption
      // key changed since the API key was stored (most often a server
      // restart in dev). The fix is always the same: re-paste the key
      // and Save. Translate the code into instructions so the user
      // knows exactly what to do.
      if (msg.includes('gamma_key_decryption_failed')) {
        setTestResult({
          ok: false,
          message: 'The stored API key can\'t be decrypted (this happens when the server\'s master key changes). Paste the key in the API key field above and click Save.',
        });
      } else if (msg.includes('gamma_api_key_missing')) {
        setTestResult({ ok: false, message: 'No API key on file. Paste the key above and click Save first.' });
      } else {
        setTestResult({ ok: false, message: msg });
      }
    } finally {
      setBusy(false);
    }
  }

  async function clearKey() {
    const ok = await confirm({
      title: 'Clear the stored Gamma API key?',
      body: `You'll need to re-enter it before any deck generation works. The encrypted bytes are wiped from disk.`,
      tone: 'danger',
      confirmLabel: 'Clear key',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      const updated = await gamma.upsert({ apiKey: '' });
      setConfig(updated);
      onSaved?.(updated);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const apiKeySet = config !== 'unset' && config?.apiKeySet;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {config === null && <div className="empty" style={{ padding: 20 }}><span className="spin" /></div>}

        {config !== null && (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>API key</span>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeySet ? '••••••••• (unchanged)' : 'sk-gamma-…'}
                autoComplete="new-password"
                style={{ height: 32, padding: '0 10px', fontSize: 13 }}
              />
              <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                {apiKeySet
                  ? 'A key is on file (encrypted at rest). Leave blank to keep it; type a new value to replace.'
                  : 'Stored encrypted at rest with envelope encryption. Plaintext never leaves the API process.'}
              </span>
              {apiKeySet && (
                <button type="button" className="btn sm ghost" onClick={clearKey} disabled={busy} style={{ alignSelf: 'flex-start' }}>
                  Clear stored key
                </button>
              )}
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
                Workspace name (optional)
              </span>
              <input
                className="input"
                value={workspaceName}
                onChange={(e) => setWorkspaceName(e.target.value)}
                placeholder="Acme Workspace"
                style={{ height: 32, padding: '0 10px', fontSize: 13 }}
              />
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
                Workspace id (optional)
              </span>
              <input
                className="input"
                value={workspaceId}
                onChange={(e) => setWorkspaceId(e.target.value)}
                placeholder="ws_…"
                style={{ height: 32, padding: '0 10px', fontSize: 13 }}
              />
              <span style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                Routes generated decks to a specific Gamma workspace when your account has more than one.
              </span>
            </label>

            <div style={{ paddingTop: 6, borderTop: '1px solid var(--divider)' }}>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500, marginBottom: 8 }}>
                Use Gamma for proposal drafts?
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {(['llm', 'gamma'] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDriver(d)}
                    style={{
                      appearance: 'none', cursor: 'pointer', textAlign: 'left',
                      padding: '10px 12px', borderRadius: 8,
                      border: '1.5px solid ' + (driver === d ? 'var(--accent)' : 'var(--border)'),
                      background: driver === d ? 'var(--accent-tint)' : 'var(--bg)',
                    }}
                  >
                    <div style={{ fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {driver === d && <Icon.Check size={11} style={{ color: 'var(--accent)' }} />}
                      {d === 'llm' ? 'AI text (Settings → AI)' : 'Gamma deck'}
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
                      {d === 'llm'
                        ? 'Generates a text proposal you copy-paste into your email.'
                        : 'Generates a Gamma deck — opportunity card links to it.'}
                    </div>
                  </button>
                ))}
              </div>
              {driver === 'gamma' && !apiKeySet && !apiKey.trim() && (
                <div style={{ fontSize: 11.5, color: 'var(--warn)', marginTop: 8 }}>
                  Add an API key above before saving — Gamma can&apos;t draft without one.
                </div>
              )}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled — when off, Gamma is skipped and we fall back to the LLM path
            </label>
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

        {testResult && (
          <div style={{
            padding: 10, fontSize: 12.5,
            background: testResult.ok ? 'var(--ok-tint)' : 'var(--danger-tint)',
            color: testResult.ok ? 'var(--ok)' : 'var(--danger)',
            borderRadius: 8,
            border: '1px solid ' + (testResult.ok
              ? 'color-mix(in oklch, var(--ok) 22%, transparent)'
              : 'color-mix(in oklch, var(--danger) 22%, transparent)'),
          }}>
            <b>{testResult.ok ? 'Connection OK.' : 'Connection failed.'}</b> {testResult.message}
          </div>
        )}
      </div>

      <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <button onClick={onClose} disabled={busy} className="btn sm ghost">Close</button>
        <div style={{ display: 'flex', gap: 8 }}>
          {apiKeySet && (
            <button onClick={test} disabled={busy} className="btn sm">
              <Icon.Zap size={11} /> {busy ? 'Working…' : 'Test connection'}
            </button>
          )}
          <button onClick={save} disabled={busy} className="btn sm accent">
            {busy ? <span className="spin" /> : <><Icon.Check size={12} /> Save</>}
          </button>
        </div>
      </footer>
    </div>
  );
}
