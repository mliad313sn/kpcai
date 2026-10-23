import { refToString, TaskTypeSchema, type Candidate, type TaskGraph } from '@kernelpai/core';
import { isDeliverable } from './deliverable.js';
import { estimateGraph, type EstimateDeps, type GraphEstimate } from './estimate.js';
import { sameRef } from './routing.js';
import type { PlannedNode } from './types.js';
import { graphProblems } from './validate.js';

const PROTOCOLS = new Set(['solo', 'author_critic', 'debate', 'vote']);
const CRITICALITIES = new Set(['low', 'normal', 'critical']);
const MAX_NODE_ID = 100;

export interface PlanCheck {
  /** True when the plan can run as edited: no problem. */
  ok: boolean;
  /** Blocking problems: malformed fields, unknown ids or models, cycles, diversity. */
  problems: string[];
  /** Non-blocking notes: node budget or graph cap below the low end of the band. */
  warnings: string[];
  /** Re-estimate of the edited plan (absent when the structure is invalid). */
  estimate?: GraphEstimate;
  /** What changed against the original plan, one line each (when an original is given). */
  changes: string[];
}

export interface PlanCheckOptions extends EstimateDeps {
  /** The graph cap the run will use, to warn when the band starts above it. */
  maxGraphUsd?: number;
  /** The plan as proposed, to list the user's edits. */
  original?: TaskGraph;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const NODE_ID = /^[A-Za-z0-9_-]+$/;

/** Field problems of one edited node (the UI sends untrusted JSON). */
export function nodeProblems(n: PlannedNode, candidates: readonly Candidate[]): string[] {
  // Ids end up in budget labels, journal keys and batch keys: letters, digits, _ and - only
  // (review NF-1: an id with a space escaped the node-cap question).
  const id = isStr(n.id) && NODE_ID.test(n.id) && n.id.length <= MAX_NODE_ID ? n.id : undefined;
  if (!id) return [`node id must be 1 to ${MAX_NODE_ID} letters, digits, _ or -`];
  const p: string[] = [];
  const bad = (what: string): number => p.push(`node "${id}": ${what}`);
  if (!isStr(n.title)) bad('title must be a string');
  if (!TaskTypeSchema.safeParse(n.type).success) bad(`unknown task type "${String(n.type)}"`);
  if (!PROTOCOLS.has(n.protocol)) bad(`unknown protocol "${String(n.protocol)}"`);
  if (!CRITICALITIES.has(n.criticality)) bad(`unknown criticality "${String(n.criticality)}"`);
  const budget = n.budgetUsd;
  if (
    budget !== undefined &&
    !(typeof budget === 'number' && Number.isFinite(budget) && budget >= 0)
  ) {
    bad('budgetUsd must be a number ≥ 0');
  }
  if (!Array.isArray(n.dependsOn) || !n.dependsOn.every(isStr)) bad('dependsOn must list node ids');
  if (n.tools !== undefined && !(Array.isArray(n.tools) && n.tools.every(isStr))) {
    bad('tools must list tool names');
  }
  const asks =
    Array.isArray(n.messages) &&
    n.messages.some((m) => m?.role === 'user' && isStr(m.content) && m.content.trim() !== '');
  if (!asks) bad('needs a non-empty user message');
  p.push(...packFieldProblems(n).map((w) => `node "${id}": ${w}`));
  if (n.model !== undefined) {
    const m = n.model as unknown as Record<string, unknown> | null;
    if (!m || !isStr(m.provider) || !isStr(m.model)) bad('model must be {provider, model}');
    else if (!candidates.some((c) => sameRef(c.ref, n.model as PlannedNode['model'] & object))) {
      bad(`model ${refToString(n.model)} is not an available candidate`);
    }
  }
  return p;
}

/** The orchestrator-local fields a pack plan adds (WI-S4-01); all optional. */
function packFieldProblems(n: PlannedNode): string[] {
  const p: string[] = [];
  if (n.deliverable !== undefined && !isDeliverable(n.deliverable)) {
    p.push(`unknown deliverable "${String(n.deliverable)}"`);
  }
  for (const f of ['pack', 'guidance', 'proposedType'] as const) {
    if (n[f] !== undefined && !isStr(n[f])) p.push(`${f} must be a string`);
  }
  const rc = n.reviewCriteria;
  if (rc !== undefined && !(Array.isArray(rc) && rc.every(isStr))) {
    p.push('reviewCriteria must list strings');
  }
  for (const f of ['critics', 'judges'] as const) {
    const v = n[f];
    if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3)) {
      p.push(`${f} must be 1, 2 or 3`);
    }
  }
  return p;
}

