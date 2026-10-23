/** Protocol methods → kernel service calls. Params arrive validated; results are checked later. */
import { ProviderError } from '@kernelpai/core';
import {
  KernelError,
  extensionsSummary,
  packSummary,
  scopeSummary,
  summarizeRules,
  type Kernel,
  type KernelErrorCode,
  type LayerRef,
  type NodeEdit,
  type RunHandle,
} from '@kernelpai/kernel';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type MethodName,
  type Methods,
  type RunOptions,
} from '@kernelpai/kernel/protocol';
import type { z } from 'zod';
import type { EnterpriseRuntime } from '@kernelpai/enterprise';
import type { ConfirmBroker } from './confirm-broker.js';
import { extensionHandlers } from './extension-handlers.js';
import { enterpriseHandlers } from './enterprise-handlers.js';

type ParamsOf<M extends MethodName> = z.infer<(typeof Methods)[M]['params']>;
type Handler<M extends MethodName> = (params: ParamsOf<M>) => unknown;
export type Handlers = { [M in MethodName]: Handler<M> };

/** An error with a JSON-RPC code, sent to the client as is. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const KERNEL_CODES: Readonly<Record<KernelErrorCode, number>> = {
  workspace: ErrorCodes.workspace,
  unroutable: ErrorCodes.unroutable,
  budget: ErrorCodes.budget,
  not_found: ErrorCodes.notFound,
  refused: ErrorCodes.refused,
  unsupported: ErrorCodes.unsupported,
  invalid: ErrorCodes.invalidParams,
};

/** JSON-RPC code and message for any error a handler throws. */
export function toRpcError(err: unknown): { code: number; message: string } {
  if (err instanceof RpcError) return { code: err.code, message: err.message };
  if (err instanceof KernelError) return { code: KERNEL_CODES[err.code], message: err.message };
  if (err instanceof ProviderError) return { code: ErrorCodes.refused, message: err.message };
  return { code: ErrorCodes.internal, message: err instanceof Error ? err.message : String(err) };
}

export interface HandlerDeps {
  kernel: Kernel;
  broker: ConfirmBroker;
  /** Called once per started run, to stream its end to the clients. */
  watch(handle: RunHandle): void;
  /** The server's default run options; a request's own options win (`--allow-test`). */
  defaults?: Pick<RunOptions, 'allowTest'>;
  /** Enterprise mode (ADR-0035); without it `program.*` and `enterprise.*` are unsupported. */
  enterprise?: EnterpriseRuntime;
}

const hello: Handler<'kernel.hello'> = (p) => {
  if (p.protocol !== PROTOCOL_VERSION)
    throw new RpcError(ErrorCodes.invalidRequest, `protocol ${p.protocol} not supported`);
  return { protocol: PROTOCOL_VERSION, server: 'kernelpai' };
};

/** A plan as the console sees it: graph, estimate, rules, packs, zones, scope. */
async function planResult(kernel: Kernel, p: ParamsOf<'plan'>, defaults: RunOptions) {
  const plan = await kernel.plan(p.request, { ...defaults, ...p.options });
  return {
    planId: plan.planId,
    graph: plan.graph,
    estimate: plan.estimate,
    rules: summarizeRules(plan.rules.rules),
    packs: packSummary(plan.packs),
    scope: scopeSummary(plan.scope),
    ...(plan.memory ? { memory: plan.memory.summary } : {}),
    ...(plan.extensions ? { extensions: extensionsSummary(plan.extensions) } : {}),
  };
}

