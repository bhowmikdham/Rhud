'use client';

/**
 * Small presentational bits shared by the Gamma template-library panels.
 * These match the class + CSS-variable vocabulary already used by
 * gamma-modal.tsx and the rest of apps/web (no hardcoded hex colors —
 * everything routes through the theme tokens in globals.css so both
 * light + dark mode work).
 */

import type { ReactNode } from 'react';

/**
 * Labeled-field wrapper. Renders a real <label> (so the click target +
 * a11y are correct) with an optional helper line under the control.
 * `htmlFor` wires the label to a control rendered as `children` — pass
 * the same id on the input. When the control is itself a <label>-friendly
 * wrapper (checkbox), omit `htmlFor` and nest the input in `children`.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        htmlFor={htmlFor}
        style={{ fontSize: 12, color: 'var(--fg-muted)', fontWeight: 500 }}
      >
        {label}
      </label>
      {children}
      {hint && (
        <span style={{ fontSize: 11, color: 'var(--fg-subtle)', lineHeight: 1.45 }}>
          {hint}
        </span>
      )}
      {error && (
        <span style={{ fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.45 }}>
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Inline result line for a test / mutation — ok (green) or error (red),
 * styled like the testResult banner in gamma-modal.tsx but compact for
 * use directly beside a control.
 */
export function ResultLine({
  ok,
  children,
}: {
  ok: boolean;
  children: ReactNode;
}) {
  return (
    <div
      role={ok ? 'status' : 'alert'}
      style={{
        padding: '8px 10px',
        fontSize: 12,
        lineHeight: 1.45,
        background: ok ? 'var(--ok-tint)' : 'var(--danger-tint)',
        color: ok ? 'var(--ok)' : 'var(--danger)',
        borderRadius: 8,
        border:
          '1px solid ' +
          (ok
            ? 'color-mix(in oklch, var(--ok) 22%, transparent)'
            : 'color-mix(in oklch, var(--danger) 22%, transparent)'),
      }}
    >
      {children}
    </div>
  );
}

/** Plain inline error text near a control (no box). */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <span
      role="alert"
      style={{ fontSize: 11.5, color: 'var(--danger)', lineHeight: 1.45 }}
    >
      {children}
    </span>
  );
}
