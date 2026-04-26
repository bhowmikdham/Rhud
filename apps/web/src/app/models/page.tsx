'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  ml,
  describeError,
  type MlModelMeta,
  type MlStatusResponse,
  type MlTrainRecord,
} from '@/lib/api';
import { useRequireAuth } from '@/lib/auth-context';
import { AppShell } from '@/components/app-shell';
import { Icon } from '@/components/icon';

export default function ModelsPage() {
  const user = useRequireAuth();
  const [status, setStatus] = useState<MlStatusResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const s = await ml.status();
      setStatus(s);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void reload();
  }, [user, reload]);

  if (!user) return null;

  const isAdmin = user.role === 'admin';

  return (
    <AppShell crumbs={[{ label: 'Price models' }]}>
      <div className="page-inner">
        <div className="page-header">
          <div>
            <h1 className="page-title">Price models</h1>
            <p className="page-subtitle">
              Per-tenant XGBoost models that turn submitted scopes into a price band.
            </p>
          </div>
        </div>

        {!isAdmin && (
          <div
            className="card"
            style={{
              padding: '10px 14px', fontSize: 12, color: 'var(--fg-muted)',
              marginBottom: 16, display: 'flex', alignItems: 'center', gap: 10,
              background: 'var(--bg-sunk)',
            }}
          >
            <Icon.Lock size={12} style={{ color: 'var(--fg-subtle)' }} />
            Read-only — only admins can train or change the active model.
          </div>
        )}

        {err && (
          <div
            className="card"
            style={{
              padding: 12, color: 'var(--danger)', fontSize: 12.5, marginBottom: 16,
              background: 'var(--danger-tint)',
              borderColor: 'color-mix(in oklch, var(--danger) 22%, transparent)',
            }}
          >
            {err}
          </div>
        )}

        {loading && <div className="card" style={{ padding: 24 }}><span className="spin" /></div>}

        {!loading && status?.ok === false && (
          <ServiceDownCard reason={status.reason ?? null} />
        )}

        {!loading && status?.ok && (
          <>
            <ActiveModelCard active={status.activeMeta ?? null} />
            <HistoryCard history={status.history ?? []} />
            {isAdmin && <TrainCard onTrained={() => void reload()} />}
          </>
        )}
      </div>
    </AppShell>
  );
}

function ServiceDownCard({ reason }: { reason: string | null }) {
  return (
    <div
      className="card"
      style={{ padding: 22, display: 'flex', alignItems: 'flex-start', gap: 14 }}
    >
      <div
        style={{
          width: 44, height: 44, borderRadius: 12,
          background: 'var(--warn-tint)', color: 'var(--warn)',
          display: 'grid', placeItems: 'center', flexShrink: 0,
        }}
      >
        <Icon.Brain size={22} />
      </div>
      <div>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>ML service unavailable</h3>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
          The FastAPI service at <code className="mono">localhost:8001</code> isn&apos;t answering.{' '}
          {reason && <>Reason: <span className="mono">{reason}</span>.</>}{' '}
          Start it with <span className="mono">pnpm ml:dev</span>, then refresh this page.
        </p>
      </div>
    </div>
  );
}

