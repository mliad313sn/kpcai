/**
 * The terminal's Enterprise summary as plain lines (R-5E14): gauges, programs, team and
 * asks. Program goals, questions and alerts are untrusted text: control characters and
 * escape sequences are made inert before they reach the terminal.
 */
import { t } from '../../studio/src/i18n/core';
import {
  assuranceShares,
  portfolioSpend,
  quotaGauges,
  seatCounts,
} from '../../studio/src/enterprise/derive';
import type { InboxItem, ProgramCard, SeatView } from '../../studio/src/enterprise/schemas';
import type { EntState } from '../../studio/src/enterprise/state';
import { formatHours } from '../../studio/src/enterprise/words';
import { formatPct, formatUsd } from '../../studio/src/store/format';
import { inert } from './learn';

const MAX_TEXT = 80;

/** One line of untrusted text, inert and cut to fit. */
export function oneLine(text: string, max = MAX_TEXT): string {
  const line = inert(text.replace(/\s+/g, ' ').trim());
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function spendLine(d: EntState): string | undefined {
  const g = portfolioSpend(d.gauges);
  if (!g) return undefined;
  return t('tui.ent.spend', {
    spent: formatUsd(g.spent),
    committed: formatUsd(g.committed),
    cap: formatUsd(g.cap),
    share: formatPct(g.cap > 0 ? g.committed / g.cap : null),
  });
}

export function rateLine(d: EntState): string | undefined {
  const r = portfolioSpend(d.gauges)?.rate;
  if (!r) return undefined;
  const rate = t('ent.gauge.perHour', { usd: formatUsd(r.usdPerHour) });
  const cap =
    r.capUsdPerHour === undefined
      ? t('ent.gauge.noRateCap')
      : t('ent.gauge.rateCap', { usd: formatUsd(r.capUsdPerHour) });
  return t('tui.ent.rate', { rate: `${rate} · ${cap}` });
}

export function quotaLine(d: EntState): string | undefined {
  const lines = quotaGauges(d.gauges).map((g) => {
    const parts: string[] = [];
    if (g.quota)
      parts.push(
        g.quota.runsCap === undefined
          ? t('ent.quota.runs', { count: g.quota.runs })
          : t('ent.quota.runsOf', { used: g.quota.runs, cap: g.quota.runsCap }),
      );
    if (g.localHours !== undefined)
      parts.push(t('ent.quota.local', { hours: formatHours(g.localHours) }));
    return `${g.id} ${parts.join(', ')}`;
  });
  return lines.length ? t('tui.ent.quota', { lines: lines.join(' · ') }) : undefined;
}

export function assuranceLine(d: EntState): string | undefined {
  const shares = assuranceShares(d.results);
  if (!shares) return undefined;
  return t('tui.ent.assurance', { mix: shares.map((s) => `${s.label} ${s.count}`).join(' · ') });
}

const PROGRAM_ICON: Record<string, string> = {
  running: '▶',
  gate: '◈',
  paused: '❚❚',
  stopped: '■',
  delivered: '✓',
};
const HEALTH_ICON = { on_track: '✓', at_risk: '◐', blocked: '✕' } as const;

export function programLine(p: ProgramCard): string {
  const phase = p.phases.find((ph) => ph.state === 'current');
  const health = t(`ent.health.${p.health}`);
  const parts = [
    `${PROGRAM_ICON[p.status] ?? '●'} ${p.programId}`,
    p.status,
    `${HEALTH_ICON[p.health]} ${health}`,
    ...(phase ? [oneLine(phase.title, 30)] : []),
  ];
  return `${parts.join(' · ')} “${oneLine(p.goal, 60)}”`;
}

export function teamLines(seats: readonly SeatView[]): string[] {
  const c = seatCounts(seats);
  const by = (src: string) => seats.filter((s) => s.source === src).length;
  return [
    t('tui.ent.team', { ...c }),
    t('tui.ent.sources', { local: by('local'), api: by('api'), subscription: by('subscription') }),
  ];
}

export function askLine(i: InboxItem, n: number): string {
  const kind = i.class === 'trivial' ? '' : ' ◆';
  return `${n}.${kind} [${i.programId}] “${oneLine(i.question)}”`;
}
