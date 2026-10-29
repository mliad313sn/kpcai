/**
 * What each node of a run did, read from its journaled events (ADR-0028): who produced its
 * output, on which task type, what the critics said of each draft, the last test run, and
 * what became of its patches (applied, refused, declined, rolled back).
 */
import { refToString, type ModelRef } from '@kernelpai/core';
import type { JournalEvent } from '@kernelpai/journal';
import { accepted, parseVerdict } from '@kernelpai/orchestrator';
import type { RunRecord } from './runs.js';
import { ACTIONS, NOT_ANSWERED, PRODUCER_ROLES } from './signals.js';
import { isTestCommand, testRunOutcome } from './test-runs.js';

export interface Verdict {
  author: ModelRef;
  critic: ModelRef;
  approved: boolean;
  seq: number;
}

export interface PatchFate {
  seq: number;
  applied: boolean;
  /** Undone by a checkpoint restore, or its merge-back was declined. */
  undone?: 'rollback' | 'declined';
  undoneSeq?: number;
}

export interface NodeWork {
  nodeId: string;
  /** The model whose answer is the node's output (last solo/author/revision answer). */
  producer?: ModelRef;
  taskType?: string;
  /** Model of the draft a critic would review next. */
  lastDraft?: ModelRef;
  verdicts: Verdict[];
  /** Critic verdicts dropped because the critic reviewed its own draft. */
  selfReviews: number[];
  tests?: { passed: boolean; seq: number };
  patches: PatchFate[];
  /** A patch refused for hidden control characters (never applied). */
  refusedSeq?: number;
}

