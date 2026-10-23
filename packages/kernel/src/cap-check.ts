/**
 * Principle 6 on a whole graph, or on a replay, before anything runs (D-021, ADR-0026): the
 * figure checked and approved is the cap (the band's top), the likely cost is shown beside
 * it. Each step is gated again later by the `BudgetGate`.
 */
import { Governor, JournalLedger } from '@kernelpai/budget';
import type { Journal } from '@kernelpai/journal';
import type { GateHost } from './budget-gate.js';
import { budgetLimits, formatMoney, type Money } from './env.js';

export interface CapCheck {
  /** What is checked, as the messages name it: `graph` (a run) or `replay`. */
  what: 'graph' | 'replay';
  sessionId: string;
  /** Attached to the budget question, so a client can show (and void) it. */
  runId: string;
  capUsd: number;
  expectedUsd: number;
  m: Money;
  /** `yes`: the cap was already accepted by the human; `overBudget`: pass a block. */
  flags: { yes?: boolean | undefined; overBudget?: boolean | undefined };
}

/** Returns why it does not run, or undefined to go ahead; the decision is journaled. */
export async function capCheck(
  host: GateHost,
  journal: Journal,
  c: CapCheck,
): Promise<string | undefined> {
  const governor = new Governor(budgetLimits(host.env), new JournalLedger(journal));
  const { sessionId, what, m } = c;
  const v = governor.check(c.capUsd, { sessionId, project: host.cwd, now: new Date() });
  if (v.action === 'allow') return undefined;
  const likely = `likely ${formatMoney(c.expectedUsd, m)}`;
  const why =
    v.action === 'block'
      ? `${what} blocked by ${v.scope} budget: ${formatMoney(v.projectedUsd, m)} > ${formatMoney(v.limitUsd, m)} (cap; ${likely})`
      : `${what} estimate up to ${formatMoney(c.capUsd, m)} (cap; ${likely}) is above your confirmation threshold`;
  const { yes, overBudget } = c.flags;
  if (v.action === 'block' && !overBudget) {
    host.say(`not run — ${why}. Use --over-budget, -p economy, or a smaller request\n`);
  } else if (
    yes ||
    overBudget ||
    (await host.confirm({ kind: 'budget', question: `${why}. Continue?`, runId: c.runId }))
  ) {
    journal.append({
      sessionId,
      type: 'intervention',
      payload: { action: `${what} accepted: ${why}` },
    });
    return undefined;
  }
  journal.append({
    sessionId,
    type: 'intervention',
    payload: { action: `${what} not run: ${why}`, verdict: v },
  });
  return why;
}
