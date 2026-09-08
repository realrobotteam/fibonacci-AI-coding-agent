// Tiny client-side formatting helpers for the webview.
// Mirrors a couple of host-side helpers (src/core/pricing.ts) — do NOT import
// host modules into the webview bundle, re-implement here instead.

/**
 * Fill '{key}' tokens in an i18n template. `translate()` itself has no
 * parameter support, so callers do: `fill(t('checkpoint.restored'), { n: 3 })`.
 */
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in params ? String(params[key]) : match
  );
}

/**
 * Compact token count: 1.2K / 850.
 */
export function formatK(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

/**
 * Compact USD cost — same precision ladder as the host's formatCost:
 * ≥ $1 → 2 decimals, ≥ $0.01 → 3 decimals, else 4 decimals.
 */
export function formatCost(cost?: number): string {
  if (cost === undefined || cost === null || Number.isNaN(cost)) return '—';
  const abs = Math.abs(cost);
  if (abs >= 1) return `$${cost.toFixed(2)}`;
  if (abs >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

/**
 * Compact human duration for the subtask board: 850 → "0.9s",
 * 34000 → "34s", 125000 → "2m 5s". Undefined/invalid → "—".
 */
export function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}
