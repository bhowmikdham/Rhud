'use client';

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      style={{
        width: 32, height: 18, border: 0, padding: 0, borderRadius: 999,
        background: value ? 'var(--accent)' : 'var(--border-strong)',
        transition: 'background .15s', position: 'relative', cursor: 'pointer', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: value ? 16 : 2, width: 14, height: 14, borderRadius: 999,
        background: '#fff', boxShadow: 'var(--shadow-sm)', transition: 'left .15s',
      }} />
    </button>
  );
}