interface CallInfo {
  taskType?: string;
  role?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const sameRef = (a: ModelRef, b: ModelRef): boolean =>
  a.provider === b.provider && a.model === b.model;

/** A node id of a kernel write: `n2#patch-0` and `n2#artifact-1` belong to node `n2`. */
export const baseNode = (id: string): string => id.replace(/#(patch|artifact)-\d+$/, '');

function node(works: Map<string, NodeWork>, id: string): NodeWork {
  let w = works.get(id);
  if (!w) {
    w = { nodeId: id, verdicts: [], selfReviews: [], patches: [] };
    works.set(id, w);
  }
  return w;
}

function planTypes(plan: JournalEvent | undefined): Map<string, string> {
  const nodes = (plan?.payload.plan as { nodes?: unknown } | undefined)?.nodes;
  const out = new Map<string, string>();
  if (!Array.isArray(nodes)) return out;
  for (const n of nodes as Array<Record<string, unknown>>) {
    const id = str(n?.id);
    const type = str(n?.type);
    if (id && type) out.set(id, type);
  }
  return out;
}

function onResponse(w: NodeWork, e: JournalEvent, call: CallInfo | undefined): void {
  const ref = { provider: e.provider as string, model: e.model as string };
  const role = str(e.payload.role) ?? call?.role;
  const text = str(e.payload.text) ?? '';
  const stop = str(e.payload.stopReason);
  if (role === 'critic') {
    const author = w.lastDraft;
    const v = author ? parseVerdict(text) : undefined;
    if (!author || !v?.ok) return;
    if (sameRef(author, ref)) w.selfReviews.push(e.seq);
    else w.verdicts.push({ author, critic: ref, approved: accepted(v.value), seq: e.seq });
    return;
  }
  if (role !== undefined && !PRODUCER_ROLES.has(role)) return;
  if ((stop !== undefined && NOT_ANSWERED.has(stop)) || text.trim() === '') return;
  w.producer = ref;
  w.lastDraft = ref;
  if (call?.taskType) w.taskType = call.taskType;
}

/**
 * A `test.run` result (R-505): the command it ran must be a real test command (no dry run,
 * listing or `--passWithNoTests`, P4-F10) and its parsed status decides: passed 1, failed
 * or timed out 0; no test ran, a refused start or a cancel prove nothing. Nor does a run
 * whose own test configuration the run had changed (`tampered`, P5-F4): no V2, grade or DVO.
 * When the configuration could not be checked (`configChecked: false`, no git), a failure
 * still counts but a pass proves nothing (D-035).
 */
function testRunResult(meta: unknown): boolean | undefined {
  const m = (meta ?? {}) as {
    command?: unknown;
    args?: unknown;
    status?: unknown;
    timedOut?: unknown;
    tampered?: unknown;
    configChecked?: unknown;
  };
  if (m.tampered === true) return undefined;
  const unchecked = m.configChecked === false;
  const args = Array.isArray(m.args) ? m.args.map(String) : [];
  if (typeof m.command !== 'string' || !isTestCommand(m.command, args)) return undefined;
  if (m.status === 'failed' || m.timedOut === true) return false;
  if (m.status === 'passed' && !unchecked) return true;
  return undefined;
}

/**
 * The outcome of a test run journaled by `shell.run` or `test.run`: only a command that
 * really runs tests counts, and a pass needs evidence where the output is whole (P4-F10,
 * `test-runs.ts`).
 */
function testOutcome(e: JournalEvent): boolean | undefined {
  const p = e.payload;
  const decision = str(p.decision);
  if (decision !== 'allow' && decision !== 'confirmed') return undefined;
  if (p.tool === 'test.run') return testRunResult(p.meta);
  if (p.tool !== 'shell.run') return undefined;
  const input = (p.input ?? {}) as { command?: unknown; args?: unknown };
  const args = Array.isArray(input.args) ? input.args.map(String) : [];
  if (typeof input.command !== 'string' || !isTestCommand(input.command, args)) return undefined;
  const meta = (p.meta ?? {}) as {
    exitCode?: unknown;
    timedOut?: unknown;
    aborted?: unknown;
    tampered?: unknown;
    configChecked?: unknown;
  };
  if (meta.tampered === true) return undefined; // P5-F4, as for test.run
  const outcome = testRunOutcome({ ...meta, result: p.result });
  return outcome === true && meta.configChecked === false ? undefined : outcome;
}

function duringRun(works: Map<string, NodeWork>, events: readonly JournalEvent[]): void {
  const calls = new Map<string, CallInfo>();
  for (const e of events) {
    const id = e.nodeId;
    const requestId = str(e.payload.requestId);
    if (e.type === 'call' && requestId) {
      calls.set(requestId, { taskType: str(e.payload.taskType), role: str(e.payload.role) });
    }
    if (!id) continue;
    if (e.type === 'response' && e.provider && e.model) {
      onResponse(node(works, id), e, requestId ? calls.get(requestId) : undefined);
    } else if (e.type === 'tool') {
      const passed = testOutcome(e);
      if (passed !== undefined) node(works, id).tests = { passed, seq: e.seq };
    } else if (e.type === 'intervention' && e.payload.action === ACTIONS.patchRefused) {
      node(works, id).refusedSeq = e.seq;
    }
  }
}

function undo(works: Map<string, NodeWork>, kind: PatchFate['undone'], from: number, seq: number) {
  const all = [...works.values()].flatMap((w) => w.patches.filter((p) => p.applied && !p.undone));
  const later = all.filter((p) => p.seq > from);
  for (const p of later.length > 0 ? later : all) {
    p.undone = kind;
    p.undoneSeq = seq;
  }
}

function afterRun(works: Map<string, NodeWork>, events: readonly JournalEvent[]): void {
  const checkpoints = new Map<string, number>();
  for (const e of events) {
    const action = str(e.payload.action);
    if (e.type === 'tool' && e.nodeId) {
      const ok = ['allow', 'confirmed'].includes(str(e.payload.decision) ?? '');
      const applied = ok && e.payload.isError !== true;
      node(works, baseNode(e.nodeId)).patches.push({ seq: e.seq, applied });
    } else if (action === ACTIONS.checkpoint) {
      const ref = str(e.payload.ref);
      if (ref) checkpoints.set(ref, e.seq);
    } else if (action === ACTIONS.restore) {
      undo(works, 'rollback', checkpoints.get(str(e.payload.ref) ?? '') ?? -1, e.seq);
    } else if (action === ACTIONS.mergeDeclined) {
      undo(works, 'declined', -1, e.seq);
    }
  }
}

/** Per node of a run: producer, task type, verdicts, tests and patch fates. */
export function nodeWork(run: RunRecord): Map<string, NodeWork> {
  const works = new Map<string, NodeWork>();
  duringRun(works, run.events);
  afterRun(works, run.after);
  const types = planTypes(run.plan);
  for (const w of works.values()) {
    const planned = types.get(w.nodeId);
    if (planned) w.taskType = planned;
  }
  return works;
}

export const refKey = refToString;
