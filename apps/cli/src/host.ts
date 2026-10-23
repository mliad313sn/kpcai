import type { Journal } from '@kernelpai/journal';
import {
  BudgetGate,
  type GateContext,
  type GateFlags,
  type GateHost,
  type KernelHost,
} from '@kernelpai/kernel';
import type { Io } from './io.js';

/** The terminal as the kernel's host: diagnostics on stderr, confirmations at the prompt. */
export function gateHost(io: Io): GateHost {
  return {
    env: io.env,
    cwd: io.cwd,
    say: (text) => io.err(text),
    confirm: (req) => io.confirm(req.question),
  };
}

export function kernelHost(io: Io, extra: Partial<KernelHost> = {}): KernelHost {
  const { env, cwd, say, confirm } = gateHost(io);
  return { env, cwd, say, confirm, ...extra };
}

/** Principle 6 at every spend point of `kpai run` (the kernel's gate on the terminal). */
export function budgetGate(
  io: Io,
  journal: Journal,
  ctx: GateContext,
  flags: GateFlags,
): BudgetGate {
  return new BudgetGate(gateHost(io), journal, ctx, flags);
}