/**
 * Validates a plan the user edited before launch (R-301): every node well formed, ids
 * unique and known, no cycle, chosen models available, every protocol routable with
 * principle 2 (diversity) met; then re-estimates it (band included). Only a plan with
 * `ok` should be approved; `GraphRunner.run` then runs exactly that graph.
 */
export function validatePlan(graph: TaskGraph, options: PlanCheckOptions): PlanCheck {
  const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []) as PlannedNode[];
  const changes = options.original ? planChanges(options.original, graph) : [];
  const problems: string[] = nodes.length === 0 ? ['the plan has no node'] : [];
  for (const n of nodes) problems.push(...nodeProblems(n, options.candidates));
  if (problems.length > 0) return { ok: false, problems, warnings: [], changes };
  problems.push(...graphProblems(nodes));
  if (problems.length > 0) return { ok: false, problems, warnings: [], changes };
  const estimate = estimateGraph(graph, options);
  problems.push(...estimate.problems);
  const warnings: string[] = [];
  for (const e of estimate.nodes) {
    const budget = nodes.find((n) => n.id === e.nodeId)?.budgetUsd;
    if (budget !== undefined && e.band.lowUsd > budget) {
      warnings.push(
        `node "${e.nodeId}": budget $${budget} is below its low estimate $${e.band.lowUsd}`,
      );
    }
  }
  const cap = options.maxGraphUsd;
  if (cap !== undefined && estimate.band.lowUsd > cap) {
    warnings.push(`maxGraphUsd $${cap} is below the low estimate $${estimate.band.lowUsd}`);
  }
  return { ok: problems.length === 0, problems, warnings, estimate, changes };
}

const ref = (n: PlannedNode): string => (n.model ? refToString(n.model) : 'routed');
const prompt = (n: PlannedNode): string => JSON.stringify(n.messages);

const FIELDS: Array<[string, (n: PlannedNode) => string]> = [
  ['model', ref],
  ['protocol', (n) => String(n.protocol)],
  ['criticality', (n) => String(n.criticality)],
  ['budgetUsd', (n) => (n.budgetUsd === undefined ? 'none' : String(n.budgetUsd))],
  ['type', (n) => String(n.type)],
  ['dependsOn', (n) => (Array.isArray(n.dependsOn) ? n.dependsOn.join(',') : '?')],
  ['tools', (n) => (n.tools ?? []).join(',')],
  ['deliverable', (n) => String(n.deliverable ?? 'default')],
];

/** The user's edits between two plans, one line each, in the edited plan's order. */
export function planChanges(original: TaskGraph, edited: TaskGraph): string[] {
  const before = new Map((original.nodes as PlannedNode[]).map((n) => [n.id, n]));
  const after = new Set(edited.nodes.map((n) => n.id));
  const out = original.nodes.filter((n) => !after.has(n.id)).map((n) => `removed node ${n.id}`);
  for (const n of edited.nodes as PlannedNode[]) {
    const o = before.get(n.id);
    if (!o) {
      out.push(`added node ${n.id}`);
      continue;
    }
    for (const [field, get] of FIELDS) {
      if (get(o) !== get(n)) out.push(`${n.id}: ${field} ${get(o)} → ${get(n)}`);
    }
    if (prompt(o) !== prompt(n) || o.title !== n.title || o.guidance !== n.guidance) {
      out.push(`${n.id}: prompt edited`);
    }
  }
  return out;
}
