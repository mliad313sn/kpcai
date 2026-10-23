/** Pure state transitions for a run, driven by validated `GraphEvent`s (spec §4.2). */
import type { Contribution, GraphEvent, NodeState, Ref } from '../rpc/schemas';
import type { NodeRun, RunView } from './types';

/** Upper bound of streamed text kept per stream; older text is cut (the journal has it all). */
export const MAX_STREAM_CHARS = 200_000;

const ACTIVE: ReadonlySet<NodeState> = new Set(['running', 'review']);
const TERMINAL: ReadonlySet<NodeState> = new Set(['done', 'failed', 'skipped', 'cancelled']);

export const isActive = (s: NodeState): boolean => ACTIVE.has(s);
export const isTerminal = (s: NodeState): boolean => TERMINAL.has(s);

export const refKey = (r: Ref): string => `${r.provider}/${r.model}`;
export const streamKey = (role: string, r: Ref): string => `${role} ${refKey(r)}`;

export function blankNode(): NodeRun {
  return { state: 'pending', costUsd: 0, streams: {}, contributions: [] };
}

export function newRun(runId: string, request: string, now: number): RunView {
  return {
    runId,
    request,
    state: 'starting',
    nodes: {},
    costUsd: 0,
    patches: [],
    applied: [],
    startedAt: now,
    controls: [],
    artifacts: [],
  };
}

function onNodeState(n: NodeRun, e: Extract<GraphEvent, { type: 'node_state' }>, now: number) {
  const next: NodeRun = { ...n, state: e.state };
  if (e.ref) next.ref = e.ref;
  if (e.role) next.role = e.role;
  if (e.reason !== undefined) next.reason = e.reason;
  if (e.score !== undefined) next.score = e.score;
  if (isActive(e.state)) {
    next.startedAt ??= now;
    const changed =
      !isActive(n.state) ||
      (e.ref && (!n.ref || refKey(e.ref) !== refKey(n.ref))) ||
      (e.role && e.role !== n.role);
    if (changed) next.stepStartedAt = now;
  }
  if (isTerminal(e.state)) next.endedAt = now;
  return next;
}

function onText(n: NodeRun, e: Extract<GraphEvent, { type: 'text' }>): NodeRun {
  const key = streamKey(e.role, e.ref);
  const joined = (n.streams[key] ?? '') + e.delta;
  const text = joined.length > MAX_STREAM_CHARS ? joined.slice(-MAX_STREAM_CHARS) : joined;
  return { ...n, streams: { ...n.streams, [key]: text } };
}

type Usage = { inputTokens: number; outputTokens: number };

function onContribution(n: NodeRun, c: Contribution, usage: Usage | undefined): NodeRun {
  const streams = { ...n.streams };
  delete streams[streamKey(c.role, c.ref)];
  const next: NodeRun = {
    ...n,
    streams,
    contributions: [...n.contributions, c],
    costUsd: round6(n.costUsd + c.costUsd),
  };
  if (usage) {
    const t = n.tokens ?? { input: 0, output: 0 };
    next.tokens = { input: t.input + usage.inputTokens, output: t.output + usage.outputTokens };
  }
  return next;
}

export const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

export function applyEvent(run: RunView, e: GraphEvent, now: number): RunView {
  if (e.type === 'graph_done') {
    return { ...run, ok: e.ok, costUsd: e.costUsd };
  }
  const n = run.nodes[e.nodeId] ?? blankNode();
  let next: NodeRun;
  let costUsd = run.costUsd;
  if (e.type === 'node_state') next = onNodeState(n, e, now);
  else if (e.type === 'text') next = onText(n, e);
  else {
    next = onContribution(n, e.contribution, e.usage);
    costUsd = round6(costUsd + e.contribution.costUsd);
  }
  return { ...run, costUsd, nodes: { ...run.nodes, [e.nodeId]: next } };
}

interface ResultLike {
  output?: unknown;
  error?: unknown;
  approved?: unknown;
}

/** Folds the final `GraphResult` of `run.done` into the nodes (outputs, errors, approval). */
export function applyResult(run: RunView, result: unknown): RunView {
  const results = (result as { results?: unknown } | null)?.results;
  if (!results || typeof results !== 'object') return run;
  const nodes = { ...run.nodes };
  for (const [id, raw] of Object.entries(results as Record<string, ResultLike>)) {
    if (!raw || typeof raw !== 'object') continue;
    const n = { ...(nodes[id] ?? blankNode()) };
    if (typeof raw.output === 'string') n.output = raw.output;
    if (typeof raw.error === 'string') n.error = raw.error;
    if (typeof raw.approved === 'boolean') n.approved = raw.approved;
    nodes[id] = n;
  }
  const ok = (result as { ok?: unknown }).ok;
  return { ...run, nodes, ...(typeof ok === 'boolean' ? { ok } : {}) };
}
