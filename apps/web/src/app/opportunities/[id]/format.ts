/**
 * Shared pure formatters extracted verbatim from the opportunity detail page
 * (Phase A — presentation restructure, no behaviour change). Imported by the
 * page and its extracted panel components.
 */

export function pctLabel(adj: number): string {
  if (adj === 0) return 'No adjustment';
  const pct = (adj * 100).toFixed(1);
  return adj < 0 ? `${pct}% (discount applied)` : `+${pct}% (premium applied)`;
}

export function formatMoney(cents: number, currency: string): string {
  const amount = cents / 100;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

export function currencySymbol(currency: string): string {
  // Single-character symbol for the input prefix; falls back to the
  // currency code when there's no symbol Intl knows about.
  try {
    const parts = new Intl.NumberFormat(undefined, { style: 'currency', currency }).formatToParts(0);
    return parts.find((p) => p.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

export function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
