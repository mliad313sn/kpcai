/**
 * Confirmations as server → client `confirm.request` notifications, answered by the
 * `confirm.answer` method. The first answer wins; no answer before the timeout, no client
 * connected, or a request that cannot be shown in full all mean "no".
 */
import { randomUUID } from 'node:crypto';
import type { ConfirmRequest } from '@kernelpai/kernel';
import type { NotificationName, Notifications } from '@kernelpai/kernel/protocol';
import type { z } from 'zod';

export type ConfirmParams = z.infer<(typeof Notifications)['confirm.request']>;

/** Sends a notification to every connected client; returns how many were reached. */
export type Broadcast = (name: NotificationName, params: unknown) => number;

const MAX_QUESTION = 10_000;
const MAX_PATCH = 2_000_000;

export class ConfirmBroker {
  private readonly pending = new Map<
    string,
    { runId?: string; settle: (ok: boolean, choice?: string) => void }
  >();

  constructor(
    private readonly broadcast: Broadcast,
    readonly timeoutMs: number,
  ) {}

  ask(req: ConfirmRequest): Promise<boolean> {
    return this.request(req).then((a) => a.ok);
  }

  /**
   * A dispute (R-405): resolves with the option the human picked, or null for a rejection,
   * an unknown option, silence or no client (the node then fails closed).
   */
  async choose(req: ConfirmRequest): Promise<string | null> {
    const a = await this.request(req);
    const ids = req.dispute?.options.map((o) => o.id) ?? [];
    return a.ok && a.choice !== undefined && ids.includes(a.choice) ? a.choice : null;
  }

  private request(req: ConfirmRequest): Promise<{ ok: boolean; choice?: string }> {
    // What cannot be shown in full cannot be approved.
    if ((req.patch?.length ?? 0) > MAX_PATCH || (req.content?.length ?? 0) > MAX_PATCH)
      return Promise.resolve({ ok: false });
    const confirmId = randomUUID();
    const params: ConfirmParams = {
      confirmId,
      kind: req.kind,
      question:
        req.question.length > MAX_QUESTION
          ? `${req.question.slice(0, MAX_QUESTION - 1)}…`
          : req.question,
      timeoutMs: this.timeoutMs,
      ...(req.runId ? { runId: req.runId } : {}),
      ...(req.risk ? { risk: req.risk } : {}),
      ...(req.patch !== undefined ? { patch: req.patch } : {}),
      ...(req.content !== undefined ? { content: req.content } : {}),
      ...(req.artifact ? { artifact: req.artifact } : {}),
      ...(req.memory ? { memory: req.memory } : {}),
      ...(req.dispute ? { dispute: req.dispute } : {}),
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), this.timeoutMs);
      const settle = (ok: boolean, choice?: string): void => {
        clearTimeout(timer);
        this.pending.delete(confirmId);
        resolve(choice !== undefined ? { ok, choice } : { ok });
      };
      this.pending.set(confirmId, { ...(req.runId ? { runId: req.runId } : {}), settle });
      if (this.broadcast('confirm.request', params) === 0) settle(false);
    });
  }

  /** True when the answer settled a pending confirmation. */
  answer(confirmId: string, ok: boolean, choice?: string): boolean {
    const p = this.pending.get(confirmId);
    if (!p) return false;
    p.settle(ok === true, choice);
    return true;
  }

  /**
   * The run was cancelled: its confirmations still on screen become "no", and every client
   * is told with `confirm.closed` so it can close the dialog (review P3-F2). A late answer
   * to one of them is not accepted.
   */
  declineRun(runId: string): number {
    const mine = [...this.pending].filter(([, p]) => p.runId === runId);
    for (const [confirmId, p] of mine) {
      p.settle(false);
      this.broadcast('confirm.closed', { confirmId, runId, reason: 'cancelled' });
    }
    return mine.length;
  }

  /** Declines everything still waiting (server shutting down). */
  declineAll(): void {
    for (const p of [...this.pending.values()]) p.settle(false);
  }

  get waiting(): number {
    return this.pending.size;
  }
}
