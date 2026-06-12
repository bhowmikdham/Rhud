'use client';

/**
 * Add / edit form for a single Gamma proposal-template library entry.
 * Renders inside the Settings → Gamma "Templates" tab (mounted by
 * GammaTemplatesPanel). On submit it create()s or update()s the entry,
 * then calls onSaved() so the panel reloads its list.
 *
 * The field-mapping + locked-sections manifest editor is progressively
 * disclosed behind a collapsed "advanced" section so the common case
 * (paste a File ID, name it, save) stays a two-field form.
 */

import { useState } from 'react';
import { gammaTemplates, describeError } from '@/lib/api';
import type {
  GammaTemplate,
  GammaTemplateManifest,
  GammaTemplateFormat,
  CreateGammaTemplate,
  UpdateGammaTemplate,
} from '@/lib/api';
import { GAMMA_TEMPLATE_FORMATS } from '@rhud/shared';
import { Icon } from '@/components/icon';
import { Field, ResultLine } from './gamma-ui';
import { GammaManifestEditor } from './gamma-manifest-editor';

const FORMAT_LABELS: Record<GammaTemplateFormat, string> = {
  presentation: 'Presentation (slides)',
  document: 'Document (doc)',
};

export function GammaTemplateForm({
  entry,
  onSaved,
  onClose,
}: {
  entry?: GammaTemplate | null;
  onSaved: () => void;
  onClose: () => void;
}) {
  const isEdit = !!entry;

  const [label, setLabel] = useState(entry?.label ?? '');
  const [gammaFileId, setGammaFileId] = useState(entry?.gammaTemplateId ?? '');
  const [format, setFormat] = useState<GammaTemplateFormat>(entry?.format ?? 'presentation');
  const [isDefault, setIsDefault] = useState(entry?.isDefault ?? false);
  const [serviceLine, setServiceLine] = useState(entry?.serviceLine ?? '');
  const [manifest, setManifest] = useState<GammaTemplateManifest>(
    // Fresh object — never seed state with the shared EMPTY_GAMMA_MANIFEST
    // singleton (a later in-place edit would corrupt the app-wide constant).
    entry?.manifest ?? { fields: [], lockedSections: [] },
  );

  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    if (saving) return;
    setFieldErr(null);
    setSaveErr(null);

    const trimmedLabel = label.trim();
    const trimmedFileId = gammaFileId.trim();
    if (!trimmedLabel) {
      setFieldErr('Give the template a name so reps can recognise it.');
      return;
    }
    if (!trimmedFileId) {
      setFieldErr('Paste the Gamma File ID — without it Rhud can\'t clone the deck.');
      return;
    }

    setSaving(true);
    try {
      const trimmedServiceLine = serviceLine.trim();
      if (isEdit && entry) {
        const dto: UpdateGammaTemplate = {
          label: trimmedLabel,
          gammaTemplateId: trimmedFileId,
          format,
          isDefault,
          serviceLine: trimmedServiceLine || null,
          manifest,
        };
        await gammaTemplates.update(entry.id, dto);
      } else {
        const dto: CreateGammaTemplate = {
          label: trimmedLabel,
          gammaTemplateId: trimmedFileId,
          format,
          isDefault,
          serviceLine: trimmedServiceLine || null,
          manifest,
        };
        await gammaTemplates.create(dto);
      }
      onSaved();
    } catch (e) {
      setSaveErr(describeError(e));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!entry || testing) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await gammaTemplates.test(entry.id);
      setTestResult({
        ok: r.ok,
        message: r.ok
          ? 'Gamma connection is authenticated and reachable.'
          : (r.error ?? 'Unknown error'),
      });
    } catch (e) {
      setTestResult({ ok: false, message: describeError(e) });
    } finally {
      setTesting(false);
    }
  }

  const busy = saving || testing;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Field
        label="Template name"
        htmlFor="gt-label"
        hint="Shown to reps in the proposal template picker."
      >
        <input
          id="gt-label"
          className="input"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Standard pitch deck"
          style={{ height: 32, fontSize: 13 }}
        />
      </Field>

      <Field
        label="Gamma File ID"
        htmlFor="gt-file-id"
        hint={
          <>
            Find this in the URL of any Gamma deck you want to reuse. Note: Test
            checks the Gamma <em>connection</em>, not whether this File ID exists.
          </>
        }
      >
        <input
          id="gt-file-id"
          className="input"
          value={gammaFileId}
          onChange={(e) => setGammaFileId(e.target.value)}
          placeholder="abc123def456…"
          autoComplete="off"
          spellCheck={false}
          style={{ height: 32, fontSize: 13, fontFamily: 'var(--font-mono, monospace)' }}
        />
      </Field>

      <Field label="Format" htmlFor="gt-format">
        <select
          id="gt-format"
          className="input"
          value={format}
          onChange={(e) => setFormat(e.target.value as GammaTemplateFormat)}
          style={{ height: 32, fontSize: 13 }}
        >
          {GAMMA_TEMPLATE_FORMATS.map((f) => (
            <option key={f} value={f}>{FORMAT_LABELS[f]}</option>
          ))}
        </select>
      </Field>

      <Field
        label="Service line (optional)"
        htmlFor="gt-service-line"
        hint="A tag to group templates by service line. Doesn't affect which template a proposal resolves to."
      >
        <input
          id="gt-service-line"
          className="input"
          value={serviceLine}
          onChange={(e) => setServiceLine(e.target.value)}
          placeholder="e.g. Penetration testing"
          style={{ height: 32, fontSize: 13 }}
        />
      </Field>

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12.5,
          color: 'var(--fg)',
          cursor: 'pointer',
        }}
      >
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
          style={{ cursor: 'pointer' }}
        />
        Use as the default template for new proposals
      </label>

      {/* ── Advanced: progressive disclosure ─────────────────────── */}
      <div style={{ borderTop: '1px solid var(--divider)', paddingTop: 12 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          style={{
            appearance: 'none',
            border: 0,
            background: 'transparent',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: 0,
            fontSize: 12.5,
            fontWeight: 500,
            color: 'var(--fg-muted)',
            transition: 'color .15s',
          }}
        >
          {advancedOpen ? <Icon.ChevronDown size={14} /> : <Icon.ChevronRight size={14} />}
          Field mapping &amp; locked sections (advanced)
        </button>
        {advancedOpen && (
          <div style={{ marginTop: 12 }}>
            <GammaManifestEditor value={manifest} onChange={setManifest} />
          </div>
        )}
      </div>

      {fieldErr && (
        <ResultLine ok={false}>{fieldErr}</ResultLine>
      )}
      {saveErr && (
        <ResultLine ok={false}>{saveErr}</ResultLine>
      )}
      {testResult && (
        <ResultLine ok={testResult.ok}>
          <b>{testResult.ok ? 'Connection OK. ' : 'Connection failed. '}</b>
          {testResult.message}
        </ResultLine>
      )}

      <footer
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          borderTop: '1px solid var(--divider)',
          paddingTop: 12,
        }}
      >
        <button type="button" onClick={onClose} disabled={busy} className="btn sm ghost">
          Cancel
        </button>
        <div style={{ display: 'flex', gap: 8 }}>
          {isEdit && (
            <button type="button" onClick={test} disabled={busy} className="btn sm">
              {testing ? <span className="spin" /> : <><Icon.Zap size={11} /> Test connection</>}
            </button>
          )}
          <button type="button" onClick={save} disabled={busy} className="btn sm accent">
            {saving ? <span className="spin" /> : <><Icon.Check size={12} /> {isEdit ? 'Save changes' : 'Add template'}</>}
          </button>
        </div>
      </footer>
    </div>
  );
}
