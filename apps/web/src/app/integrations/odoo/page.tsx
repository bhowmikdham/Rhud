'use client';

/**
 * Odoo settings + control panel.
 *
 * Tabs:
 *   1. Overview      — connection health, defaults, auto-sync toggle
 *   2. Mappings      — Rhud → Odoo field translation (CRUD)
 *   3. Browse        — query any Odoo model (admin)
 *   4. Sync log      — every push/pull/webhook call
 *   5. Webhooks      — pending webhook events + manual process
 */

import { useCallback, useEffect, useState } from 'react';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';
import { useConfirm } from '@/components/confirm';
import {
  describeError,
  integrations,
  type OdooConnectionStatus,
  type OdooFieldMapping,
  type OdooSyncLogRow,
  type OdooEntityLinkRow,
  type OdooWebhookEventRow,
  type OdooRecord,
  type UpsertOdooFieldMapping,
  type OdooStageOption,
  type OdooTeamOption,
  type OdooUserOption,
  type OdooImportedOpportunityRow,
  type OdooPollResult,
} from '@/lib/api';
import { OdooConnectModal } from '../odoo-modal';

type Tab = 'overview' | 'imported' | 'mappings' | 'browse' | 'logs' | 'webhooks' | 'links';

export default function OdooSettingsPage() {
  const user = useRequireAuth();
  const [tab, setTab] = useState<Tab>('overview');
  const [status, setStatus] = useState<OdooConnectionStatus | null>(null);
  const [showSetup, setShowSetup] = useState(false);

  const refresh = useCallback(() => {
    integrations.odoo.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => { if (user) refresh(); }, [user, refresh]);

  if (!user) return null;
  const isAdmin = user.role === 'admin';

  return (
    <AppShell crumbs={[{ label: 'Connections', href: '/integrations' }, { label: 'Odoo' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Odoo</h1>
            <p className="page-subtitle">
              Per-tenant connection to your Odoo Online database. Pushes opportunities to <code>crm.lead</code>,
              creates contacts in <code>res.partner</code>, and (optionally) receives webhooks from Odoo Studio.
            </p>
          </div>
          {isAdmin && (
            <button className="btn sm" onClick={() => setShowSetup(true)}>
              <Icon.Settings size={11} /> {status?.configured ? 'Manage connection' : 'Connect'}
            </button>
          )}
        </div>

        {!status?.configured && (
          <div className="card" style={{ padding: 14, fontSize: 12.5, marginBottom: 12 }}>
            Odoo isn&apos;t connected yet. Ask your admin to set it up via the <i>Connect</i> button above.
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 16, borderBottom: '1px solid var(--divider)' }}>
          {([
            ['overview', 'Overview'],
            ['imported', 'External (from Odoo)'],
            ['mappings', 'Field mappings'],
            ['browse', 'Browse Odoo'],
            ['links', 'Linked records'],
            ['logs', 'Sync log'],
            ['webhooks', 'Webhooks'],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className="btn sm ghost"
              style={{
                borderRadius: 0,
                borderBottom: tab === k ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === k ? 'var(--fg)' : 'var(--fg-muted)',
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'overview' && <OverviewTab status={status} onChanged={refresh} isAdmin={isAdmin} />}
        {tab === 'imported' && <ImportedTab isAdmin={isAdmin} />}
        {tab === 'mappings' && <MappingsTab isAdmin={isAdmin} />}
        {tab === 'browse' && <BrowseTab isAdmin={isAdmin} />}
        {tab === 'links' && <LinksTab />}
        {tab === 'logs' && <LogsTab />}
        {tab === 'webhooks' && <WebhooksTab isAdmin={isAdmin} />}

        {showSetup && (
          <OdooConnectModal
            onClose={() => setShowSetup(false)}
            onChanged={refresh}
          />
        )}
      </div>
    </AppShell>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────

function OverviewTab({
  status,
  onChanged,
  isAdmin,
}: {
  status: OdooConnectionStatus | null;
  onChanged(): void;
  isAdmin: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [stages, setStages] = useState<unknown[]>([]);
  const [teams, setTeams] = useState<OdooTeamOption[]>([]);
  const [users, setUsers] = useState<OdooUserOption[]>([]);
  const [defaultTeamId, setDefaultTeamId] = useState<number | null>(null);
  const [defaultUserId, setDefaultUserId] = useState<number | null>(null);
  const [autoSync, setAutoSync] = useState<boolean>(status?.autoSyncEnabled ?? true);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    setDefaultTeamId(status?.defaultTeamId ?? null);
    setDefaultUserId(status?.defaultUserId ?? null);
    setAutoSync(status?.autoSyncEnabled ?? true);
  }, [status]);

  useEffect(() => {
    if (!status?.connected) return;
    integrations.odoo.stages().then(setStages).catch(() => undefined);
    integrations.odoo.teams().then(setTeams).catch(() => undefined);
    integrations.odoo.users().then(setUsers).catch(() => undefined);
  }, [status?.connected]);

  if (!status) return <div className="empty" style={{ padding: 16 }}><span className="spin" /></div>;

  async function runTest() {
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.test();
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  async function saveDefaults() {
    if (!status?.host) return;
    setBusy(true); setErr(null);
    try {
      // Reuse upsert (it accepts partial). url/database/login required but
      // status returns the host without scheme; round-trip the same values.
      await integrations.odoo.upsert({
        url: `https://${status.host}`,
        database: status.database ?? '',
        login: status.login ?? '',
        autoSyncEnabled: autoSync,
        defaultTeamId,
        defaultUserId,
      });
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 1500);
      onChanged();
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Connection</h2>
        <Grid>
          <Field label="Configured">{status.configured ? 'Yes' : 'No'}</Field>
          <Field label="Connected">{status.connected ? 'Yes' : 'No'}</Field>
          <Field label="Host">{status.host ?? '—'}</Field>
          <Field label="Database">{status.database ?? '—'}</Field>
          <Field label="Login">{status.login ?? '—'}</Field>
          <Field label="Server version">{status.serverVersion ?? '—'}</Field>
          <Field label="Last connected">{status.lastConnectedAt ? new Date(status.lastConnectedAt).toLocaleString() : 'never'}</Field>
          <Field label="Last error">{status.lastErrorMessage ?? '—'}</Field>
        </Grid>
        {isAdmin && status.configured && (
          <div style={{ marginTop: 10 }}>
            <button className="btn sm" disabled={busy} onClick={runTest}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Run connection test</>}
            </button>
          </div>
        )}
        {err && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
      </div>

      {isAdmin && status.configured && (
        <div className="card" style={{ padding: 16 }}>
          <h2 style={{ margin: '0 0 12px', fontSize: 14, fontWeight: 600 }}>Defaults &amp; auto-sync</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Default sales team</span>
              <select
                className="input"
                value={defaultTeamId ?? ''}
                onChange={(e) => setDefaultTeamId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Default salesperson</span>
              <select
                className="input"
                value={defaultUserId ?? ''}
                onChange={(e) => setDefaultUserId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">— none —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.login})</option>)}
              </select>
            </label>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, marginTop: 12, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={autoSync}
              onChange={(e) => setAutoSync(e.target.checked)}
              style={{ width: 14, height: 14 }}
            />
            <span>Auto-sync engagements on submit / approve / reject</span>
          </label>
          <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
            <button className="btn sm accent" disabled={busy} onClick={saveDefaults}>
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Save defaults</>}
            </button>
            {savedAt && <span style={{ fontSize: 12, color: 'var(--ok)', alignSelf: 'center' }}><Icon.Check size={11} /> Saved</span>}
          </div>
        </div>
      )}

      {Array.isArray(stages) && stages.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>CRM stages in Odoo</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {(stages as Array<{ id: number; name: string; sequence: number; isWon?: boolean }>).map((s) => (
              <span key={s.id} className="chip" style={{ background: s.isWon ? 'var(--ok-tint)' : 'var(--bg-sunk)' }}>
                {s.name} {s.isWon ? '(won)' : ''}
              </span>
            ))}
          </div>
          <p style={{ marginTop: 8, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
            These are the stage labels new opportunities will progress through in Odoo.
          </p>
        </div>
      )}

      {status.webhookUrl && (
        <div className="card" style={{ padding: 16 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Inbound webhook URL</h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--fg-muted)' }}>
            Paste this into an Odoo Studio Automation Rule (Webhook action) to push <code>crm.lead</code> changes back to Rhud.
          </p>
          <div style={{ marginTop: 8, padding: '8px 10px', borderRadius: 6, background: 'var(--bg-sunk)', fontFamily: 'var(--font-mono)', fontSize: 11.5, wordBreak: 'break-all' }}>
            {status.webhookUrl}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Imported (External from Odoo) ───────────────────────────────────────

function ImportedTab({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<OdooImportedOpportunityRow[] | null>(null);
  const [includePromoted, setIncludePromoted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [polling, setPolling] = useState(false);
  const [pollResult, setPollResult] = useState<OdooPollResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [promoteFor, setPromoteFor] = useState<OdooImportedOpportunityRow | null>(null);

  const refresh = useCallback(() => {
    integrations.odoo.listImported({ includePromoted, limit: 200 })
      .then(setRows)
      .catch((e) => setErr(describeError(e)));
  }, [includePromoted]);

  useEffect(() => { refresh(); }, [refresh]);

  async function poll() {
    setPolling(true); setErr(null);
    try {
      const result = await integrations.odoo.poll();
      setPollResult(result);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setPolling(false);
    }
  }

  async function backfill() {
    setBusy(true); setErr(null);
    try {
      const result = await integrations.odoo.backfill({ pageSize: 50, maxPages: 20 });
      setPollResult({
        ok: true,
        changed: 0,
        imported: result.imported,
        promoted: 0,
        skippedEcho: 0,
        errors: 0,
        newCursor: null,
        message: `Backfilled ${result.imported} from ${result.pages} page(s)`,
      });
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshOne(row: OdooImportedOpportunityRow) {
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.refreshImported(row.odooId);
      refresh();
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Opportunities from Odoo</h2>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          New opportunities created in Odoo show up here. Polling runs every 5 minutes by
          default and only catches <b>new</b> records (the ones with a fresh <code>create_date</code>) — so a
          tenant with thousands of legacy leads doesn&apos;t flood Rhud with every old edit.
          Updates to already-promoted opportunities flow in via Studio webhooks or the per-row
          <i> Refresh</i> button. Use <b>Backfill all</b> once at first connect if you also want to
          pull the existing book.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {isAdmin && (
            <>
              <button className="btn sm accent" disabled={polling} onClick={poll}>
                {polling ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Poll Odoo now</>}
              </button>
              <button className="btn sm ghost" disabled={busy} onClick={backfill}>
                {busy ? <span className="spin" /> : <><Icon.Plus size={11} /> Backfill all</>}
              </button>
            </>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={includePromoted}
              onChange={(e) => setIncludePromoted(e.target.checked)}
            />
            <span>Show already-promoted</span>
          </label>
        </div>
        {pollResult && (
          <div style={{ marginTop: 10, padding: 8, fontSize: 12, borderRadius: 6, background: 'var(--bg-sunk)' }}>
            {pollResult.ok
              ? `✓ ${pollResult.imported} new opportunit${pollResult.imported === 1 ? 'y' : 'ies'} imported${pollResult.errors ? ` · ${pollResult.errors} error(s)` : ''}${pollResult.message ? ' · ' + pollResult.message : ''}`
              : `✗ ${pollResult.message}`}
          </div>
        )}
        {err && (
          <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{err}</div>
        )}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
              <th style={{ padding: 8 }}>Odoo id</th>
              <th style={{ padding: 8 }}>Name</th>
              <th style={{ padding: 8 }}>Email</th>
              <th style={{ padding: 8 }}>Stage</th>
              <th style={{ padding: 8 }}>Salesperson</th>
              <th style={{ padding: 8 }}>Revenue</th>
              <th style={{ padding: 8 }}>Last change</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}></th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--divider)' }}>
                <td style={{ padding: 8 }}><code>#{r.odooId}</code></td>
                <td style={{ padding: 8 }}>{r.name ?? '—'}</td>
                <td style={{ padding: 8 }}>{r.emailFrom ?? '—'}</td>
                <td style={{ padding: 8 }}>{r.stageName ?? '—'}</td>
                <td style={{ padding: 8 }}>{r.userName ?? '—'}</td>
                <td style={{ padding: 8 }}>{r.expectedRevenue != null ? r.expectedRevenue.toLocaleString() : '—'}</td>
                <td style={{ padding: 8 }}>{r.odooWriteDate ? new Date(r.odooWriteDate).toLocaleString() : '—'}</td>
                <td style={{ padding: 8 }}>
                  {r.promoted
                    ? <a href={`/opportunities/${r.promotedEngagementId}`} className="chip ok">Promoted</a>
                    : <span className="chip warn">External</span>}
                </td>
                <td style={{ padding: 8, textAlign: 'right' }}>
                  <div style={{ display: 'inline-flex', gap: 4 }}>
                    <button className="btn sm ghost" disabled={busy} onClick={() => refreshOne(r)} title="Re-fetch from Odoo">
                      <Icon.ArrowUpRight size={11} />
                    </button>
                    {!r.promoted && (
                      <button className="btn sm accent" disabled={busy} onClick={() => setPromoteFor(r)}>
                        Promote
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {(!rows || rows.length === 0) && (
              <tr><td colSpan={9} style={{ padding: 14, color: 'var(--fg-subtle)' }}>
                No imported opportunities yet. {isAdmin ? 'Try polling or backfilling.' : 'Ask your admin to run the first poll.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      {promoteFor && (
        <PromoteModal row={promoteFor} onClose={() => setPromoteFor(null)} onPromoted={() => { setPromoteFor(null); refresh(); }} />
      )}
    </div>
  );
}

function PromoteModal({
  row, onClose, onPromoted,
}: {
  row: OdooImportedOpportunityRow;
  onClose(): void;
  onPromoted(): void;
}) {
  const [tmpls, setTmpls] = useState<Array<{ id: string; name: string; status: string }> | null>(null);
  const [users, setUsers] = useState<Array<{ id: string; email: string; role: string }> | null>(null);
  const [templateId, setTemplateId] = useState<string>('');
  const [salesEmployeeId, setSalesEmployeeId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    // Pull published templates + tenant users for the dropdowns.
    Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).fetch
        ? fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/v1/templates`, {
            headers: { authorization: `Bearer ${window.localStorage.getItem('rhud.token') ?? ''}` },
          }).then((r) => r.json())
        : Promise.resolve([]),
      fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000'}/api/v1/tenant/users`, {
        headers: { authorization: `Bearer ${window.localStorage.getItem('rhud.token') ?? ''}` },
      }).then((r) => r.json()),
    ]).then(([t, u]) => {
      const published = (t as Array<{ id: string; name: string; status: string }>).filter((x) => x.status === 'published');
      setTmpls(published);
      const first = published[0];
      if (first) setTemplateId(first.id);
      setUsers(u as Array<{ id: string; email: string; role: string }>);
    }).catch(() => { setTmpls([]); setUsers([]); });
  }, []);

  async function go() {
    if (!templateId) { setErr('Pick a template'); return; }
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.promoteImported(row.odooId, {
        templateId,
        ...(salesEmployeeId ? { salesEmployeeId } : {}),
        ...(row.name ? { name: row.name } : {}),
      });
      onPromoted();
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
          display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      >
        <div className="card" style={{ width: '100%', maxWidth: 520, background: 'var(--bg)' }}>
          <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)' }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Promote to Rhud Engagement</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 4 }}>
              Odoo crm.lead #{row.odooId} — {row.name ?? '(no name)'}
            </div>
          </header>
          <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Template</span>
              <select
                className="input"
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
                disabled={!tmpls}
              >
                {tmpls == null && <option>Loading…</option>}
                {tmpls && tmpls.length === 0 && <option value="">No published templates — publish one first</option>}
                {(tmpls ?? []).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Sales rep (defaults to you)</span>
              <select
                className="input"
                value={salesEmployeeId}
                onChange={(e) => setSalesEmployeeId(e.target.value)}
                disabled={!users}
              >
                <option value="">— me —</option>
                {(users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.email} ({u.role})</option>
                ))}
              </select>
            </label>
            <p style={{ fontSize: 11.5, color: 'var(--fg-subtle)', margin: 0 }}>
              Engagement will start in <code>submitted</code> (scope is already in Odoo, not the Rhud gathering form).
              Subsequent updates in Odoo will sync to this engagement automatically.
            </p>
            {err && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
          </div>
          <footer style={{
            padding: '12px 18px', borderTop: '1px solid var(--divider)',
            display: 'flex', gap: 8, justifyContent: 'flex-end',
          }}>
            <button className="btn sm ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn sm accent"
              onClick={go}
              disabled={busy || !templateId || !tmpls || tmpls.length === 0}
            >
              {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Promote</>}
            </button>
          </footer>
        </div>
      </div>
    </Portal>
  );
}

// ── Mappings ─────────────────────────────────────────────────────────────

function MappingsTab({ isAdmin }: { isAdmin: boolean }) {
  const [list, setList] = useState<OdooFieldMapping[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<UpsertOdooFieldMapping>({
    rhudEntity: 'engagement', rhudField: '', odooModel: 'crm.lead', odooField: '',
    direction: 'push', required: false, transform: null,
  });

  const refresh = useCallback(() => {
    integrations.odoo.listMappings().then(setList).catch((e) => setErr(describeError(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function add() {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.createMapping(draft);
      setDraft({ ...draft, rhudField: '', odooField: '' });
      refresh();
    } catch (e) { setErr(describeError(e)); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    setBusy(true);
    try { await integrations.odoo.deleteMapping(id); refresh(); }
    catch (e) { setErr(describeError(e)); }
    finally { setBusy(false); }
  }

  if (list == null) return <div className="empty"><span className="spin" /></div>;

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Field mappings</h2>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--fg-muted)' }}>
          Custom mappings override built-in defaults. <b>Defaults applied automatically</b>:
          {' '}<code>name → name</code>,
          {' '}<code>clientEmail → email_from</code>,
          {' '}<code>approvedPriceCents → expected_revenue</code>{' '}
          (with <code>cents_to_currency</code> transform). Add rows below to extend or override.
        </p>

        <table style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
              <th>Rhud entity</th>
              <th>Rhud field</th>
              <th>Odoo model</th>
              <th>Odoo field</th>
              <th>Transform</th>
              <th>Direction</th>
              <th>Required</th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.id}>
                <td><code>{m.rhudEntity}</code></td>
                <td><code>{m.rhudField}</code></td>
                <td><code>{m.odooModel}</code></td>
                <td><code>{m.odooField}</code></td>
                <td>{m.transform ?? '—'}</td>
                <td>{m.direction}</td>
                <td>{m.required ? 'yes' : 'no'}</td>
                {isAdmin && (
                  <td>
                    <button className="btn sm danger ghost" disabled={busy} onClick={() => remove(m.id)}>
                      <Icon.X size={11} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan={8} style={{ padding: 12, color: 'var(--fg-subtle)' }}>No custom mappings — defaults apply.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {isAdmin && (
        <div className="card" style={{ padding: 16 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 600 }}>Add mapping</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <Input label="Rhud entity" value={draft.rhudEntity} onChange={(v) => setDraft({ ...draft, rhudEntity: v })} />
            <Input label="Rhud field" value={draft.rhudField} onChange={(v) => setDraft({ ...draft, rhudField: v })} />
            <Input label="Odoo model" value={draft.odooModel} onChange={(v) => setDraft({ ...draft, odooModel: v })} />
            <Input label="Odoo field" value={draft.odooField} onChange={(v) => setDraft({ ...draft, odooField: v })} />
            <Input label="Transform (optional)" value={draft.transform ?? ''} onChange={(v) => setDraft({ ...draft, transform: v || null })} placeholder="cents_to_currency / constant:foo / ..." />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Direction</span>
              <select className="input" value={draft.direction ?? 'push'} onChange={(e) => setDraft({ ...draft, direction: e.target.value as 'push' | 'pull' | 'both' })}>
                <option value="push">push (Rhud → Odoo)</option>
                <option value="pull">pull (Odoo → Rhud)</option>
                <option value="both">both</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={!!draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
              <span style={{ fontSize: 12 }}>Required</span>
            </label>
            <button className="btn sm accent" disabled={busy || !draft.rhudField || !draft.odooField} onClick={add}>
              {busy ? <span className="spin" /> : <><Icon.Plus size={11} /> Add</>}
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="card" style={{ padding: 10, fontSize: 12, color: 'var(--danger)' }}>{err}</div>
      )}
    </div>
  );
}

// ── Browse Odoo ──────────────────────────────────────────────────────────

function BrowseTab({ isAdmin }: { isAdmin: boolean }) {
  const [model, setModel] = useState('crm.lead');
  const [fields, setFields] = useState('id,name,email_from,expected_revenue,stage_id,user_id');
  const [domain, setDomain] = useState('[]');
  const [limit, setLimit] = useState(20);
  const [rows, setRows] = useState<OdooRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!isAdmin) {
    return <div className="card" style={{ padding: 16 }}>Browsing the Odoo data store is admin-only.</div>;
  }

  async function run() {
    if (busy) return;
    setBusy(true); setErr(null); setRows(null);
    try {
      let parsedDomain: unknown[] = [];
      const trimmed = domain.trim();
      if (trimmed) {
        try { parsedDomain = JSON.parse(trimmed); }
        catch { throw new Error('Invalid JSON in domain'); }
      }
      const fieldList = fields.split(',').map((s) => s.trim()).filter(Boolean);
      const result = await integrations.odoo.search(model, { domain: parsedDomain, fields: fieldList, limit });
      setRows(result);
    } catch (e) {
      setErr(describeError(e));
    } finally { setBusy(false); }
  }

  const allFields = rows && rows.length > 0
    ? Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
    : fields.split(',').map((s) => s.trim());

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Query any model</h2>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--fg-muted)' }}>
          Run a <code>search_read</code> against your Odoo database. Try <code>crm.lead</code>, <code>res.partner</code>, <code>sale.order</code>, <code>account.move</code>, or anything else.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          <Input label="Model" value={model} onChange={setModel} />
          <Input label="Fields (comma-separated)" value={fields} onChange={setFields} />
          <Input label="Domain (JSON array)" value={domain} onChange={setDomain} placeholder='[["active","=",true]]' />
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>Limit</span>
            <input className="input" type="number" min={1} max={500} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
          </label>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn sm accent" disabled={busy} onClick={run}>
            {busy ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Run query</>}
          </button>
        </div>
      </div>

      {err && <div className="card" style={{ padding: 10, fontSize: 12, color: 'var(--danger)' }}>{err}</div>}

      {rows && (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', fontSize: 11.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
                {allFields.map((f) => <th key={f} style={{ padding: '8px' }}>{f}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--divider)' }}>
                  {allFields.map((f) => (
                    <td key={f} style={{ padding: '6px 8px', verticalAlign: 'top' }}>
                      {formatCell((r as Record<string, unknown>)[f])}
                    </td>
                  ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={allFields.length} style={{ padding: 14, color: 'var(--fg-subtle)' }}>No rows.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function formatCell(v: unknown): string {
  if (v == null || v === false) return '—';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    // Odoo returns relations as [id, displayName] tuples.
    if (v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'string') return `${v[1]} (${v[0]})`;
    return JSON.stringify(v);
  }
  return JSON.stringify(v).slice(0, 200);
}

// ── Linked records ──────────────────────────────────────────────────────

function LinksTab() {
  const [rows, setRows] = useState<OdooEntityLinkRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    integrations.odoo.entityLinks(200).then(setRows).catch((e) => setErr(describeError(e)));
  }, []);

  if (rows == null && !err) return <div className="empty"><span className="spin" /></div>;
  if (err) return <div className="card" style={{ padding: 10, color: 'var(--danger)' }}>{err}</div>;

  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
            <th style={{ padding: 8 }}>Rhud entity</th>
            <th style={{ padding: 8 }}>Rhud id</th>
            <th style={{ padding: 8 }}>Odoo model</th>
            <th style={{ padding: 8 }}>Odoo id</th>
            <th style={{ padding: 8 }}>Last synced</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--divider)' }}>
              <td style={{ padding: 8 }}><code>{r.rhudEntity}</code></td>
              <td style={{ padding: 8 }}>
                {r.rhudEntity === 'engagement'
                  ? <a href={`/opportunities/${r.rhudId}`}>{r.rhudId.slice(0, 8)}…</a>
                  : <code>{r.rhudId}</code>}
              </td>
              <td style={{ padding: 8 }}><code>{r.odooModel}</code></td>
              <td style={{ padding: 8 }}>{r.odooId}</td>
              <td style={{ padding: 8 }}>{r.lastSyncedAt ? new Date(r.lastSyncedAt).toLocaleString() : '—'}</td>
            </tr>
          ))}
          {(!rows || rows.length === 0) && (
            <tr><td colSpan={5} style={{ padding: 14, color: 'var(--fg-subtle)' }}>No linked records yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Sync log ─────────────────────────────────────────────────────────────

function LogsTab() {
  const [rows, setRows] = useState<OdooSyncLogRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    integrations.odoo.syncLogs(200).then(setRows).catch((e) => setErr(describeError(e)));
  }, []);

  if (rows == null && !err) return <div className="empty"><span className="spin" /></div>;
  if (err) return <div className="card" style={{ padding: 10, color: 'var(--danger)' }}>{err}</div>;

  return (
    <div className="card" style={{ padding: 0, overflow: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12 }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
            <th style={{ padding: 8 }}>When</th>
            <th style={{ padding: 8 }}>Direction</th>
            <th style={{ padding: 8 }}>Op</th>
            <th style={{ padding: 8 }}>Trigger</th>
            <th style={{ padding: 8 }}>Status</th>
            <th style={{ padding: 8 }}>Entity</th>
            <th style={{ padding: 8 }}>Odoo</th>
            <th style={{ padding: 8 }}>Error</th>
            <th style={{ padding: 8 }}>ms</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((r) => (
            <tr key={r.id} style={{ borderTop: '1px solid var(--divider)' }}>
              <td style={{ padding: 8 }}>{new Date(r.createdAt).toLocaleString()}</td>
              <td style={{ padding: 8 }}>{r.direction}</td>
              <td style={{ padding: 8 }}>{r.operation}</td>
              <td style={{ padding: 8 }}>{r.triggeredBy}</td>
              <td style={{ padding: 8 }}>
                <span className={`chip ${r.status === 'ok' ? 'ok' : r.status === 'error' ? 'danger' : ''}`}>
                  {r.status}
                </span>
              </td>
              <td style={{ padding: 8 }}>{r.rhudEntity ? <><code>{r.rhudEntity}</code> {r.rhudId?.slice(0, 8)}…</> : '—'}</td>
              <td style={{ padding: 8 }}>{r.odooModel ? <><code>{r.odooModel}</code>{r.odooId ? ` #${r.odooId}` : ''}</> : '—'}</td>
              <td style={{ padding: 8, color: 'var(--danger)', fontSize: 11 }}>{r.errorMessage ?? ''}</td>
              <td style={{ padding: 8 }}>{r.durationMs ?? '—'}</td>
            </tr>
          ))}
          {(!rows || rows.length === 0) && (
            <tr><td colSpan={9} style={{ padding: 14, color: 'var(--fg-subtle)' }}>No sync activity yet.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Webhooks ────────────────────────────────────────────────────────────

function WebhooksTab({ isAdmin }: { isAdmin: boolean }) {
  const [rows, setRows] = useState<OdooWebhookEventRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    integrations.odoo.webhookEvents(100).then(setRows).catch((e) => setErr(describeError(e)));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function process() {
    setBusy(true); setErr(null);
    try {
      await integrations.odoo.processWebhooks();
      refresh();
    } catch (e) { setErr(describeError(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="card" style={{ padding: 16 }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>Inbound webhook events</h2>
        <p style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--fg-muted)' }}>
          Events posted to <code>/integrations/odoo/webhooks/&lt;tenant&gt;/&lt;secret&gt;</code> by Odoo Studio Automation Rules.
          Events are persisted on receive — pending ones can be processed manually here.
        </p>
        {isAdmin && (
          <button className="btn sm" disabled={busy} onClick={process}>
            {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Process pending</>}
          </button>
        )}
        {err && <div style={{ marginTop: 8, color: 'var(--danger)', fontSize: 12 }}>{err}</div>}
      </div>

      <div className="card" style={{ padding: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--fg-muted)' }}>
              <th style={{ padding: 8 }}>Received</th>
              <th style={{ padding: 8 }}>Status</th>
              <th style={{ padding: 8 }}>Model</th>
              <th style={{ padding: 8 }}>Odoo id</th>
              <th style={{ padding: 8 }}>Event</th>
              <th style={{ padding: 8 }}>Error</th>
            </tr>
          </thead>
          <tbody>
            {(rows ?? []).map((r) => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--divider)' }}>
                <td style={{ padding: 8 }}>{new Date(r.receivedAt).toLocaleString()}</td>
                <td style={{ padding: 8 }}>
                  <span className={`chip ${r.status === 'processed' ? 'ok' : r.status === 'failed' ? 'danger' : ''}`}>
                    {r.status}
                  </span>
                </td>
                <td style={{ padding: 8 }}><code>{r.odooModel}</code></td>
                <td style={{ padding: 8 }}>{r.odooId ?? '—'}</td>
                <td style={{ padding: 8 }}>{r.eventType}</td>
                <td style={{ padding: 8, color: 'var(--danger)', fontSize: 11 }}>{r.errorMessage ?? ''}</td>
              </tr>
            ))}
            {(!rows || rows.length === 0) && (
              <tr><td colSpan={6} style={{ padding: 14, color: 'var(--fg-subtle)' }}>No webhook events yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function Grid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>{children}</div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{label}</span>
      <span style={{ fontSize: 13 }}>{children}</span>
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{label}</span>
      <input
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{ height: 30, fontSize: 12, padding: '0 8px' }}
      />
    </label>
  );
}
