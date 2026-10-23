import { refToString, type GraphEvent, type GraphResult, type TaskGraph } from '@kernelpai/core';
import type { GraphEstimate } from '@kernelpai/orchestrator';
import { formatMoney, type Money } from '../config.js';
import { sanitizeForTerminal } from '../sanitize.js';

/** The plan, before anything runs (spec §4.5 "zéro surprise"). */
export function renderGraphPlan(graph: TaskGraph, est: GraphEstimate, m: Money): string {
  const lines = [`plan   ${graph.nodes.length} node(s) · ${graph.createdBy}: ${graph.reason}`];
  for (const node of graph.nodes) {
    const e = est.nodes.find((n) => n.nodeId === node.id);
    const who = e?.ref ? refToString(e.ref) : `unroutable (${e?.error ?? 'no candidate'})`;
    const deps = node.dependsOn.length ? ` ← ${node.dependsOn.join(', ')}` : '';
    const cost = e ? `${formatMoney(e.minUsd, m)}–${formatMoney(e.expectedUsd, m)}` : '?';
    const tools = node.tools?.length ? ` · tools ${node.tools.join(' ')}` : '';
    lines.push(
      `  ${node.id.padEnd(16)} ${node.title.slice(0, 28).padEnd(28)} ${node.type.padEnd(15)} ${(e?.protocol ?? node.protocol).padEnd(13)} ${who.padEnd(34)} ${cost}${deps}${tools}`,
    );
  }
  const status = est.complete ? '' : ' (some nodes cannot be routed)';
  lines.push(
    `total  ${formatMoney(est.minUsd, m)}–${formatMoney(est.totalUsd, m)} before running${status}`,
  );
  return lines.join('\n') + '\n';
}

/** One line per meaningful event: who works on what, and when it ends. */
export function renderEvent(e: GraphEvent, m: Money): string | undefined {
  switch (e.type) {
    case 'node_state':
      if (e.ref)
        return `  ▸ ${e.nodeId} ${e.state === 'review' ? 'review' : 'work'} by ${refToString(e.ref)} (${e.role ?? 'step'})\n`;
      return ['done', 'failed', 'skipped', 'cancelled'].includes(e.state)
        ? `  ■ ${e.nodeId} ${e.state}\n`
        : undefined;
    case 'contribution': {
      const c = e.contribution;
      const v = c.verdict
        ? ` · ${c.verdict.approve ? 'approved' : `changes requested (${c.verdict.issues.length})`}`
        : '';
      return `    ${c.role.padEnd(8)} ${refToString(c.ref).padEnd(34)} ${formatMoney(c.costUsd, m)}${v}\n`;
    }
    case 'graph_done':
      return `— graph ${e.ok ? 'done' : 'finished with failures'} · ${formatMoney(e.costUsd, m)}\n`;
    default:
      return undefined;
  }
}

/** Final outputs, sanitised for the terminal (the journal keeps raw text). */
export function renderOutputs(graph: TaskGraph, r: GraphResult): string {
  const parts: string[] = [];
  for (const node of graph.nodes) {
    const res = r.results[node.id];
    const state = r.states[node.id] ?? 'pending';
    const approval =
      res?.approved === undefined ? '' : res.approved ? ' · approved' : ' · NOT approved';
    parts.push(`\n## ${node.id} — ${node.title} [${state}${approval}]\n`);
    parts.push(sanitizeForTerminal(res?.output || res?.error || '(no output)') + '\n');
  }
  return parts.join('');
}
