'use client';

/**
 * Rate-card upload modal — admin drops the CSaaS-style xlsx (or pastes a
 * TSV/CSV), we parse to a string[][] matrix in the browser via SheetJS,
 * then POST /rate-cards/parse. The API runs the structural parser and
 * persists a draft. Warnings (e.g. "tier row had no price") flow back so
 * the admin can spot data issues before publishing.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { rateCards, describeError } from '@/lib/api';
import { Icon } from '@/components/icon';
import { Portal } from '@/components/portal';

interface AiManualState {
  prompt: string;
  pasted: string;
  copied: boolean;
}

interface Props {
  onClose(): void;
}

export function RateCardUploadModal({ onClose }: Props) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<string[][] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [savedCardId, setSavedCardId] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [aiManual, setAiManual] = useState<AiManualState | null>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setErr(null);
    setLoadingFile(true);
    try {
      const lower = file.name.toLowerCase();
      const isXlsx =
        lower.endsWith('.xlsx') ||
        lower.endsWith('.xls') ||
        lower.endsWith('.xlsm') ||
        file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        file.type === 'application/vnd.ms-excel';

      if (!isXlsx) {
        const text = await file.text();
        setMatrix(parseDelimited(text));
        setFileName(file.name);
      } else {
        // Dynamic import — keeps SheetJS out of the initial bundle.
        const xlsx = await import('xlsx');
        const buffer = await file.arrayBuffer();
        const wb = xlsx.read(buffer, { type: 'array' });
        // CSaaS template puts the rate card in the first non-empty sheet.
        const firstSheetName = wb.SheetNames.find((n) => {
          const ws = wb.Sheets[n];
          return ws && Object.keys(ws).some((k) => !k.startsWith('!'));
        });
        if (!firstSheetName) throw new Error('Workbook has no non-empty sheets.');
        const ws = wb.Sheets[firstSheetName]!;
        const m = xlsx.utils.sheet_to_json<unknown[]>(ws, {
          header: 1,
          raw: false,
          defval: '',
          blankrows: true,
        });
        setMatrix(m.map((row) => row.map((c) => String(c ?? ''))));
        setFileName(file.name);
        if (!name) setName(file.name.replace(/\.(xlsx|xls|xlsm|csv|tsv|txt)$/i, ''));
      }
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoadingFile(false);
    }
  }

  async function submit() {
    if (!matrix) return;
    setBusy(true);
    setErr(null);
    setWarnings([]);
    try {
      const res = await rateCards.parseSheet(matrix, name || undefined);
      // The card is already persisted at this point regardless of warnings.
      // Stash the id so "Open the draft anyway" can navigate without
      // re-uploading (which would create a duplicate draft).
      setSavedCardId(res.rateCardId);
      if (res.warnings.length > 0) {
        setWarnings(res.warnings);
        setBusy(false);
        return; // let the admin read the warnings before navigating
      }
      router.push(`/rate-cards/${res.rateCardId}`);
    } catch (e) {
      setErr(describeError(e));
      setBusy(false);
    }
  }

  function goToCard() {
    // Reuse the id from the first parse call — never re-upload, that'd
    // create a second draft for the same sheet.
    if (savedCardId) router.push(`/rate-cards/${savedCardId}`);
  }

  /** Alternative parser: ask the configured LLM to convert the matrix
   *  into a CreateRateCardInput. Use when the structural parser warns
   *  (or just when the source isn't the CSaaS layout). Splits cleanly
   *  into auto and manual paths matching the rest of the LLM features. */
  async function submitWithAi() {
    if (!matrix) return;
    setBusy(true);
    setErr(null);
    setWarnings([]);
    setAiManual(null);
    try {
      const res = await rateCards.parseWithAi(matrix, name || undefined);
      if (res.mode === 'manual') {
        setAiManual({ prompt: res.prompt, pasted: '', copied: false });
        setBusy(false);
        return;
      }
      // Auto: card already saved by the API. Surface any soft warnings
      // (e.g. dropped malformed tier rows) and let the admin open it.
      setSavedCardId(res.rateCardId);
      if (res.warnings.length > 0) {
        setWarnings(res.warnings);
        setBusy(false);
      } else {
        router.push(`/rate-cards/${res.rateCardId}`);
      }
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('ai_not_configured')) {
        setErr('AI isn\'t configured for this workspace. Set it up in Settings → AI first.');
      } else if (msg.includes('ai_provider_error')) {
        setErr(`Your AI provider returned an error: ${msg.replace(/^ai_provider_error:\s*/, '')}`);
      } else {
        setErr(msg);
      }
      setBusy(false);
    }
  }

  async function submitAiManual() {
    if (!aiManual || !aiManual.pasted.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await rateCards.parseWithAiManual(aiManual.pasted, name || undefined);
      setSavedCardId(res.rateCardId);
      if (res.warnings.length > 0) {
        setAiManual(null);
        setWarnings(res.warnings);
        setBusy(false);
      } else {
        router.push(`/rate-cards/${res.rateCardId}`);
      }
    } catch (e) {
      const msg = describeError(e);
      if (msg.includes('not_json') || msg.includes('invalid_json') || msg.includes('not_object')) {
        setErr('That doesn\'t look like the AI\'s JSON output. Paste the full reply including the outer { … }.');
      } else {
        setErr(msg);
      }
      setBusy(false);
    }
  }

  function copyAiPrompt(url: string | null) {
    if (!aiManual) return;
    navigator.clipboard.writeText(aiManual.prompt);
    setAiManual({ ...aiManual, copied: true });
    setTimeout(() => setAiManual((s) => (s ? { ...s, copied: false } : s)), 2000);
    if (url) window.open(url, '_blank', 'noopener');
  }

  const cellCount = matrix?.reduce((n, row) => n + row.length, 0) ?? 0;

  return (
    <Portal>
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'color-mix(in oklch, black 40%, transparent)',
        display: 'grid', placeItems: 'center', zIndex: 60, padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          width: '100%', maxWidth: 560,
          display: 'flex', flexDirection: 'column', background: 'var(--bg)',
        }}
      >
        <header style={{ padding: '14px 18px', borderBottom: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Upload rate card</div>
            <div style={{ fontSize: 11.5, color: 'var(--fg-muted)', marginTop: 2 }}>
              Drop the CSaaS rate card spreadsheet — we&apos;ll parse it into a draft you can review and publish.
            </div>
          </div>
          <button onClick={onClose} className="btn sm ghost" disabled={busy}><Icon.X size={11} /></button>
        </header>

        <div style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>Name (optional)</span>
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. CSaaS FY26 — internal"
              style={{ height: 32, padding: '0 10px', fontSize: 13 }}
            />
          </label>

          {!matrix ? (
            <label
              style={{
                border: '1.5px dashed var(--border-strong)',
                borderRadius: 'var(--radius)',
                padding: '32px 16px',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                cursor: loadingFile ? 'wait' : 'pointer',
                background: 'var(--bg-sunk)',
                textAlign: 'center',
              }}
            >
              <Icon.Download size={24} style={{ color: 'var(--fg-subtle)', transform: 'rotate(180deg)' }} />
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {loadingFile ? 'Reading file…' : 'Choose a file or drag it here'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--fg-subtle)' }}>
                .xlsx · .xls · .csv · .tsv
              </div>
              <input
                type="file"
                accept=".csv,.tsv,.txt,.xlsx,.xls,.xlsm"
                onChange={onPickFile}
                disabled={loadingFile}
                style={{ display: 'none' }}
              />
            </label>
          ) : (
            <div className="card" style={{ padding: 12, background: 'var(--bg-sunk)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon.FileText size={16} style={{ color: 'var(--fg-subtle)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fileName ?? 'Pasted sheet'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                  {matrix.length} rows · {cellCount} cells
                </div>
              </div>
              <button
                className="btn sm ghost"
                onClick={() => { setMatrix(null); setFileName(null); setWarnings([]); }}
                disabled={busy}
              >
                <Icon.X size={11} /> Clear
              </button>
            </div>
          )}

          {aiManual && (
            <div style={{
              padding: 12,
              background: 'var(--accent-tint)',
              border: '1px solid color-mix(in oklch, var(--accent) 22%, transparent)',
              borderRadius: 8,
              fontSize: 12.5,
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{ fontWeight: 600 }}>
                <Icon.Sparkles size={11} /> Manual AI mode — paste the prompt into your AI of choice
              </div>
              <div style={{ color: 'var(--fg-muted)' }}>
                Click below to copy the prompt + open the AI in a new tab. Paste the prompt, get the JSON response, paste it back here.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <button onClick={() => copyAiPrompt('https://chat.openai.com/')} className="btn sm" disabled={busy}>
                  <Icon.Copy size={11} /> Copy &amp; open ChatGPT <Icon.ArrowUpRight size={10} />
                </button>
                <button onClick={() => copyAiPrompt('https://claude.ai/new')} className="btn sm" disabled={busy}>
                  <Icon.Copy size={11} /> Copy &amp; open Claude <Icon.ArrowUpRight size={10} />
                </button>
                <button onClick={() => copyAiPrompt('https://gemini.google.com/app')} className="btn sm" disabled={busy}>
                  <Icon.Copy size={11} /> Copy &amp; open Gemini <Icon.ArrowUpRight size={10} />
                </button>
                <button onClick={() => copyAiPrompt(null)} className="btn sm ghost" disabled={busy}>
                  {aiManual.copied ? <><Icon.Check size={11} /> Copied</> : <><Icon.Copy size={11} /> Just copy</>}
                </button>
              </div>
              <details style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
                <summary style={{ cursor: 'pointer', padding: '4px 0' }}>Preview the prompt</summary>
                <pre style={{
                  marginTop: 6, padding: 10, background: 'var(--bg)', borderRadius: 6,
                  fontFamily: 'inherit', fontSize: 11.5, lineHeight: 1.45,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 200, overflow: 'auto',
                }}>{aiManual.prompt}</pre>
              </details>
              <textarea
                className="input mono"
                rows={6}
                value={aiManual.pasted}
                onChange={(e) => setAiManual({ ...aiManual, pasted: e.target.value })}
                placeholder='{ "name": "...", "currency": "INR", "serviceLines": [ ... ], "openPricedServices": [ ... ] }'
                style={{ fontSize: 11.5, lineHeight: 1.4, padding: 10 }}
                disabled={busy}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <button className="btn sm ghost" disabled={busy} onClick={() => setAiManual(null)}>
                  Cancel manual mode
                </button>
                <button className="btn sm accent" disabled={busy || !aiManual.pasted.trim()} onClick={submitAiManual}>
                  {busy ? <span className="spin" /> : <><Icon.Check size={11} /> Use this</>}
                </button>
              </div>
            </div>
          )}

          {warnings.length > 0 && (
            <div
              style={{
                padding: 12,
                background: 'var(--warn-tint)',
                color: 'var(--warn)',
                border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
                borderRadius: 8,
                fontSize: 12,
                display: 'flex', flexDirection: 'column', gap: 8,
              }}
            >
              <div style={{ fontWeight: 600 }}>
                Saved as draft with {warnings.length} warning{warnings.length === 1 ? '' : 's'}:
              </div>
              <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {warnings.slice(0, 6).map((w, i) => <li key={i}>{w}</li>)}
                {warnings.length > 6 && <li>…and {warnings.length - 6} more.</li>}
              </ul>
              <button onClick={goToCard} className="btn sm" disabled={busy} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                Open the draft anyway <Icon.ArrowRight size={11} />
              </button>
            </div>
          )}

          {err && (
            <div style={{
              padding: 10,
              background: 'var(--danger-tint)', color: 'var(--danger)',
              border: '1px solid color-mix(in oklch, var(--danger) 22%, transparent)',
              borderRadius: 8, fontSize: 12,
            }}>{err}</div>
          )}
        </div>

        <footer style={{ padding: '12px 18px', borderTop: '1px solid var(--divider)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <button onClick={onClose} className="btn sm ghost" disabled={busy}>Cancel</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={submitWithAi}
              disabled={busy || !matrix || !!aiManual}
              className="btn sm"
              title="Use the configured AI to parse non-CSaaS sheets"
            >
              {busy ? <span className="spin" /> : <><Icon.Sparkles size={11} /> Parse with AI</>}
            </button>
            <button
              onClick={submit}
              disabled={busy || !matrix || !!aiManual}
              className="btn sm accent"
              title="Deterministic structural parser — fastest when the sheet matches the CSaaS template"
            >
              {busy ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Parse &amp; save draft</>}
            </button>
          </div>
        </footer>
      </div>
    </div>
    </Portal>
  );
}

// Lightweight delimiter parse — same idea as the sheet-import modal but
// inlined to keep this modal standalone. Tabs preferred; falls back to
// a simple comma split (no quoted-cell handling — admins should use xlsx
// for anything fancy).
function parseDelimited(raw: string): string[][] {
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.trim()) return [];
  const lines = text.split('\n');
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  const hasTab = lines.some((l) => l.includes('\t'));
  return lines.map((l) => (hasTab ? l.split('\t') : l.split(',')));
}