export function handlers(d: HandlerDeps): Handlers {
  const { kernel } = d;
  const defaults: RunOptions = d.defaults ?? {};
  return {
    'kernel.hello': hello,
    'providers.list': async () => ({
      providers: await kernel.providers(),
      testAllowed: defaults.allowTest === true,
    }),
    'tools.list': () => kernel.tools(),
    plan: (p) => planResult(kernel, p, defaults),
    // Checked with the plan's own options: test providers stay refused unless it allowed them.
    'plan.validate': (p) => {
      const c = kernel.validatePlan(p.planId, p.graph);
      return {
        ok: c.ok,
        problems: c.problems,
        warnings: c.warnings,
        changes: c.changes,
        ...(c.estimate ? { estimate: c.estimate } : {}),
      };
    },
    'run.start': async (p) => {
      const handle = await kernel.startRun({
        request: p.request,
        ...(p.planId ? { planId: p.planId } : {}),
        ...(p.graph ? { graph: p.graph } : {}),
        // ADR-0021: console runs are isolated by default when the workspace is a git tree.
        options: { ...defaults, ...p.options, isolated: p.options?.isolated ?? 'auto' },
      });
      d.watch(handle);
      return { runId: handle.runId };
    },
    'run.cancel': (p) => ({ cancelled: kernel.cancel(p.runId) }),
    'run.pause': (p) => (kernel.pause(p.runId), { ok: true }),
    'run.resume': (p) => (kernel.resume(p.runId), { ok: true }),
    'run.redirect': async (p) => (await kernel.redirect(p.runId, p.nodeId, p.to), { ok: true }),
    'run.instruct': (p) => (kernel.instruct(p.runId, p.nodeId, p.text), { ok: true }),
    'patches.apply': async (p) => ({
      // A console never pre-approves writes: each patch is confirmed with its diff.
      results: await kernel.applyPatches(p.runId, p.nodeIds ? { nodeIds: p.nodeIds } : {}),
    }),
    ...workspaceHandlers(kernel),
    ...memoryHandlers(kernel),
    ...learningHandlers(kernel, d, defaults),
    ...extensionHandlers(kernel),
    ...enterpriseHandlers(d.enterprise),
    'confirm.answer': (p) => ({ accepted: d.broker.answer(p.confirmId, p.ok, p.choice) }),
    ...journalHandlers(kernel),
  };
}

type JournalMethod = 'sessions.list' | 'sessions.events' | 'stats' | 'journal.verify';

function journalHandlers(kernel: Kernel): Pick<Handlers, JournalMethod> {
  return {
    'sessions.list': (p) => ({ sessions: kernel.sessions(p.limit ?? 20) }),
    'sessions.events': (p) => ({ events: kernel.events(p.sessionId, p.limit ?? 1000) }),
    stats: (p) => kernel.stats(p?.sessionId),
    'journal.verify': () => kernel.verify(),
  };
}

type WorkspaceMethod =
  'artifacts.apply' | 'run.checkpoints' | 'run.restore' | 'run.merge' | 'run.discard' | 'runs.list';

/** Checkpoints, restore, worktrees, artifacts (ADR-0021, ADR-0022). Writes are always asked. */
function workspaceHandlers(kernel: Kernel): Pick<Handlers, WorkspaceMethod> {
  return {
    'artifacts.apply': async (p) => ({
      results: await kernel.applyArtifacts(p.runId, p.paths ? { paths: p.paths } : {}),
    }),
    'run.checkpoints': async (p) => ({ checkpoints: await kernel.checkpoints(p.runId) }),
    'run.restore': (p) => kernel.restore(p.ref, p.runId),
    'run.merge': (p) => kernel.merge(p.runId),
    'run.discard': (p) => kernel.discard(p.runId),
    'runs.list': async () => ({ runs: await kernel.runList() }),
  };
}

type MemoryMethod = Extract<MethodName, `memory.${string}`>;
type Layer = LayerRef['layer'];

/** `{layer, sessionId?}` of a memory request. */
function layerRef(p: { layer: Layer; sessionId?: string | undefined }): LayerRef {
  return p.sessionId ? { layer: p.layer, sessionId: p.sessionId } : { layer: p.layer };
}

/**
 * Unified memory (ADR-0027). Only a human at a client calls these: model tools cannot. A
 * client's `memory.confirm` is the human's yes; proposals are never confirmed otherwise.
 */
function memoryHandlers(kernel: Kernel): Pick<Handlers, MemoryMethod> {
  const m = kernel.memory;
  return {
    'memory.list': async (p) => {
      const l = await m.list(layerRef(p));
      return {
        layer: p.layer,
        file: l.file,
        exists: l.exists,
        facts: l.facts,
        problems: l.problems,
      };
    },
    'memory.add': async (p) => ({ fact: await m.add(layerRef(p), p.text, p.localOnly === true) }),
    'memory.edit': async (p) => ({
      fact: await m.edit(layerRef(p), p.id, {
        ...(p.text !== undefined ? { text: p.text } : {}),
        ...(p.localOnly !== undefined ? { localOnly: p.localOnly } : {}),
      }),
    }),
    'memory.remove': async (p) => ({ fact: await m.remove(layerRef(p), p.id) }),
    'memory.pending': async () => ({ pending: await m.pending() }),
    'memory.confirm': async (p) => ({ fact: await m.confirm(p.id) }),
    'memory.reject': async (p) => ({ rejected: await m.reject(p.id) }),
  };
}

