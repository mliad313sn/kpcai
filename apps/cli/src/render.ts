import {
  refToString,
  type Classification,
  type RoutingDecision,
  type TaskNode,
} from '@kernelpai/core';
import type { ExecutorMetrics } from '@kernelpai/executor';
import { formatMoney, type Money } from './config.js';

const pct = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)} %`);
const ms = (v: number | null): string => (v === null ? 'n/a' : `${v.toFixed(2)} ms`);

/** The plan block shown before anything runs (principle "zéro surprise"). */
export function renderPlan(
  node: TaskNode,
  cls: Classification,
  d: RoutingDecision,
  m: Money,
): string {
  const lines = [
    `plan   ${node.id} · ${node.type} (${Math.round(cls.confidence * 100)} %: ${cls.reason}) · criticality ${node.criticality}`,
    `route  ${d.reason}  [${d.elapsedMs.toFixed(2)} ms]`,
  ];
  [d.chosen, ...d.fallbacks.slice(0, 3)].forEach((c, i) => {
    const tag = i === 0 ? '→' : `${i}.`;
    lines.push(
      `  ${tag.padEnd(3)}${refToString(c.ref).padEnd(40)} score ${c.score.toFixed(3)}  expected ${formatMoney(c.estimate.expectedCostUsd, m)} (max ${formatMoney(c.estimate.maxCostUsd, m)})`,
    );
  });
  if (d.fallbacks.length > 3) lines.push(`     … ${d.fallbacks.length - 3} more fallback(s)`);
  if (d.rejected.length > 0)
    lines.push(`  ${d.rejected.length} candidate(s) excluded (see --verbose)`);
  return lines.join('\n') + '\n';
}

export function renderRejections(d: RoutingDecision): string {
  return d.rejected.map((r) => `  ✗ ${refToString(r.ref)}: ${r.reason}\n`).join('');
}

export function renderMetrics(x: ExecutorMetrics, m: Money): string {
  return (
    [
      `tasks                 ${x.tasks} (${x.calls} calls)`,
      `fallback rate         ${pct(x.fallbackRate)} (${x.fallbacks} fallbacks)`,
      `fallback success      ${pct(x.fallbackSuccessRate)}`,
      `avg cost per task     ${x.avgCostPerTaskUsd === null ? 'n/a' : formatMoney(x.avgCostPerTaskUsd, m)}`,
      `estimate error        ${x.estimateError.meanAbsPct === null ? 'n/a' : `${x.estimateError.meanAbsPct.toFixed(1)} % mean abs, ${x.estimateError.meanSignedPct?.toFixed(1)} % signed`} (${x.estimateError.samples} samples)`,
      `router latency        p50 ${ms(x.routerLatencyMs.p50)} · p95 ${ms(x.routerLatencyMs.p95)} (${x.routerLatencyMs.samples} decisions)`,
    ].join('\n') + '\n'
  );
}
