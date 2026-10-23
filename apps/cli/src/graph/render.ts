import { refToString, type GraphEvent, type GraphResult, type TaskGraph } from '@kernelpai/core';
import type { GraphEstimate } from '@kernelpai/orchestrator';
import type { PackContext, RulesSummary, ScopeCheck } from '@kernelpai/kernel';
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
  const status = est.complete ? '' : ` (cannot run as planned: ${est.problems.join('; ')})`;
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
    if (res?.error) parts.push(`reason: ${sanitizeForTerminal(res.error)}\n`);
    parts.push(sanitizeForTerminal(res?.output || (res?.error ? '' : '(no output)')) + '\n');
  }
  return parts.join('');
}

/** Rule files every node will get as untrusted context (R-306): names, never content. */
export function renderRules(r: RulesSummary): string {
  const zone = r.skippedForbidden ? ` · ${r.skippedForbidden} in forbidden zones skipped` : '';
  if (r.files.length === 0) return zone ? `rules  none read${zone}\n` : '';
  const files = r.files.map(
    (f) =>
      `${sanitizeForTerminal(f.path)} (${f.kind}${f.applies ? '' : ', other folder'}${f.truncated ? ', cut' : ''})`,
  );
  const omitted = r.omitted.length ? ` · ${r.omitted.length} left out (size cap)` : '';
  return `rules  ${files.join(' · ')} — untrusted context for every node${omitted}${zone}\n`;
}

/** Packs chosen and why, the forbidden zones in force by tier and origin, pack zone changes (D-020). */
export function renderPacks(c: PackContext): string {
  const lines: string[] = [];
  const packs = c.packs.map((p) => `${p.id} (${sanitizeForTerminal(p.reason)})`);
  if (packs.length) lines.push(`packs  ${packs.join(' · ')}`);
  for (const p of c.packs) {
    const flags = [
      p.preferLocal && 'prefers local models',
      p.personalData && 'personal data: keep local',
      p.physicalEffects && 'physical effects: confirm and simulate first',
    ].filter(Boolean);
    if (flags.length) lines.push(`       ${p.id}: ${flags.join(' · ')}`);
  }
  const byOrigin = new Map<string, string[]>();
  for (const z of c.zones) {
    const key = `${z.origin} (${z.tier})`;
    byOrigin.set(key, [...(byOrigin.get(key) ?? []), z.glob]);
  }
  const zones = [...byOrigin].map(([origin, globs]) => `${origin}: ${globs.join(' ')}`);
  lines.push(`zones  ${c.zones.length} forbidden · ${zones.join(' · ')}`);
  for (const l of c.lines) lines.push(`       ${sanitizeForTerminal(l)}`);
  for (const p of c.problems) lines.push(`       pack problem: ${sanitizeForTerminal(p)}`);
  return lines.join('\n') + '\n';
}

/** The authorised scope selected packs require (WI-S1-03); empty when none is required. */
export function renderScope(s: ScopeCheck): string {
  if (s.required.length === 0) return '';
  const head = `scope  required by ${s.required.join(', ')}${s.source ? ` · from ${s.source === 'file' ? '.kpstudio/scope.yaml (asked before running)' : '--scope'}` : ''}`;
  const lines = [head, ...s.lines.map((l) => `       ${sanitizeForTerminal(l)}`)];
  for (const p of s.problems) lines.push(`       ✗ ${sanitizeForTerminal(p)}`);
  return lines.join('\n') + '\n';
}
