'use client';

/**
 * Always-visible AI lead summary card for the opportunity detail page.
 *
 * Behaviour:
 *   - On mount, hits /summary (cheap, returns cached or null) and
 *     renders immediately.
 *   - In parallel, hits /summary/auto. If the activity chain has
 *     moved since the last generation AND the tenant has auto-gen
 *     enabled, the server invokes the LLM and the new summary
 *     replaces the cached one in place.
 *   - "Refresh" button forces a regenerate (bypasses cool-down by
 *     calling the explicit /summary path).
 *   - Manual-mode tenants get the paste-back flow.
 *
 * No clicks required to see the summary — it's already there.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  describeError,
  leadSummary as leadSummaryApi,
  type AutoSummaryResult,
  type GenerateSummaryResult,
  type LeadSummaryRow,
  type SummaryNextAction,
  type SummaryRiskLevel,
} from '@/lib/api';
import { Icon } from '@/components/icon';

interface Props {
  engagementId: string;
}

export function LeadSummaryInline({ engagementId }: Props) {
  const [summary, setSummary] = useState<LeadSummaryRow | null>(null);
  const [loading, setLoading] = useState(true);
  // True while the auto-regenerate roundtrip is in flight.
  const [autoRegenerating, setAutoRegenerating] = useState(false);
  const [forceRegenerating, setForceRegenerating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Manual-mode prompt + paste-back state (when tenant uses provider='manual').
  const [manualPrompt, setManualPrompt] = useState<string | null>(null);
  const [manualText, setManualText] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  // Reason the auto-path skipped regeneration; surfaced as a tiny
  // hint so admins understand why the summary didn't refresh.
  const [autoSkip, setAutoSkip] = useState<AutoSummaryResult['skipReason']>(null);

  const loadCached = useCallback(async () => {
    try {
      const cached = await leadSummaryApi.current(engagementId);
      setSummary(cached);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setLoading(false);
    }
  }, [engagementId]);

  const tryAutoRegenerate = useCallback(async () => {
    try {
      setAutoRegenerating(true);
      const result = await leadSummaryApi.auto(engagementId);
      if (result.summary) setSummary(result.summary);
      setAutoSkip(result.regenerated ? null : result.skipReason ?? null);
    } catch {
      // Silent — the cached summary is still rendered. If the auto
      // path errored we don't want to nag the user; the explicit
      // Refresh button will show the error if they retry.
    } finally {
      setAutoRegenerating(false);
    }
  }, [engagementId]);

  useEffect(() => {
    setLoading(true);
    void loadCached().then(() => { void tryAutoRegenerate(); });
  }, [loadCached, tryAutoRegenerate]);

  async function refresh() {
    if (forceRegenerating) return;
    setForceRegenerating(true); setErr(null); setManualPrompt(null);
    try {
      const result: GenerateSummaryResult = await leadSummaryApi.generate(engagementId);
      if (result.mode === 'manual') {
        setManualPrompt(result.prompt);
      } else {
        setSummary(result.summary);
        setAutoSkip(null);
      }
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setForceRegenerating(false);
    }
  }

  async function submitManual() {
    if (!manualText.trim()) return;
    setManualSaving(true); setErr(null);
    try {
      const row = await leadSummaryApi.acceptManual(engagementId, { text: manualText });
      setSummary(row);
      setManualPrompt(null);
      setManualText('');
      setAutoSkip(null);
    } catch (e) {
      setErr(describeError(e));
    } finally {
      setManualSaving(false);
    }
  }

  // Loading + nothing-to-show: render a thin placeholder so the page
  // doesn't visibly jump when the cached summary lands.
  if (loading) {
    return (
      <div style={{
        padding: '10px 14px', borderRadius: 8,
        background: 'var(--bg-elev)', border: '1px solid var(--border)',
        fontSize: 12, color: 'var(--fg-muted)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Icon.Sparkle size={11} /> <span>Loading lead summary…</span>
      </div>
    );
  }

  // No cached summary AND auto failed/disabled → small CTA card.
  if (!summary && !manualPrompt) {
    return (
      <div style={{
        padding: '12px 14px', borderRadius: 8,
        background: 'var(--bg-elev)', border: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
      }}>
        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon.Sparkle size={12} />
          <span>
            {autoRegenerating
              ? 'Generating lead summary…'
              : autoSkip === 'auto_disabled'
                ? 'Auto-summarise is off — click Generate to produce one.'
                : autoSkip === 'no_llm_provider'
                  ? 'No AI provider configured. Connect one in /integrations.'
                  : autoSkip === 'no_data'
                    ? 'Nothing to summarise yet. Once the client interacts, a summary will appear here.'
                    : 'No summary yet.'}
          </span>
        </div>
        <button className="btn sm accent" disabled={forceRegenerating || autoRegenerating} onClick={refresh}>
          {forceRegenerating ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Generate</>}
        </button>
      </div>
    );
  }

  if (manualPrompt) {
    return <ManualPanel
      prompt={manualPrompt}
      text={manualText}
      onTextChange={setManualText}
      onCancel={() => { setManualPrompt(null); setManualText(''); }}
      onSubmit={submitManual}
      saving={manualSaving}
    />;
  }

  // We have a summary. Render with proper hierarchy:
  //   1. Title row + Refresh button
  //   2. Status row: risk pill, follow-up suggestion (subtle)
  //   3. Body: summary text (the headline content)
  //   4. Next actions: labeled section with urgency tags
  //   5. Footer: provenance line in muted micro-type
  if (!summary) return null;
  return (
    <div style={{
      padding: '14px 18px', borderRadius: 8,
      background: 'var(--bg-elev)', border: '1px solid var(--border)',
      display: 'grid', gap: 12,
    }}>
      {/* 1. Title + Refresh */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 10,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, letterSpacing: 0.6,
          textTransform: 'uppercase', color: 'var(--fg-muted)',
          display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>
          <Icon.Sparkle size={11} /> Lead summary
          {autoRegenerating && (
            <span className="spin" style={{ width: 10, height: 10, marginLeft: 4 }} />
          )}
        </div>
        <button
          className="btn sm ghost"
          disabled={forceRegenerating || autoRegenerating}
          onClick={refresh}
          title="Regenerate summary now"
        >
          {forceRegenerating ? <span className="spin" /> : <><Icon.ArrowUpRight size={11} /> Refresh</>}
        </button>
      </div>

      {/* 2. Status row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <RiskPill risk={summary.riskLevel} />
        {summary.recommendedFollowUpDays != null && (
          <span style={{
            fontSize: 12, color: 'var(--fg-muted)',
            display: 'inline-flex', alignItems: 'center', gap: 5,
          }}>
            <Icon.Clock size={11} />
            Follow up in <b style={{ color: 'var(--fg)' }}>{summary.recommendedFollowUpDays}</b> day{summary.recommendedFollowUpDays === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {/* 3. Summary text */}
      <p style={{
        margin: 0, fontSize: 13.5, lineHeight: 1.6,
        whiteSpace: 'pre-wrap', color: 'var(--fg)',
      }}>
        {summary.summaryText}
      </p>

      {/* 4. Next actions */}
      {summary.nextActions.length > 0 && (
        <div>
          <div style={{
            fontSize: 10.5, fontWeight: 600, letterSpacing: 0.6,
            textTransform: 'uppercase', color: 'var(--fg-muted)',
            marginBottom: 6,
          }}>
            Next actions
          </div>
          <ul style={{
            margin: 0, padding: 0, listStyle: 'none',
            display: 'grid', gap: 6,
          }}>
            {summary.nextActions.slice(0, 3).map((a, i) => (
              <li
                key={i}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12.5, lineHeight: 1.4,
                  padding: '6px 10px', borderRadius: 6,
                  background: 'var(--bg-sunk)',
                }}
              >
                <UrgencyDot urgency={a.urgency} />
                <span style={{ flex: 1 }}>{a.title}</span>
                {a.owner && <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>— {a.owner}</span>}
                <UrgencyTag urgency={a.urgency} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* 5. Footer / provenance */}
      <div style={{
        paddingTop: 8, borderTop: '1px solid var(--divider)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 8,
      }}>
        <span style={{ fontSize: 10.5, color: 'var(--fg-subtle)' }}>
          {summary.generatedBy === 'manual'
            ? `Saved manually · ${timeAgo(summary.generatedAt)}`
            : `Generated by ${humanModelName(summary.model)} · ${timeAgo(summary.generatedAt)}`}
        </span>
        {summary.stale && !autoRegenerating && (
          <span style={{
            fontSize: 10.5, color: 'var(--warn, #b85)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }}>
            <Icon.Clock size={10} /> Activity has changed since this summary
          </span>
        )}
      </div>

      {err && (
        <div style={{ fontSize: 11.5, color: 'var(--danger)' }}>{err}</div>
      )}
    </div>
  );
}

/** Render small priority pill on the right of an action row. */
function UrgencyTag({ urgency }: { urgency: SummaryNextAction['urgency'] }) {
  const map: Record<SummaryNextAction['urgency'], { bg: string; fg: string; label: string }> = {
    low:    { bg: 'transparent',                                       fg: 'var(--fg-muted)', label: 'low' },
    medium: { bg: 'color-mix(in oklch, #c80 14%, transparent)',        fg: '#a60',            label: 'med' },
    high:   { bg: 'var(--danger-tint)',                                fg: 'var(--danger)',   label: 'high' },
  };
  const s = map[urgency];
  return (
    <span style={{
      padding: '1px 7px', fontSize: 9.5, fontWeight: 700,
      letterSpacing: 0.4, textTransform: 'uppercase',
      borderRadius: 999,
      background: s.bg, color: s.fg,
    }}>{s.label}</span>
  );
}

/**
 * Turn the stored model id (e.g. "anthropic:claude-opus-4-7" or
 * "gemini:gemini-2.0-flash") into something a sales rep can read.
 * Falls back to the original string when the format is unfamiliar.
 */
function humanModelName(stored: string | null): string {
  if (!stored) return 'AI';
  const parts = stored.split(':');
  const provider = parts[0] ?? '';
  const model = parts.slice(1).join(':');
  const providerMap: Record<string, string> = {
    anthropic: 'Claude',
    openai: 'OpenAI',
    gemini: 'Gemini',
    ollama: 'Ollama',
    openai_compat: 'OpenAI-compat',
  };
  const providerLabel = providerMap[provider] ?? provider ?? 'AI';
  if (!model) return providerLabel || 'AI';
  // Strip provider prefix from model name when redundant
  // ("gemini:gemini-2.0-flash" → "Gemini · 2.0 Flash").
  const trimmed = model
    .replace(new RegExp(`^${provider}-?`, 'i'), '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${providerLabel} · ${trimmed}`;
}

function ManualPanel({
  prompt, text, onTextChange, onCancel, onSubmit, saving,
}: {
  prompt: string;
  text: string;
  onTextChange(v: string): void;
  onCancel(): void;
  onSubmit(): void;
  saving: boolean;
}) {
  const [copied, setCopied] = useState(false);
  function copyPrompt() {
    navigator.clipboard.writeText(prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 8,
      background: 'var(--bg-elev)', border: '1px solid var(--border)',
      display: 'grid', gap: 8,
    }}>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
        Manual LLM mode — paste the prompt into your AI tool, then drop the JSON response below.
      </div>
      <div>
        <button className="btn sm" onClick={copyPrompt}>
          {copied ? <><Icon.Check size={11} /> Copied prompt</> : <><Icon.Copy size={11} /> Copy prompt</>}
        </button>
      </div>
      <textarea
        className="input"
        value={text}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder='Paste the AI response here. JSON like {"summary":"…","risk":"low","actions":[…],"follow_up_days":7} works best.'
        rows={4}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}
      />
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button className="btn sm ghost" onClick={onCancel} disabled={saving}>Cancel</button>
        <button className="btn sm accent" onClick={onSubmit} disabled={saving || !text.trim()}>
          {saving ? <span className="spin" /> : <><Icon.Check size={11} /> Save</>}
        </button>
      </div>
    </div>
  );
}

function RiskPill({ risk }: { risk: SummaryRiskLevel }) {
  const map: Record<SummaryRiskLevel, { bg: string; fg: string; label: string }> = {
    low:    { bg: 'var(--ok-tint)',    fg: 'var(--ok)',    label: 'Low risk' },
    medium: { bg: 'color-mix(in oklch, #c80 18%, transparent)', fg: '#a60', label: 'Medium risk' },
    high:   { bg: 'var(--danger-tint)', fg: 'var(--danger)', label: 'High risk' },
  };
  const s = map[risk];
  return (
    <span style={{
      padding: '2px 9px', borderRadius: 999,
      fontSize: 11.5, fontWeight: 600,
      background: s.bg, color: s.fg,
    }}>{s.label}</span>
  );
}

function UrgencyDot({ urgency }: { urgency: SummaryNextAction['urgency'] }) {
  const colors = { low: 'var(--fg-muted)', medium: '#c80', high: 'var(--danger)' };
  return (
    <span style={{
      display: 'inline-block', width: 7, height: 7, borderRadius: '50%',
      background: colors[urgency],
    }} />
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
