'use client';

/**
 * Pure controlled editor for a GammaTemplateManifest — the bridge between a
 * rep-authored Gamma deck (placeholder tokens like "[[investment]]") and
 * Rhud's computed field values, plus the list of named sections to keep
 * verbatim.
 *
 * Stateless: every edit calls onChange with a fresh manifest. The parent
 * form owns the value.
 */

import { useState } from 'react';
import {
  GAMMA_FIELD_KEYS,
  type GammaTemplateManifest,
  type GammaManifestField,
  type GammaFieldKey,
} from '@rhud/shared';
import { Icon } from '@/components/icon';
import { Field } from './gamma-ui';

/** Human labels for the field keys (the select needs readable options). */
const FIELD_KEY_LABELS: Record<GammaFieldKey, string> = {
  clientName: 'Client name',
  clientEmail: 'Client email',
  opportunityName: 'Opportunity name',
  serviceLine: 'Service line',
  tenantName: 'Workspace name',
  investment: 'Investment / price',
  date: 'Date',
  lineItems: 'Line items',
  scopeSummary: 'Scope summary',
};

function emptyRow(): GammaManifestField {
  return { token: '', fieldKey: GAMMA_FIELD_KEYS[0], label: '', defaultInclude: true };
}

export function GammaManifestEditor({
  value,
  onChange,
}: {
  value: GammaTemplateManifest;
  onChange: (m: GammaTemplateManifest) => void;
}) {
  const fields = value.fields ?? [];
  const lockedSections = value.lockedSections ?? [];

  // Local scratch for the "add a section" text box only — committed
  // sections live in `value.lockedSections` (controlled).
  const [sectionDraft, setSectionDraft] = useState('');

  function patchField(idx: number, patch: Partial<GammaManifestField>) {
    const next = fields.map((f, i) => (i === idx ? { ...f, ...patch } : f));
    onChange({ ...value, fields: next });
  }
  function addField() {
    onChange({ ...value, fields: [...fields, emptyRow()] });
  }
  function removeField(idx: number) {
    onChange({ ...value, fields: fields.filter((_, i) => i !== idx) });
  }

  function addSection() {
    const name = sectionDraft.trim();
    if (!name || lockedSections.includes(name)) {
      setSectionDraft('');
      return;
    }
    onChange({ ...value, lockedSections: [...lockedSections, name] });
    setSectionDraft('');
  }
  function removeSection(name: string) {
    onChange({ ...value, lockedSections: lockedSections.filter((s) => s !== name) });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Field mapping ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}>
          Field mapping
        </div>
        <p style={{ fontSize: 11, color: 'var(--fg-subtle)', lineHeight: 1.5, margin: 0 }}>
          Tokens like <code style={{ background: 'var(--bg-sunk)', padding: '1px 5px', borderRadius: 4 }}>[[investment]]</code>{' '}
          are placeholders you put in your Gamma deck; Rhud replaces them per
          proposal with the value from the field you map below.
        </p>

        {fields.length === 0 ? (
          <div
            className="empty"
            style={{ padding: 18, fontSize: 12, borderRadius: 8, background: 'var(--bg-sunk)' }}
          >
            No tokens mapped yet — Rhud will fill the deck&apos;s own placeholders
            automatically. Add a row to override or label a specific token.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {fields.map((f, idx) => (
              <div
                key={idx}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr 1fr auto auto',
                  gap: 8,
                  alignItems: 'center',
                  padding: 8,
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                <input
                  className="input"
                  aria-label={`Token for row ${idx + 1}`}
                  value={f.token}
                  onChange={(e) => patchField(idx, { token: e.target.value })}
                  placeholder="[[investment]]"
                  style={{ height: 30, fontSize: 12.5 }}
                />
                <select
                  className="input"
                  aria-label={`Field for row ${idx + 1}`}
                  value={f.fieldKey}
                  onChange={(e) => patchField(idx, { fieldKey: e.target.value as GammaFieldKey })}
                  style={{ height: 30, fontSize: 12.5 }}
                >
                  {GAMMA_FIELD_KEYS.map((k) => (
                    <option key={k} value={k}>{FIELD_KEY_LABELS[k]}</option>
                  ))}
                </select>
                <input
                  className="input"
                  aria-label={`Label for row ${idx + 1}`}
                  value={f.label}
                  onChange={(e) => patchField(idx, { label: e.target.value })}
                  placeholder="Display label"
                  style={{ height: 30, fontSize: 12.5 }}
                />
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 11.5,
                    color: 'var(--fg-muted)',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={f.defaultInclude}
                    onChange={(e) => patchField(idx, { defaultInclude: e.target.checked })}
                    style={{ cursor: 'pointer' }}
                  />
                  Include
                </label>
                <button
                  type="button"
                  className="btn sm ghost"
                  onClick={() => removeField(idx)}
                  aria-label={`Remove row ${idx + 1}`}
                  title="Remove this mapping"
                >
                  <Icon.X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}

        <button
          type="button"
          className="btn sm"
          onClick={addField}
          style={{ alignSelf: 'flex-start' }}
        >
          <Icon.Plus size={12} /> Add field mapping
        </button>
      </div>

      {/* ── Locked sections ───────────────────────────────────────── */}
      <Field
        label="Locked sections"
        hint="Name cards/sections in your Gamma deck to keep verbatim (Rhud won't rewrite them). Type a section name and press Enter or Add."
      >
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className="input"
            aria-label="Section name to lock"
            value={sectionDraft}
            onChange={(e) => setSectionDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addSection();
              }
            }}
            placeholder="e.g. Terms & conditions"
            style={{ height: 32, fontSize: 12.5, flex: 1 }}
          />
          <button
            type="button"
            className="btn sm"
            onClick={addSection}
            disabled={!sectionDraft.trim()}
          >
            <Icon.Plus size={12} /> Add
          </button>
        </div>
        {lockedSections.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {lockedSections.map((s) => (
              <span
                key={s}
                className="chip"
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                <Icon.Lock size={10} />
                {s}
                <button
                  type="button"
                  onClick={() => removeSection(s)}
                  aria-label={`Remove locked section ${s}`}
                  title="Remove"
                  style={{
                    appearance: 'none',
                    border: 0,
                    background: 'transparent',
                    cursor: 'pointer',
                    color: 'inherit',
                    display: 'grid',
                    placeItems: 'center',
                    padding: 0,
                    marginLeft: 2,
                  }}
                >
                  <Icon.X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </Field>
    </div>
  );
}
