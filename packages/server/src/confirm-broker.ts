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
  private readonly pending = new Map<string, (ok: boolean) => void>();

  constructor(
    private readonly broadcast: Broadcast,
    readonly timeoutMs: number,
  ) {}

  ask(req: ConfirmRequest): Promise<boolean> {
    // What cannot be shown in full cannot be approved.
    if ((req.patch?.length ?? 0) > MAX_PATCH || (req.content?.length ?? 0) > MAX_PATCH)
      return Promise.resolve(false);
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
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(false), this.timeoutMs);
      const settle = (ok: boolean): void => {
        clearTimeout(timer);
        this.pending.delete(confirmId);
        resolve(ok);
      };
      this.pending.set(confirmId, settle);
      if (this.broadcast('confirm.request', params) === 0) settle(false);
    });
  }

  /** True when the answer settled a pending confirmation. */
  answer(confirmId: string, ok: boolean): boolean {
    const settle = this.pending.get(confirmId);
    if (!settle) return false;
    settle(ok === true);
    return true;
  }

  /** Declines everything still waiting (server shutting down). */
  declineAll(): void {
    for (const settle of [...this.pending.values()]) settle(false);
  }

  get waiting(): number {
    return this.pending.size;
  }
}
