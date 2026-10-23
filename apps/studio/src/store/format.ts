/** Display helpers. Costs are stored and shown in USD in phase 3 (ADR-0013 display currency
 * comes with the settings screen). */

export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$?';
  if (usd === 0) return '$0';
  if (Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRange(min: number, max: number): string {
  return min === max ? formatUsd(max) : `${formatUsd(min)}–${formatUsd(max)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatScore(score: number | undefined): string {
  return score === undefined || !Number.isFinite(score) ? '—' : score.toFixed(2);
}
