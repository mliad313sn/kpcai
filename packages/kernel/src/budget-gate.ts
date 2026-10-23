import { refToString, type ScoredCandidate } from '@kernelpai/core';
import { Governor, JournalLedger } from '@kernelpai/budget';
import type { Journal } from '@kernelpai/journal';
import type { Confirm } from './confirm.js';
import { budgetLimits, formatMoney, type Env, type Money } from './env.js';

/** The orchestrator's label when a node would exceed its `budgetUsd` (S4, P3-F5). */
const NODE_CAP = /^node \S+ total: /;

export interface GateContext {
  sessionId: string;
  nodeId: string;
  m: Money;
  /** Attached to confirmation requests so a console can show which run asks. */
  runId?: string;
}

/** What a gate needs from its host: settings, a place to explain itself, a human to ask. */
export interface GateHost {
  env: Env;
  cwd: string;
  /** One diagnostic message, newline-terminated (a terminal prints it as is). */
  say(text: string): void;
  confirm: Confirm;
}

export interface GateFlags {
  /** Accept cost confirmations without asking (never writes, review P2-F15). */
  yes?: boolean;
  /** Continue past a budget block (journaled override, review F10). */
  overBudget?: boolean;
}

/**
 * Principle 6 at every spend point: the planner, the first choice, each step and each
 * fallback (review F1). Block → stop unless overBudget (journaled override, review F10);
 * confirm → ask the human or `yes`. A refusal is always journaled.
 */
export class BudgetGate {
  private readonly governor: Governor;

  constructor(
    private readonly host: GateHost,
    private readonly journal: Journal,
    private readonly ctx: GateContext,
    private readonly flags: GateFlags,
  ) {
    this.governor = new Governor(budgetLimits(host.env), new JournalLedger(journal));
  }

  async allow(c: ScoredCandidate, label: string): Promise<boolean> {
    if (label.startsWith('graph total')) return this.graphCap(label, 'the cap you accepted');
    // A node's own budgetUsd (S4, P3-F5) is a cap too: never a silent governor pass.
    if (NODE_CAP.test(label)) return this.graphCap(label, 'this node’s budget');
    const est = c.estimate.expectedCostUsd;
    const v = this.governor.check(est, {
      sessionId: this.ctx.sessionId,
      project: this.host.cwd,
      now: new Date(),
    });
    const who = `${label} ${refToString(c.ref)}`;
    if (v.action === 'allow') return true;
    if (v.action === 'block') {
      const why = `${who} blocked by ${v.scope} budget: ${this.money(v.projectedUsd)} > ${this.money(v.limitUsd)}`;
      if (this.flags.overBudget)
        return this.record(`budget override (--over-budget): ${why}`, v, true);
      this.host.say(
        `${why}. Options: --over-budget to continue, -p economy or --exclude for cheaper models, or a smaller request\n`,
      );
      return this.record(`budget: ${why}`, v, false);
    }
    const ok =
      this.flags.yes === true ||
      (await this.ask(
        `${who}: expected ${this.money(est)} is above your confirmation threshold. Continue?`,
      ));
    if (!ok) this.host.say(`not run — ${who} declined at confirmation\n`);
    return ok ? true : this.record(`budget: ${who} declined at confirmation`, v, false);
  }

  /**
   * The run would exceed the graph cap the user accepted before it started, or a node its
   * `budgetUsd`: always a human decision (or the CLI's `--over-budget`, which the console
   * protocol cannot send), never a silent governor pass (review P2-F9, P3-F5). No answer is no.
   */
  private async graphCap(label: string, cap: string): Promise<boolean> {
    const ok =
      this.flags.overBudget === true ||
      (await this.ask(`${label}: the run would exceed ${cap}. Continue?`));
    if (!ok) this.host.say(`not continued — ${label}\n`);
    return this.record(`${ok ? 'accepted' : 'refused'}: ${label}`, { label }, ok);
  }

  private ask(question: string): Promise<boolean> {
    return this.host.confirm({
      kind: 'budget',
      question,
      ...(this.ctx.runId ? { runId: this.ctx.runId } : {}),
    });
  }

  private money(usd: number): string {
    return formatMoney(usd, this.ctx.m);
  }

  private record(action: string, verdict: unknown, result: boolean): boolean {
    this.journal.append({
      sessionId: this.ctx.sessionId,
      type: 'intervention',
      nodeId: this.ctx.nodeId,
      payload: { action, verdict },
    });
    return result;
  }
}
