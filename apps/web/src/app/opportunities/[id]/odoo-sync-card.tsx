'use client';

/**
 * Per-opportunity Odoo control panel.
 *
 * Mounted on the opportunity detail page. Shows the current link to
 * Odoo (if any), a Push button (manual sync), Mark won/lost, Pull
 * (refresh from Odoo), and Unlink. Silent when Odoo isn't configured.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  describeError,
  integrations,
  type OdooConnectionStatus,
  type OdooEntityLinkRow,
  type OdooSyncLogRow,
  type OdooRecord,
} from '@/lib/api';
import { Icon } from '@/components/icon';
import { useConfirm } from '@/components/confirm';

interface Props {
  engagementId: string;
  status: string;
}

export function OdooSyncCard({ engagementId, status }: Props) {
  const confirm = useConfirm();
  const [connection, setConnection] = useState<OdooConnectionStatus | null>(null);
  const [link, setLink] = useState<OdooEntityLinkRow | null>(null);
  const [partnerLink, setPartnerLink] = useState<OdooEntityLinkRow | null>(null);
  const [recentLog, setRecentLog] = useState<OdooSyncLogRow | null>(null);
  const [pulledRecords, setPulledRecords] = useState<OdooRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const refresh = useCallback(() => {
    integrations.odoo.status().then(setConnection).catch(() => setConnection(null));
    integrations.odoo.entityLinks(500).then((rows) => {
      const leadRow = rows.find((r) => r.rhudEntity === 'engagement' && r.rhudId === engagementId && r.odooModel === 'crm.lead');
      const partnerRow = rows.find((r) => r.rhudEntity === 'engagement' && r.rhudId === engagementId && r.odooModel === 'res.partner');
      setLink(leadRow ?? null);
      setPartnerLink(partnerRow ?? null);
    }).catch(() => undefined);
    integrations.odoo.syncLogs(50).then((rows) => {
      const mine = rows.find((r) => r.rhudEntity === 'engagement' && r.rhudId === engagementId);
      setRecentLog(mine ?? null);
    }).catch(() => undefined);
  }, [engagementId]);

  useEffect(() => { refresh(); }, [refresh]);

  if (!connection) return null;
  if (!connection.configured) return null;

  async function push() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.pushEngagement(engagementId, {});
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 1500);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  async function pull() {
    if (busy) return;
    setBusy(true); setErr(null); setPulledRecords(null);
    try {
      const res = await integrations.odoo.pullEngagement(engagementId);
      setPulledRecords(res.records);
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  async function setOutcome(outcome: 'won' | 'lost') {
    const ok = await confirm({
      title: outcome === 'won' ? 'Mark as Won in Odoo?' : 'Mark as Lost in Odoo?',
      body: outcome === 'won'
        ? 'Calls action_set_won on the linked Odoo opportunity. Won opportunities advance to a won-stage in Odoo.'
        : 'Calls action_set_lost. Odoo will mark the opportunity inactive.',
      ...(outcome === 'won' ? {} : { tone: 'warn' as const }),
      confirmLabel: outcome === 'won' ? 'Mark Won' : 'Mark Lost',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.setOutcome(engagementId, outcome);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  async function unlink() {
    const ok = await confirm({
      title: 'Unlink from Odoo?',
      body: 'Removes the local mapping between this opportunity and the Odoo lead. The Odoo record itself stays. A future Push will create a brand-new lead.',
      tone: 'warn',
      confirmLabel: 'Unlink',
    });
    if (!ok) return;
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.unlinkEngagement(engagementId);
      setLink(null);
      setPartnerLink(null);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  const odooBase = connection.host ? `https://${connection.host}` : null;
  const leadDeepLink = link && odooBase
    ? `${odooBase}/web#id=${link.odooId}&model=${encodeURIComponent(link.odooModel)}&view_type=form`
    : null;

  return (
    <div className="card" style={{ padding: 22, marginTop: 16 }}>
      <div className="section-label" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Odoo</span>
        <a className="btn sm ghost" href="/integrations/odoo" title="Mappings + browse Odoo">
          <Icon.Settings size={11} />
        </a>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {connection.connected ? (
          <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
            Connected to <code>{connection.host}</code>
            {!connection.autoSyncEnabled && (
              <span style={{ marginLeft: 6, color: 'var(--warn)' }}>· auto-sync off</span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--danger)' }}>
            {connection.lastErrorMessage ?? 'Not connected — credentials saved but unverified.'}
          </div>
        )}

        {link ? (
          <div style={{ fontSize: 12.5, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span>
              Linked to <code>{link.odooModel}#{link.odooId}</code>
              {leadDeepLink && (
                <a href={leadDeepLink} target="_blank" rel="noopener noreferrer" style={{ marginLeft: 6 }}>
                  <Icon.ArrowUpRight size={11} /> open in Odoo
                </a>
              )}
            </span>
            {partnerLink && (
              <span style={{ color: 'var(--fg-muted)' }}>
                Contact: <code>res.partner#{partnerLink.odooId}</code>
              </span>
            )}
            {link.lastSyncedAt && (
              <span style={{ color: 'var(--fg-subtle)' }}>
                Last synced: {new Date(link.lastSyncedAt).toLocaleString()}
              </span>
            )}
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: 'var(--fg-muted)' }}>
            Not yet pushed to Odoo.
          </div>
        )}

        {recentLog && recentLog.status === 'error' && (
          <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>
            Last sync error: {recentLog.errorMessage}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          <button className="btn sm accent" disabled={busy || !connection.connected} onClick={push}>
            {busy ? <span className="spin" /> : <><Icon.Send size={11} /> {link ? 'Update in Odoo' : 'Push to Odoo'}</>}
          </button>
          {link && (
            <>
              <button className="btn sm ghost" disabled={busy} onClick={pull}>
                <Icon.ArrowUpRight size={11} /> Pull
              </button>
              <button className="btn sm ghost" disabled={busy || status === 'closed' || status === 'won'} onClick={() => setOutcome('won')}>
                <Icon.Check size={11} /> Mark Won
              </button>
              <button className="btn sm danger ghost" disabled={busy} onClick={() => setOutcome('lost')}>
                <Icon.X size={11} /> Mark Lost
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={unlink}>
                <Icon.X size={11} /> Unlink
              </button>
            </>
          )}
          {savedAt && <span style={{ fontSize: 12, color: 'var(--ok)', alignSelf: 'center' }}><Icon.Check size={11} /> Synced</span>}
        </div>

        {err && (
          <div style={{
            padding: 8, fontSize: 12, borderRadius: 6,
            background: 'var(--danger-tint)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
          }}>{err}</div>
        )}

        {pulledRecords && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>
              Latest from Odoo
            </div>
            <pre style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, padding: 10,
              background: 'var(--bg-sunk)', borderRadius: 6, overflow: 'auto',
              maxHeight: 240, margin: 0,
            }}>
              {JSON.stringify(pulledRecords, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
