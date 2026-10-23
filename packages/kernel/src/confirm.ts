/** Human confirmations the kernel asks for, and how they are serialized. */

/** `restore` (ADR-0021) and `artifact` (ADR-0022) are destructive / write confirmations. */
export type ConfirmKind = 'budget' | 'tool' | 'patch' | 'restore' | 'artifact';

export interface ConfirmRequest {
  kind: ConfirmKind;
  /** One line a human can answer with yes or no. */
  question: string;
  runId?: string;
  risk?: 'read' | 'write' | 'destructive';
  /** For `patch`: the exact diff that would be applied (shown apart from the question). */
  patch?: string;
  /** For `artifact`: the exact text that would be written, and what it is. */
  content?: string;
  artifact?: {
    path: string;
    kind: string;
    mime: string;
    bytes: number;
    nodeId: string;
    /** False: no critic reviewed it; shown as "not reviewed" (D-020 ruling). */
    reviewed: boolean;
  };
}

/** Resolves true only on an explicit yes; anything else (silence, error) is a no. */
export type Confirm = (req: ConfirmRequest) => Promise<boolean>;

/**
 * Confirmations are asked one at a time: parallel steps must never share one keystroke or
 * one click (review P2-F7). Each question waits for the previous answer; a failing asker
 * never blocks the next question.
 */
export function serialized<Q>(ask: (q: Q) => Promise<boolean>): (q: Q) => Promise<boolean> {
  let tail: Promise<unknown> = Promise.resolve();
  return (q) => {
    const next = tail.then(() => ask(q));
    tail = next.catch(() => undefined);
    return next;
  };
}

/** A host's confirm, serialized; without one every confirmation is declined. */
export function hostConfirm(confirm: Confirm | undefined): Confirm {
  if (!confirm) return () => Promise.resolve(false);
  const one = serialized(confirm);
  return async (req) => (await one(req)) === true;
}
