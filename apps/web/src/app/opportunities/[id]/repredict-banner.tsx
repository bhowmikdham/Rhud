'use client';

/**
 * RepredictBanner — contextual signal + trigger shown after a reviewer edits
 * scope/methodology. The base re-prices but the PREDICTED hero number above
 * goes stale until the model is re-run, so this banner makes the staleness
 * explicit and gives a one-click way to refresh it.
 *
 * State is carried by icon + text (not colour alone); the button reflects the
 * in-flight state with a spinner so screen-reader and keyboard users get the
 * same signal.
 */
import { Icon } from '@/components/icon';

export function RepredictBanner({
  onRepredict,
  repredicting,
}: {
  onRepredict: () => void | Promise<void>;
  repredicting: boolean;
}) {
  return (
    <div
      className="card"
      role="status"
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 14px',
        background: 'var(--warn-tint)',
        border: '1px solid color-mix(in oklch, var(--warn) 22%, transparent)',
        transition: 'background 180ms ease, border-color 180ms ease',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
        }}
      >
        <Icon.Refresh
          size={14}
          aria-hidden
          style={{ color: 'var(--warn)', flexShrink: 0 }}
        />
        <span style={{ fontSize: 12.5, color: 'var(--fg)' }}>
          <strong style={{ fontWeight: 600 }}>Scope changed</strong>
          <span style={{ color: 'var(--fg-muted)' }}>
            {' '}
            — the predicted price above is stale. Re-predict to refresh it.
          </span>
        </span>
      </span>

      <button
        type="button"
        className="btn sm accent"
        onClick={() => {
          void onRepredict();
        }}
        disabled={repredicting}
        aria-label="Re-predict the price from the updated scope"
        aria-busy={repredicting}
        style={{
          flexShrink: 0,
          minHeight: 44,
          transition: 'opacity 180ms ease, background 180ms ease',
        }}
      >
        {repredicting ? (
          <>
            <span className="spin" aria-hidden />
            Re-predicting…
          </>
        ) : (
          <>
            <Icon.Refresh size={12} aria-hidden />
            Re-predict
          </>
        )}
      </button>
    </div>
  );
}
