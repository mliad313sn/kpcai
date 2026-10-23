/** Protocol methods → kernel service calls. Params arrive validated; results are checked later. */
import { ProviderError } from '@kernelpai/core';
import {
  KernelError,
  packSummary,
  scopeSummary,
  summarizeRules,
  type Kernel,
  type KernelErrorCode,
  type RunHandle,
} from '@kernelpai/kernel';
import {
  ErrorCodes,
  PROTOCOL_VERSION,
  type MethodName,
  type Methods,
} from '@kernelpai/kernel/protocol';
import type { z } from 'zod';
import type { ConfirmBroker } from './confirm-broker.js';

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
}

const hello: Handler<'kernel.hello'> = (p) => {
  if (p.protocol !== PROTOCOL_VERSION)
    throw new RpcError(ErrorCodes.invalidRequest, `protocol ${p.protocol} not supported`);
  return { protocol: PROTOCOL_VERSION, server: 'kernelpai' };
};

/** A plan as the console sees it: graph, estimate, rules, packs, zones, scope. */
async function planResult(kernel: Kernel, p: ParamsOf<'plan'>) {
  const plan = await kernel.plan(p.request, p.options ?? {});
  return {
    planId: plan.planId,
    graph: plan.graph,
    estimate: plan.estimate,
    rules: summarizeRules(plan.rules.rules),
    packs: packSummary(plan.packs),
    scope: scopeSummary(plan.scope),
  };
}

export function handlers(d: HandlerDeps): Handlers {
  const { kernel } = d;
  return {
    'kernel.hello': hello,
    'providers.list': async () => ({ providers: await kernel.providers() }),
    'tools.list': () => kernel.tools(),
    plan: (p) => planResult(kernel, p),
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
        options: { ...p.options, isolated: p.options?.isolated ?? 'auto' },
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
    'confirm.answer': (p) => ({ accepted: d.broker.answer(p.confirmId, p.ok) }),
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
