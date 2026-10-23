import type { NodeState, ProtocolName, ProtocolResult, TaskGraph } from '@kernelpai/core';
import type { Journal, JournalEvent } from '@kernelpai/journal';
import type { DisputeRecord } from './dispute.js';
import type { StepRunner } from './step.js';
import type { PlannedNode } from './types.js';

/**
 * The run's own record in the journal (spec §3.5, R-403): what each node received and
 * returned, so a node can be replayed and a run forked later from the journal alone.
 * Records are `intervention` events carrying the run id; secrets never reach them (node
 * messages hold the request, the repository rules and memory as injected, already journaled
 * in each call's request).
 */
export const RUN_STARTED = 'run started';
export const NODE_RECORDED = 'node recorded';
export const REPLAY_STARTED = 'replay started';
export const REPLAY_RECORDED = 'replay recorded';

/** Actions of the run's own record (not interventions in the decision sense). */
export const RECORD_ACTIONS: ReadonlySet<string> = new Set([
  RUN_STARTED,
  NODE_RECORDED,
  REPLAY_STARTED,
  REPLAY_RECORDED,
]);

/** How many recent sessions a lookup reads (a run id is a UUID: one hit is enough). */
const SCAN_SESSIONS = 500;
const SCAN_EVENTS = 100_000;

/** Where a fork came from. */
export interface ForkOrigin {
  runId: string;
  nodeId: string;
}

/**
 * The routing constraints a run was started under (P4-F2): journaled with `run started` so
 * that a replay or a fork of the run can hold them as a floor (stricter, never looser).
 * Provider-neutral: no model ids, no secrets.
 */
export interface RunRouting {
  /** Only `kind: local` providers. */
  localOnly?: boolean;
  /** Providers the run was told never to use. */
  exclude?: string[];
  /** The routing profile in force (economy, balanced, performance). */
  profile?: string;
  /** True when `kind: test` providers were allowed. */
  allowTest?: boolean;
  /** True when the run waived provider diversity (principle 2); else absent (P4-R3). */
  allowSameProvider?: boolean;
  /** True for an unattended run (no subscription agent, D-029 R1); else absent. */
  unattended?: boolean;
}

/** A finished node as recorded: its inputs, its result and how long it took. */
export interface RecordedNode {
  /** Id of the journal event holding this record. */
  eventId: string;
  nodeId: string;
  state: NodeState;
  /** The node as it ran (instructions, policy and rules applied). */
  node: PlannedNode;
  /** The protocol that ran (after principle-2 upgrades). */
  protocol: ProtocolName;
  /** Dependency outputs exactly as the node received them (quoted context). */
  context: string;
  /** Providers behind the dependencies (a review avoids them). */
  upstream: string[];
  /** Each dependency's output, for display. */
  dependencies: Record<string, string>;
  result: ProtocolResult;
  durationMs: number;
  /** True when a fork reused this node's result from its parent run (not re-run). */
  reused?: boolean;
  /** For a reused node: the parent run's record event it was taken from. */
  reusedFrom?: string;
  dispute?: DisputeRecord;
  /**
   * Set by the kernel when the node's output may quote local-only memory facts (it, or a
   * node it depends on, was served by a local provider while such facts existed: ADR-0027
   * §6). A replay or fork keeps it on local providers (P4-R1).
   */
  localTaint?: boolean;
}

export interface RecordedReplay {
  eventId: string;
  replayId: string;
  nodeId: string;
  result: ProtocolResult;
  durationMs: number;
}

