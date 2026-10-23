import { getLocale } from '../i18n/core';

/** Display helpers. Costs are stored and shown in USD in phase 3 (ADR-0013 display currency
 * comes with the settings screen). */

const money = new Map<string, Intl.NumberFormat>();

/** USD in the display language's notation: `$0.42` in English, `0,42 $` in French. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$?';
  const digits = usd === 0 ? 0 : Math.abs(usd) < 0.01 ? 4 : 2;
  const tag = `${getLocale() === 'fr' ? 'fr-FR' : 'en-US'} ${digits}`;
  let f = money.get(tag);
  if (!f) {
    f = new Intl.NumberFormat(tag.split(' ')[0], {
      style: 'currency',
      currency: 'USD',
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    money.set(tag, f);
  }
  return f.format(usd);
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

const percent = new Map<string, Intl.NumberFormat>();

/** A ratio (0.25) as a percentage in the display language: `25%`, `25 %`. */
export function formatPct(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—';
  const tag = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  let f = percent.get(tag);
  if (!f) {
    f = new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 0 });
    percent.set(tag, f);
  }
  return f.format(ratio);
}
