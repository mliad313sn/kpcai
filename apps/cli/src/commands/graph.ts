import {
  Kernel,
  KernelError,
  money,
  type GraphOptions,
  type RunHandle,
  type RunOutcome,
} from '@kernelpai/kernel';
import { formatMoney } from '../config.js';
import { showAndApply } from '../graph/apply.js';
import { renderEvent, renderGraphPlan, renderOutputs } from '../graph/render.js';
import { kernelHost } from '../host.js';
import type { Io } from '../io.js';

/** `kpai plan` / `kpai do` options: the kernel's planning options plus terminal-only ones. */
export interface GraphCliOptions extends GraphOptions {
  request: string;
  apply?: boolean;
  /** Approve the git.apply write without asking (separate from --yes, review P2-F15). */
  yesApply?: boolean;
  newSession?: boolean;
  db?: string;
}

function open(io: Io, o: GraphCliOptions): Kernel {
  const m = money(io.env);
  return new Kernel(
    kernelHost(io, {
      ...(o.db ? { db: o.db } : {}),
      onEvent: (_runId, e) => {
        const line = renderEvent(e, m);
        if (line) io.err(line);
      },
    }),
  );
}

/** A kernel refusal the terminal reports as "not run" with its exit code, else rethrown. */
function notRun(io: Io, err: unknown): number {
  if (err instanceof KernelError && err.code === 'workspace') {
    io.err(`not run — ${err.message}\n`);
    return 2;
  }
  if (err instanceof KernelError && err.code === 'unroutable') {
    io.err('not run — some nodes cannot be routed (see the plan above)\n');
    return 1;
  }
  throw err;
}

/** `kpai plan "request"`: the graph, who would do what, and the cost range. Runs nothing. */
export async function planCommand(io: Io, o: GraphCliOptions): Promise<number> {
  const kernel = open(io, o);
  try {
    const sessionId = kernel.openSession(`plan: ${o.request.slice(0, 74)}`, false);
    const p = await kernel.plan(o.request, o, sessionId);
    io.out(renderGraphPlan(p.graph, p.estimate, p.m));
    return p.estimate.complete ? 0 : 1;
  } catch (err) {
    return notRun(io, err);
  } finally {
    await kernel.close();
  }
}

/** `kpai do "request"`: plan → estimate → budget → run the graph live → outputs → patches. */
export async function doCommand(io: Io, o: GraphCliOptions): Promise<number> {
  const kernel = open(io, o);
  try {
    const sessionId = kernel.openSession(o.request, !o.newSession);
    // Before planning: a --planner model call is already a paid call (review N6).
    kernel.checkWorkspace();
    const p = await kernel.plan(o.request, o, sessionId);
    io.err(renderGraphPlan(p.graph, p.estimate, p.m));
    const handle = await kernel.startRun({ request: o.request, planId: p.planId, options: o });
    const outcome = await untilDone(io, kernel, handle);
    if (outcome.status === 'not_run') return 4;
    io.out(renderOutputs(p.graph, outcome.result));
    const applied = await showAndApply(io, kernel, handle.runId, outcome, o);
    io.err(
      `session ${sessionId.slice(0, 8)} · ${formatMoney(outcome.result.costUsd, p.m)} · ${applied}\n`,
    );
    return outcome.result.ok ? 0 : 1;
  } catch (err) {
    return notRun(io, err);
  } finally {
    await kernel.close();
  }
}

/** Ctrl+C cancels the run (running steps keep their partial output). */
async function untilDone(io: Io, kernel: Kernel, handle: RunHandle): Promise<RunOutcome> {
  const unregister = io.onInterrupt(() => void kernel.cancel(handle.runId));
  try {
    return await handle.done;
  } finally {
    unregister();
  }
}
