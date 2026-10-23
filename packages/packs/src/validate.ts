import type { Pack, PlanHint } from './schema.js';
import { relaxProblem } from './zones.js';

/**
 * Model ids, prices and limits live in provider descriptors, never in packs
 * (CLAUDE.md). These patterns catch the common slips; packs talk about capabilities.
 */
const MODEL_ID =
  /\b(?:claude|gpt|o[1-9]|gemini|llama|mistral|mixtral|deepseek|grok|qwen|phi)-[\w.-]*\d[\w.-]*/i;
const PRICE = /(?:[$€£]\s?\d)|(?:\b\d+(?:\.\d+)?\s?(?:usd|eur)\b)|per\s?m(?:illion)?\s?tok/i;
const TOKEN_LIMIT = /\b\d+\s?k?\s?(?:tokens|tok)\b/i;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => strings(v, out));
  return out;
}

export function forbiddenContent(pack: Pack): string[] {
  const out: string[] = [];
  for (const s of strings(pack)) {
    if (MODEL_ID.test(s)) out.push(`model id in pack text: "${s}"`);
    else if (PRICE.test(s)) out.push(`price in pack text: "${s}"`);
    else if (TOKEN_LIMIT.test(s)) out.push(`token limit in pack text: "${s}"`);
  }
  return out;
}

/** Ids unique, dependencies known, no cycle. */
export function planProblems(plan: PlanHint): string[] {
  const ids = plan.nodes.map((n) => n.id);
  const out: string[] = [];
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup !== undefined) out.push(`plan ${plan.id}: duplicate node id ${dup}`);
  for (const n of plan.nodes) {
    for (const d of n.dependsOn) {
      if (!ids.includes(d)) out.push(`plan ${plan.id}: ${n.id} depends on unknown node ${d}`);
      if (d === n.id) out.push(`plan ${plan.id}: ${n.id} depends on itself`);
    }
  }
  if (out.length === 0 && hasCycle(plan)) out.push(`plan ${plan.id}: dependency cycle`);
  return out;
}

function hasCycle(plan: PlanHint): boolean {
  const deps = new Map(plan.nodes.map((n) => [n.id, n.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'done') return false;
    if (s === 'visiting') return true;
    state.set(id, 'visiting');
    const cyclic = (deps.get(id) ?? []).some(visit);
    state.set(id, 'done');
    return cyclic;
  };
  return plan.nodes.some((n) => visit(n.id));
}

/** Semantic checks zod cannot express. Empty when the pack is acceptable. */
export function packProblems(pack: Pack): string[] {
  const out = [...forbiddenContent(pack)];
  for (const plan of pack.plans) out.push(...planProblems(plan));
  const planIds = pack.plans.map((p) => p.id);
  const dup = planIds.find((id, i) => planIds.indexOf(id) !== i);
  if (dup !== undefined) out.push(`duplicate plan id ${dup}`);
  for (const r of pack.zones.relax) {
    const problem = relaxProblem(r.allow);
    if (problem !== undefined) out.push(`zone relaxation refused: ${problem}`);
  }
  if (pack.safety.requiresScope && pack.safety.scopeKinds.length === 0) {
    out.push('safety.requiresScope needs at least one scopeKinds entry');
  }
  return out;
}