function ActiveModelCard({ active }: { active: MlModelMeta | null }) {
  if (!active) {
    return (
      <div
        className="card"
        style={{ padding: 24, marginBottom: 16, display: 'flex', alignItems: 'flex-start', gap: 14 }}
      >
        <div
          style={{
            width: 44, height: 44, borderRadius: 12,
            background: 'var(--accent-tint)', color: 'var(--accent)',
            display: 'grid', placeItems: 'center', flexShrink: 0,
          }}
        >
          <Icon.Brain size={22} />
        </div>
        <div>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>No model trained yet</h3>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.55 }}>
            Submit a scope first and we&apos;ll let you bootstrap from a single quote, or train
            with at least 20 historical quotes for a real XGBoost model.
          </p>
        </div>
      </div>
    );
  }

  const trainedAt = new Date(active.trainedAt);
  const isCold = !active.active;

  return (
    <div className="ml-hero" style={{ marginBottom: 16 }}>
      <div className="ml-label">
        {isCold ? <span className="pulse" /> : <Icon.Sparkle size={10} />}
        {isCold ? 'Cold-start fallback active' : 'Active model'}
        <span style={{ color: 'var(--fg-muted)', fontWeight: 500 }}>· v{active.sequence}</span>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16,
        marginTop: 18,
      }}>
        <Stat label="Trained on" value={`${active.nTrain.toLocaleString()} quotes`} />
        <Stat
          label="MAE"
          value={active.mae == null ? '—' : `$${(active.mae / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        />
        <Stat
          label="RMSE"
          value={active.rmse == null ? '—' : `$${(active.rmse / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
        />
        <Stat label="Trained" value={trainedAt.toLocaleString()} />
      </div>

      {isCold && (
        <div
          style={{
            marginTop: 16, padding: '10px 14px', borderRadius: 8,
            background: 'var(--warn-tint)',
            border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
            fontSize: 12.5, color: 'var(--fg-muted)',
          }}
        >
          Fewer than 20 historical quotes are available, so predictions use the tenant median
          with a wide band (confidence 0.40). Upload more training rows below to activate the
          full XGBoost model.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="stat-label">{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.015em', marginTop: 4 }}>{value}</div>
    </div>
  );
}

function HistoryCard({ history }: { history: MlModelMeta[] }) {
  if (history.length === 0) return null;
  return (
    <div className="card" style={{ overflow: 'hidden', marginBottom: 16 }}>
      <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--border)' }}>
        <h3 style={{ margin: 0, fontSize: 13.5, fontWeight: 600, letterSpacing: '-0.01em' }}>
          Train history
        </h3>
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
          {history.length} version{history.length === 1 ? '' : 's'}
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 70 }}>Version</th>
            <th style={{ width: 90 }}>n_train</th>
            <th style={{ width: 110 }}>MAE</th>
            <th style={{ width: 110 }}>RMSE</th>
            <th style={{ width: 130 }}>Status</th>
            <th>Trained</th>
          </tr>
        </thead>
        <tbody>
          {history.map((m) => (
            <tr key={m.sequence}>
              <td className="cell-mono">v{m.sequence}</td>
              <td className="num">{m.nTrain.toLocaleString()}</td>
              <td className="num">
                {m.mae == null
                  ? <span style={{ color: 'var(--fg-faint)' }}>—</span>
                  : `$${(m.mae / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              </td>
              <td className="num">
                {m.rmse == null
                  ? <span style={{ color: 'var(--fg-faint)' }}>—</span>
                  : `$${(m.rmse / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              </td>
              <td>
                <span className={'chip ' + (m.active ? 'ok' : 'warn')}>
                  <Icon.Dot size={8} />
                  {m.active ? 'XGBoost' : 'cold-start'}
                </span>
              </td>
              <td className="cell-muted" style={{ fontSize: 12 }}>
                {new Date(m.trainedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Modifier-mode sample: with `base_price` set on every row, the trainer
// targets log(final_price / base_price) — i.e. the discount/premium the
// customer actually closed at, not the absolute number. Drop `base_price`
// from any row to fall back to legacy absolute mode.
const SAMPLE_CSV = `users,timeline,stack,base_price,final_price,won_lost
20,standard,react,50000,48000,true
35,urgent,react|node,100000,92000,true
50,flexible,vue,80000,78000,true
15,standard,react,40000,42000,true
80,urgent,react|node|kubernetes,150000,160000,false`;

function TrainCard({ onTrained }: { onTrained: () => void }) {
  const [csv, setCsv] = useState(SAMPLE_CSV);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);

  function parseCsv(input: string): { records: MlTrainRecord[]; mode: 'modifier' | 'absolute' } {
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV needs a header and at least one row');
    const header = lines[0]!.split(',').map((s) => s.trim());
    const priceIdx = header.findIndex((h) => h === 'final_price' || h === 'price');
    if (priceIdx < 0) throw new Error('CSV must include a final_price column');
    const baseIdx     = header.findIndex((h) => h === 'base_price');
    const wonIdx      = header.findIndex((h) => h === 'won_lost' || h === 'won');
    const closedIdx   = header.findIndex((h) => h === 'closed_at' || h === 'closed');
    const slIdx       = header.findIndex((h) => h === 'service_line');

    // Columns that are not scope fields — everything else flows into scopeFields.
    const reserved = new Set([priceIdx, baseIdx, wonIdx, closedIdx, slIdx].filter((i) => i >= 0));

    const records: MlTrainRecord[] = [];
    let allHaveBase = baseIdx >= 0;
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i]!.split(',').map((s) => s.trim());
      if (cells.length !== header.length) {
        throw new Error(`Row ${i + 1}: column count mismatch`);
      }
      const scope: Record<string, unknown> = {};
      let price = 0;
      let basePrice: number | undefined;
      let wonLost: boolean | undefined;
      let closedAt: string | undefined;
      let serviceLine: string | undefined;
      for (let j = 0; j < header.length; j++) {
        const k = header[j]!;
        const raw = cells[j]!;
        if (j === priceIdx) {
          price = Number(raw);
          if (!Number.isFinite(price)) throw new Error(`Row ${i + 1}: invalid final_price ${raw}`);
          continue;
        }
        if (j === baseIdx) {
          if (raw !== '') {
            const n = Number(raw);
            if (!Number.isFinite(n) || n <= 0) {
              // A bad/missing base price knocks the whole batch into absolute mode.
              allHaveBase = false;
            } else {
              basePrice = n;
            }
          } else {
            allHaveBase = false;
          }
          continue;
        }
        if (j === wonIdx) {
          if (raw !== '') wonLost = raw === 'true' || raw === '1' || raw.toLowerCase() === 'won';
          continue;
        }
        if (j === closedIdx) {
          if (raw !== '') closedAt = raw;
          continue;
        }
        if (j === slIdx) {
          if (raw !== '') serviceLine = raw;
          continue;
        }
        if (reserved.has(j) || raw === '') continue;
        if (raw.includes('|')) {
          scope[k] = raw.split('|').map((s) => s.trim()).filter(Boolean);
        } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
          scope[k] = Number(raw);
        } else {
          scope[k] = raw;
        }
      }
      const rec: MlTrainRecord = { scopeFields: scope, finalPrice: price };
      if (basePrice !== undefined) rec.basePrice = basePrice;
      if (wonLost !== undefined) rec.wonLost = wonLost;
      if (closedAt !== undefined) rec.closedAt = closedAt;
      if (serviceLine !== undefined) rec.serviceLine = serviceLine;
      records.push(rec);
    }
    return { records, mode: allHaveBase ? 'modifier' : 'absolute' };
  }

  async function onTrain() {
    setBusy(true);
    setResult(null);
    setParseErr(null);
    try {
      const { records, mode } = parseCsv(csv);
      const r = await ml.train(records);
      if (!r.ok) {
        setParseErr(`Training failed${r.reason ? `: ${r.reason}` : '.'}`);
      } else {
        const modeBadge = mode === 'modifier' ? 'modifier' : 'absolute';
        const summary = r.coldStart
          ? `Cold-start fallback v${r.sequence} saved (${r.nTrain} contracts — needs 20+ for XGBoost). Mode: ${modeBadge}.`
          : `XGBoost v${r.sequence} trained on ${r.nTrain} contracts (${modeBadge}).${
              r.maeCents != null
                ? ` MAE $${(r.maeCents / 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}.`
                : ''
            }`;
        setResult(summary);
        onTrained();
      }
    } catch (e) {
      setParseErr(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ padding: 22 }}>
      <div className="section-label" style={{ marginBottom: 4 }}>Train a new model</div>
      <h3 style={{ margin: '6px 0 4px', fontSize: 14, fontWeight: 600 }}>Import historical contracts</h3>
      <p style={{ margin: '0 0 12px', fontSize: 12.5, color: 'var(--fg-muted)' }}>
        Header row defines scope fields. Reserved columns:{' '}
        <code className="mono">final_price</code> (required, dollars),{' '}
        <code className="mono">base_price</code> (recommended, switches to modifier mode),{' '}
        <code className="mono">won_lost</code>, <code className="mono">closed_at</code>,{' '}
        <code className="mono">service_line</code>. Multi-select cells use{' '}
        <code className="mono">|</code> as a separator. 20+ rows trains a real XGBoost model;
        fewer triggers the cold-start fallback.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <label className="btn sm">
          <Icon.Paperclip size={11} /> Upload CSV
          <input
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const reader = new FileReader();
              reader.onload = () => {
                const text = typeof reader.result === 'string' ? reader.result : '';
                setCsv(text);
              };
              reader.readAsText(f);
            }}
          />
        </label>
      </div>

      <textarea
        className="input"
        rows={9}
        spellCheck={false}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />

      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: 12, marginTop: 12, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
          Tip: re-train any time. Each train creates a new version; the latest becomes active automatically.
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setCsv(SAMPLE_CSV)}>Reset to sample</button>
          <button type="button" className="btn accent" onClick={onTrain} disabled={busy}>
            {busy ? <><span className="spin" /> Training…</> : <><Icon.Brain size={12} /> Train</>}
          </button>
        </div>
      </div>

      {result && (
        <div
          style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8,
            background: 'var(--ok-tint)', color: 'var(--ok)',
            border: '1px solid color-mix(in oklch, var(--ok) 22%, transparent)',
            fontSize: 12.5, display: 'flex', alignItems: 'center', gap: 8,
          }}
        >
          <Icon.Check size={12} /> {result}
        </div>
      )}
      {parseErr && (
        <div
          style={{
            marginTop: 14, padding: '10px 14px', borderRadius: 8,
            background: 'var(--danger-tint)', color: 'var(--danger)',
            border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
            fontSize: 12.5,
          }}
        >
          {parseErr}
        </div>
      )}

      <p style={{ marginTop: 16, fontSize: 11.5, color: 'var(--fg-subtle)' }}>
        Need to wire this to <Link href="/integrations" className="mono" style={{ color: 'inherit', textDecoration: 'underline' }}>Odoo</Link>{' '}
        instead of pasting CSV? That lands when the Odoo integration ships.
      </p>
    </div>
  );
}
