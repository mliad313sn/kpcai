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

export class ConfirmGate {
  private readonly pollMs: number;

  constructor(private readonly d: GateDeps) {
    this.pollMs = d.pollMs ?? 500;
  }

  async decide(ctx: ProgramContext, req: ConfirmRequest): Promise<boolean> {
    const now = this.d.clock();
    const { state } = this.d.store.read(ctx.programId);
    const facts = confirmFacts(req);
    const v = checkAction(withoutReservation(state, req.runId), facts, now);
    const base = { programId: ctx.programId, runId: req.runId, kind: req.kind, rule: v.rule };
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
    return this.wait(ctx.programId, id, now.getTime() + this.d.waitMs());
  }

  private async wait(programId: string, id: string, until: number): Promise<boolean> {
    for (;;) {
      const x = this.d.store.read(programId).state.escalations.find((e) => e.id === id);
      if (x?.answer) return x.answer === 'yes';
      if (this.d.clock().getTime() >= until) break;
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    // Decided under the lock: an answer that lands now is not lost to the expiry.
    const late = await this.d.store.locked(() => {
      const x = this.d.store.read(programId).state.escalations.find((e) => e.id === id);
      if (x?.answer) return x.answer === 'yes';
      this.d.store.updateMeta(programId, (m) => {
        const e = m.escalations[id];
        if (e) e.expired = true;
      });
      return undefined;
    });
    if (late !== undefined) return late;
    this.d.feed.notify('enterprise.inbox', { programId, escalationId: id, state: 'expired' });
    this.fact(programId, { action: 'question expired', programId, escalationId: id });
    return false;
  }

  private fact(programId: string, payload: Record<string, unknown>): void {
    const clean = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
    this.d.kernel.recordFact(this.d.session(programId), clean);
  }
}
