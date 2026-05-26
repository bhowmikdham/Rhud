/**
 * Shared visual primitives for the auth flow pages: signup, login (later),
 * forgot-password, reset-password, verify-email, magic-link consume.
 *
 * Kept off `page.tsx` because Next App Router only permits a default export
 * from page files — these are named exports a page can import.
 */

import type { CSSProperties, ReactNode } from 'react';

export type AuthPhase = 'idle' | 'submitting' | 'sent' | 'success' | 'error';

/** Card-on-grey shell used by every standalone auth screen. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#f5f5f5',
        fontFamily:
          '-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif',
        color: '#111',
        padding: '32px 16px',
      }}
    >
      <div
        style={{
          background: '#fff',
          padding: '32px 40px',
          borderRadius: 12,
          boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          minWidth: 360,
          maxWidth: 460,
          width: '100%',
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Stacked label + input. */
export function AuthField(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#444', marginBottom: 6 }}>
        {props.label}
      </span>
      <input
        type={props.type ?? 'text'}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        spellCheck={false}
        autoComplete={
          props.type === 'password'
            ? 'new-password'
            : props.type === 'email'
              ? 'email'
              : 'off'
        }
        style={{
          width: '100%',
          padding: '10px 12px',
          border: '1px solid #ddd',
          borderRadius: 8,
          fontSize: 14,
          boxSizing: 'border-box',
        }}
      />
    </label>
  );
}

/** Primary submit button with submitting/idle state. */
export function AuthSubmit({
  submitting,
  idleLabel,
  submittingLabel,
}: {
  submitting: boolean;
  idleLabel: string;
  submittingLabel: string;
}) {
  return (
    <button
      type="submit"
      disabled={submitting}
      style={{
        width: '100%',
        padding: '12px 16px',
        background: submitting ? '#666' : '#111',
        color: '#fff',
        border: 'none',
        borderRadius: 8,
        fontWeight: 600,
        fontSize: 14,
        cursor: submitting ? 'not-allowed' : 'pointer',
        marginTop: 8,
      }}
    >
      {submitting ? submittingLabel : idleLabel}
    </button>
  );
}

export const authStyles: Record<string, CSSProperties> = {
  brand: { fontWeight: 700, fontSize: 18, marginBottom: 24 },
  h1: { fontSize: 22, fontWeight: 600, margin: '0 0 8px' },
  p: { color: '#444', margin: '0 0 24px', lineHeight: 1.5, fontSize: 14 },
  link: { color: '#111', fontWeight: 600, textDecoration: 'underline' },
  err: {
    background: '#fef2f2',
    color: '#b00020',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 13,
    margin: '8px 0 16px',
  },
  dev: { fontSize: 12, color: '#666', margin: '16px 0 0' },
};
