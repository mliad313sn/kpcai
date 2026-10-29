/**
 * The kernel's questions for a program run (ADR-0031 §6.2, ADR-0035). The envelope answers
 * in the Sponsor's place only `budget-within-envelope` and `write-in-worktree`, decided on
 * the D-028 typed facts (`confirmFacts`), never on the question text; the pre-answer is
 * journaled with its rule (R-5PA). Everything else becomes a question in the Sponsor's inbox
 * and the run waits for the answer; silence until the wait ends is a no (fail closed).
 */
import { randomBytes } from 'node:crypto';
import { confirmFacts, type ConfirmRequest, type Kernel } from '@kernelpai/kernel';
import { checkAction, type ProgramState } from '@kernelpai/program';
import { attempt } from './context.js';
import type { Feed } from './feed.js';
import type { EnterpriseStore } from './store.js';
import type { ProgramContext } from './starter.js';

/** The only verdict rules a pre-answer may rest on (the closed `PreAnswerSchema` values). */
export const PRE_ANSWER_RULES: ReadonlySet<string> = new Set(['budget.within', 'confirm.worktree']);

export interface GateDeps {
  store: EnterpriseStore;
  kernel: Kernel;
  feed: Feed;
  clock: () => Date;
  waitMs: () => number;
  pollMs?: number;
  /** The program's journal session for facts. */
  session: (programId: string) => string;
}

export const newId = (prefix: string): string => `${prefix}-${randomBytes(5).toString('hex')}`;

/**
 * The state the envelope sees for a question of a live run: that run's own reservation is
 * released (its band top was checked when it started), so an amount inside it is not
 * counted twice; every other run still weighs as usual (D-021).
 */
export function withoutReservation(s: ProgramState, runId: string | undefined): ProgramState {
  return {
    ...s,
    runs: s.runs.map((r) =>
      r.runId === runId && r.status === 'running' ? { ...r, capUsd: r.costUsd } : r,
    ),
  };
}

/** Kernel run states in which a question of the run is void. */
const ENDED: ReadonlySet<string> = new Set(['cancelling', 'cancelled', 'done', 'failed']);
const CANCELLED: ReadonlySet<string> = new Set(['cancelling', 'cancelled']);

interface Waiting {
  runId: string | undefined;
  wake: (why: string) => void;
}

export class ConfirmGate {
  private readonly pollMs: number;
  /** Questions waiting for the Sponsor in this process, by escalation id. */
  private readonly waiting = new Map<string, Waiting>();
  /** Runs whose question ended because they were cancelled or stopped, and why (P5-R1). */
  private readonly voided = new Map<string, string>();

  constructor(private readonly d: GateDeps) {
    this.pollMs = d.pollMs ?? 500;
  }

  async decide(ctx: ProgramContext, req: ConfirmRequest): Promise<boolean> {
    const now = this.d.clock();
    const { state } = this.d.store.read(ctx.programId);
    const facts = confirmFacts(req);
    const v = checkAction(withoutReservation(state, req.runId), facts, now);
    const base = { programId: ctx.programId, runId: req.runId, kind: req.kind, rule: v.rule };
    const gone = this.voidReason(ctx.programId, req.runId);
    if (gone) {
      this.fact(ctx.programId, { action: 'confirmation refused', ...base, reason: gone });
      return false;
    }
    if (v.verdict === 'allow' && PRE_ANSWER_RULES.has(v.rule)) {
      this.fact(ctx.programId, {
        action: 'pre-answered',
        ...base,
        amountUsd: facts.amountUsd,
        inWorktree: facts.inWorktree,
      });
      return true;
    }
    if (v.verdict === 'refuse') {
      this.fact(ctx.programId, { action: 'confirmation refused', ...base, reason: v.reason });
      return false;
    }
    const rule = v.verdict === 'escalate' ? v.rule : `confirm.${req.kind}`;
    return this.ask(ctx, req, rule, now);
  }