/** A fork plan as the console sees it: what reruns, what is reused, the estimate. */
async function forkPlanResult(kernel: Kernel, p: ParamsOf<'run.forkPlan'>, defaults: RunOptions) {
  const e = p.edit ?? {};
  const edit = {
    ...(e.model ? { model: e.model } : {}),
    ...(e.protocol ? { protocol: e.protocol } : {}),
    ...(e.instruction ? { instruction: e.instruction } : {}),
  };
  // The kernel holds these to the run's routing as a floor (P4-F2).
  const plan = await kernel.forkPlan(p.runId, p.nodeId, edit, { ...defaults, ...p.options });
  const fork = plan.fork!;
  return {
    planId: plan.planId,
    parent: fork.parent,
    rerun: fork.rerun,
    reused: Object.keys(fork.reuse),
    edits: fork.edits,
    graph: plan.graph,
    estimate: plan.estimate,
  };
}

/** The edit of a replay request: model and protocol only. */
function replayEdit(p: ParamsOf<'run.replay'>): NodeEdit {
  return {
    ...(p.model ? { model: p.model } : {}),
    ...(p.protocol ? { protocol: p.protocol } : {}),
  };
}

/** A replay's estimate before anything is spent (P4-F5): likely, cap, routing, scope. */
async function replayPlanResult(
  kernel: Kernel,
  p: ParamsOf<'run.replayPlan'>,
  defaults: RunOptions,
) {
  const options = { ...defaults, ...p.options };
  const plan = await kernel.replayPlan(p.runId, p.nodeId, replayEdit(p), options);
  const o = plan.options;
  return {
    planId: plan.planId,
    runId: plan.runId,
    nodeId: plan.nodeId,
    routing: {
      ...(o.localOnly ? { localOnly: true } : {}),
      ...(o.exclude?.length ? { exclude: o.exclude } : {}),
      ...(o.profile ? { profile: o.profile } : {}),
      allowTest: o.allowTest === true,
      // Provider diversity waived: only when the original run waived it (P4-R3).
      ...(o.allowSameProvider === true ? { allowSameProvider: true } : {}),
    },
    estimate: plan.estimate,
    scope: scopeSummary(plan.scope),
  };
}

/** `run.replay`: a planned replay (cancellable by its id), or planned and run at once. */
async function replayResult(kernel: Kernel, p: ParamsOf<'run.replay'>, defaults: RunOptions) {
  if (!p.planId)
    return kernel.replay(p.runId, p.nodeId, replayEdit(p), { ...defaults, ...p.options });
  const handle = await kernel.startReplay(p.planId);
  if (handle.runId !== p.runId || handle.nodeId !== p.nodeId)
    throw new RpcError(ErrorCodes.invalidParams, `replay plan ${p.planId} is for another node`);
  return handle.done;
}

type LearningMethod =
  | 'grade'
  | 'stats.accuracy'
  | 'stats.productivity'
  | 'competence'
  | 'run.replay'
  | 'run.replayPlan'
  | 'run.forkPlan'
  | 'run.fork';

/**
 * Grades, measured competence, accuracy (ADR-0028); replay and fork (R-403). A replay
 * spends through the budget gate; a fork starts like a plan (band top checked, D-021).
 */
function learningHandlers(
  kernel: Kernel,
  d: HandlerDeps,
  defaults: RunOptions,
): Pick<Handlers, LearningMethod> {
  return {
    // The author is always the local user the server runs as (P4-F9), never the client's word.
    grade: (p) =>
      kernel.learning.grade({
        runId: p.runId,
        nodeId: p.nodeId,
        grade: p.grade,
        ...(p.note ? { note: p.note } : {}),
      }),
    'stats.accuracy': () => kernel.learning.accuracy(),
    'stats.productivity': (p) =>
      kernel.learning.productivity({
        ...(p?.since ? { since: p.since } : {}),
        ...(p?.reworkDays ? { reworkDays: p.reworkDays } : {}),
        ...(p?.detail ? { detail: true } : {}),
      }),
    competence: () => ({ entries: kernel.learning.competence() }),
    'run.replayPlan': (p) => replayPlanResult(kernel, p, defaults),
    'run.replay': (p) => replayResult(kernel, p, defaults),
    'run.forkPlan': (p) => forkPlanResult(kernel, p, defaults),
    'run.fork': async (p) => {
      // Like run.start: isolated when the workspace is a git working tree (ADR-0021).
      const handle = await kernel.startFork(p.planId, { ...defaults, isolated: 'auto' });
      d.watch(handle);
      return { runId: handle.runId };
    },
  };
}
