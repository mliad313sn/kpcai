/** Protocol methods → kernel service calls. Params arrive validated; results are checked later. */
import { ProviderError } from '@kernelpai/core';
import { KernelError, type Kernel, type KernelErrorCode, type RunHandle } from '@kernelpai/kernel';
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

export function handlers(d: HandlerDeps): Handlers {
  const { kernel } = d;
  return {
    'kernel.hello': (p) => {
      if (p.protocol !== PROTOCOL_VERSION)
        throw new RpcError(ErrorCodes.invalidRequest, `protocol ${p.protocol} not supported`);
      return { protocol: PROTOCOL_VERSION, server: 'kernelpai' };
    },
    'providers.list': async () => ({ providers: await kernel.providers() }),
    'tools.list': () => kernel.tools(),
    plan: async (p) => {
      const plan = await kernel.plan(p.request, p.options ?? {});
      return { planId: plan.planId, graph: plan.graph, estimate: plan.estimate };
    },
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
        ...(p.options ? { options: p.options } : {}),
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
    'confirm.answer': (p) => ({ accepted: d.broker.answer(p.confirmId, p.ok) }),
    'sessions.list': (p) => ({ sessions: kernel.sessions(p.limit ?? 20) }),
    'sessions.events': (p) => ({ events: kernel.events(p.sessionId, p.limit ?? 1000) }),
    stats: (p) => kernel.stats(p?.sessionId),
    'journal.verify': () => kernel.verify(),
  };
}