  /** A question for the Sponsor; resolves with their answer, or no when the wait ends. */
  private async ask(
    ctx: ProgramContext,
    req: ConfirmRequest,
    rule: string,
    now: Date,
  ): Promise<boolean> {
    const id = newId('esc');
    const question = `Run ${req.runId ?? '(starting)'} of ${ctx.wpId} asks (${req.kind}): ${req.question.slice(0, 400)}`;
    const evidence = req.runId ? [{ kind: 'run' as const, id: req.runId }] : [];
    const t = await this.d.store.locked(() => {
      const r = this.d.store.applyLocked(
        ctx.programId,
        { type: 'escalate', escalation: { id, at: now.toISOString(), rule, question } },
        'po',
        now,
      );
      if (r.ok)
        this.d.store.updateMeta(ctx.programId, (m) => {
          m.escalations[id] = {
            kind: 'confirm',
            ...(req.runId ? { runId: req.runId } : {}),
            evidence,
          };
        });
      return r;
    });
    if (!t.ok) return false;
    this.d.feed.notify('enterprise.inbox', {
      programId: ctx.programId,
      escalationId: id,
      state: 'open',
    });
    this.d.feed.line(`${ctx.wpId}: a question waits for you (${rule})`, ctx.programId, [
      { kind: 'escalation', id },
    ]);
    return this.wait(ctx.programId, id, req.runId, now.getTime() + this.d.waitMs());
  }

  /**
   * The guard cancelled or stopped a run (P5-R1, D-035): its questions end now, as a no,
   * and expire in the store, so a late yes is refused. Other kernel cancels arrive here too
   * (`cancelConfirmations`); the poll also notices them on its own.
   */
  abandon(runId: string, why: string): void {
    for (const w of this.waiting.values()) if (w.runId === runId) w.wake(why);
  }

  /** Why a run's question was voided (once): its settlement records it as cancelled. */
  takeVoided(runId: string): string | undefined {
    const why = this.voided.get(runId);
    this.voided.delete(runId);
    return why;
  }

  /** Why a question of this run can no longer be answered yes, if it cannot (P5-R1). */
  private voidReason(programId: string, runId: string | undefined): string | undefined {
    const killed = attempt(() => this.d.store.config().portfolio.killSwitch);
    if (killed) return 'kill switch on';
    const status = attempt(() => this.d.store.read(programId).state.status);
    if (status === 'stopped' || status === 'delivered') return `program ${status}`;
    if (runId === undefined) return undefined;
    // A run this kernel does not know (a test's fake) is judged on the store alone.
    const state = attempt(() => this.d.kernel.runInfo(runId).state);
    if (!state || !ENDED.has(state)) return undefined;
    return CANCELLED.has(state) ? 'run cancelled' : `run ${state}`;
  }

  private async wait(
    programId: string,
    id: string,
    runId: string | undefined,
    until: number,
  ): Promise<boolean> {
    const w: Waiting = { runId, wake: () => undefined };
    let woke: string | undefined;
    this.waiting.set(id, w);
    try {
      for (;;) {
        const why = woke ?? this.voidReason(programId, runId);
        if (why) {
          if (runId !== undefined) this.voided.set(runId, why);
          return await this.close(programId, id, why);
        }
        const x = this.d.store.read(programId).state.escalations.find((e) => e.id === id);
        if (x?.answer) return x.answer === 'yes';
        if (this.d.clock().getTime() >= until) return await this.close(programId, id);
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, this.pollMs);
          w.wake = (reason) => {
            woke ??= reason;
            clearTimeout(t);
            resolve();
          };
        });
      }
    } finally {
      this.waiting.delete(id);
    }
  }

  /**
   * Ends a question under the lock: on expiry an answer that lands now is not lost; when
   * the run was cancelled or stopped (`why`), the answer is a no whatever was said.
   */
  private async close(programId: string, id: string, why?: string): Promise<boolean> {
    const late = await this.d.store.locked(() => {
      const x = this.d.store.read(programId).state.escalations.find((e) => e.id === id);
      if (x?.answer) return x.answer === 'yes' && !why;
      this.d.store.updateMeta(programId, (m) => {
        const e = m.escalations[id];
        if (e) e.expired = true;
      });
      return undefined;
    });
    if (late !== undefined) return late;
    this.d.feed.notify('enterprise.inbox', { programId, escalationId: id, state: 'expired' });
    this.fact(programId, {
      action: 'question expired',
      programId,
      escalationId: id,
      why: why ?? 'the wait ended',
    });
    return false;
  }

  private fact(programId: string, payload: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    this.d.kernel.recordFact(this.d.session(programId), clean);
  }
}