export interface RecordedRun {
  runId: string;
  sessionId: string;
  /** Id of the `run started` event. */
  eventId: string;
  graph: TaskGraph & { nodes: PlannedNode[] };
  parent?: ForkOrigin;
  /** The run's routing constraints; absent for runs journaled before P4-F2. */
  routing?: RunRouting;
  reused: string[];
  nodes: Record<string, RecordedNode>;
  replays: RecordedReplay[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;

/** Journals the start of a run with the graph as it will run. */
export function journalRunStart(
  steps: StepRunner,
  runId: string,
  graph: TaskGraph,
  fork?: { parent: ForkOrigin; reused: string[] },
  routing?: RunRouting,
): void {
  steps.intervention(undefined, {
    action: RUN_STARTED,
    runId,
    graph: { ...graph, nodes: graph.nodes },
    ...(fork ? { parent: fork.parent, reused: fork.reused } : {}),
    ...(routing ? { routing } : {}),
  });
}

/** A journaled routing record, read defensively (journal payloads are data). */
export function toRouting(x: unknown): RunRouting | undefined {
  if (!isObj(x)) return undefined;
  const exclude = Array.isArray(x['exclude'])
    ? x['exclude'].filter((p): p is string => typeof p === 'string')
    : [];
  return {
    ...(x['localOnly'] === true ? { localOnly: true } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(typeof x['profile'] === 'string' ? { profile: x['profile'] } : {}),
    ...(typeof x['allowTest'] === 'boolean' ? { allowTest: x['allowTest'] } : {}),
    ...(x['allowSameProvider'] === true ? { allowSameProvider: true } : {}),
    ...(x['unattended'] === true ? { unattended: true } : {}),
  };
}

/** Journals one node's record (inputs, result, duration). */
export function journalNode(
  steps: StepRunner,
  runId: string,
  rec: Omit<RecordedNode, 'eventId' | 'nodeId'>,
): void {
  steps.intervention(rec.result.nodeId, { action: NODE_RECORDED, runId, ...rec });
}

/** Reads a run's record back from the journal; undefined when the run is unknown. */
export function readRun(
  journal: Journal,
  runId: string,
  sessionId?: string,
): RecordedRun | undefined {
  // Replays may be journaled from another session than the run's: every session is read.
  const sessions = journal.sessions(SCAN_SESSIONS).map((s) => s.id);
  if (sessionId && !sessions.includes(sessionId)) sessions.unshift(sessionId);
  const events: JournalEvent[] = [];
  let start: JournalEvent | undefined;
  for (const sid of sessions) {
    for (const e of journal.events({ sessionId: sid, limit: SCAN_EVENTS })) {
      if (e.type !== 'intervention' || e.payload['runId'] !== runId) continue;
      if (e.payload['action'] === RUN_STARTED) start ??= e;
      events.push(e);
    }
  }
  return start ? assemble(runId, start.sessionId, start, events) : undefined;
}

function assemble(
  runId: string,
  sessionId: string,
  start: JournalEvent,
  events: JournalEvent[],
): RecordedRun | undefined {
  const p = start.payload;
  if (!isObj(p['graph']) || !Array.isArray(p['graph']['nodes'])) return undefined;
  const nodes: Record<string, RecordedNode> = {};
  const replays: RecordedReplay[] = [];
  for (const e of events) {
    const node = e.payload['action'] === NODE_RECORDED ? toNode(e) : undefined;
    if (node) nodes[node.nodeId] = node;
    const replay = e.payload['action'] === REPLAY_RECORDED ? toReplay(e) : undefined;
    if (replay) replays.push(replay);
  }
  const parent = p['parent'];
  const routing = toRouting(p['routing']);
  return {
    runId,
    sessionId,
    eventId: start.id,
    graph: p['graph'] as unknown as RecordedRun['graph'],
    ...(isObj(parent) ? { parent: parent as unknown as ForkOrigin } : {}),
    ...(routing ? { routing } : {}),
    reused: Array.isArray(p['reused']) ? (p['reused'] as string[]) : [],
    nodes,
    replays,
  };
}

function toNode(e: JournalEvent): RecordedNode | undefined {
  const p = e.payload;
  if (!e.nodeId || !isObj(p['node']) || !isObj(p['result'])) return undefined;
  return {
    eventId: e.id,
    nodeId: e.nodeId,
    state: p['state'] as NodeState,
    node: p['node'] as unknown as PlannedNode,
    protocol: p['protocol'] as ProtocolName,
    context: typeof p['context'] === 'string' ? p['context'] : '',
    upstream: Array.isArray(p['upstream']) ? (p['upstream'] as string[]) : [],
    dependencies: isObj(p['dependencies']) ? (p['dependencies'] as Record<string, string>) : {},
    result: p['result'] as unknown as ProtocolResult,
    durationMs: typeof p['durationMs'] === 'number' ? p['durationMs'] : 0,
    ...(p['reused'] === true ? { reused: true } : {}),
    ...(typeof p['reusedFrom'] === 'string' ? { reusedFrom: p['reusedFrom'] } : {}),
    ...(isObj(p['dispute']) ? { dispute: p['dispute'] as unknown as DisputeRecord } : {}),
    ...(p['localTaint'] === true ? { localTaint: true } : {}),
  };
}

function toReplay(e: JournalEvent): RecordedReplay | undefined {
  const p = e.payload;
  if (!e.nodeId || typeof p['replayId'] !== 'string' || !isObj(p['result'])) return undefined;
  return {
    eventId: e.id,
    replayId: p['replayId'],
    nodeId: e.nodeId,
    result: p['result'] as unknown as ProtocolResult,
    durationMs: typeof p['durationMs'] === 'number' ? p['durationMs'] : 0,
  };
}
