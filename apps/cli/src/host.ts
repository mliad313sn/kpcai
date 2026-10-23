import type { Journal } from '@kernelpai/journal';
import {
  BudgetGate,
  type Choose,
  type GateContext,
  type GateFlags,
  type GateHost,
  type KernelHost,
} from '@kernelpai/kernel';
import type { Io } from './io.js';
import { sanitizeForTerminal } from './sanitize.js';

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
  return { env, cwd, say, confirm, choose: terminalChoose(io), ...extra };
}

const QUOTE_CHARS = 2_000;

/** Untrusted model text, quoted line by line and made safe for the terminal. */
function quoted(text: string): string {
  const t = sanitizeForTerminal(text);
  const cut = t.length > QUOTE_CHARS ? `${t.slice(0, QUOTE_CHARS)}…` : t;
  return cut
    .split('\n')
    .map((l) => `    > ${l}`)
    .join('\n');
}

/**
 * A disputed node at the terminal (R-405): the positions and options are shown quoted
 * (model output, untrusted), then one yes/no per option; the first yes picks it. All no,
 * or no terminal, rejects: the node fails closed.
 */
export function terminalChoose(io: Io): Choose {
  return async (req) => {
    const d = req.dispute;
    const lines = [
      `--- dispute on node ${sanitizeForTerminal(d.nodeId)}: ${sanitizeForTerminal(d.reason)}`,
    ];
    for (const p of d.positions)
      lines.push(`  ${sanitizeForTerminal(p.ref)} (${p.role}) says:`, quoted(p.says));
    for (const o of d.options)
      lines.push(
        `  option ${sanitizeForTerminal(o.label)} (backed by ${o.backers.map(sanitizeForTerminal).join(', ') || 'nobody'}):`,
        quoted(o.text),
      );
    io.err(`${lines.join('\n')}\n`);
    for (const o of d.options) {
      if (
        await io.confirm(
          `Take option ${sanitizeForTerminal(o.label)} for node ${sanitizeForTerminal(d.nodeId)}?`,
        )
      )
        return o.id;
    }
    io.err('dispute rejected: the node delivers nothing\n');
    return null;
  };
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
