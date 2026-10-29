/** Human confirmations the kernel asks for, and how they are serialized. */

import type { MemoryConfirmInfo } from './memory-service.js';

/**
 * `restore` (ADR-0021) and `artifact` (ADR-0022) are destructive / write confirmations;
 * `memory` asks to keep a model's memory proposal (ADR-0027); `dispute` asks the human to
 * pick one answer of a disputed node or reject them all (R-405, through `Choose`).
 */
export type ConfirmKind =
  'budget' | 'tool' | 'patch' | 'restore' | 'artifact' | 'memory' | 'dispute';

/** A disputed node as the human sees it. Option and position text is untrusted model output. */
export interface DisputeInfo {
  nodeId: string;
  kind: string;
  reason: string;
  options: Array<{ id: string; label: string; text: string; backers: string[] }>;
  positions: Array<{ ref: string; role: string; says: string; option?: string }>;
}

export interface ConfirmRequest {
  kind: ConfirmKind;
  /** One line a human can answer with yes or no. */
  question: string;
  runId?: string;
  risk?: 'read' | 'write' | 'destructive';
  /**
   * Structured facts for a delegate deciding without reading the question (D-028,
   * ADR-0033; additive, optional). `amountUsd`: for `budget`, the amount asked in USD;
   * absent when it is not known (then nobody may answer in the human's place).
   */
  amountUsd?: number;
  /** The write lands in the run's own worktree (R-307), not in the user's tree. */
  inWorktree?: boolean;
  /** The step may actuate a physical device (a selected pack has physical effects, D-019). */
  physical?: boolean;
  /**
   * The write touches a control file (D-035, P5-F2): `.kpstudio/`, `.claude/`, `.mcp.json`,
   * package.json or a test configuration. Never pre-answered, never batch-approved.
   */
  control?: boolean;
  /**
   * The question relaxes a D-020 protection (D-035, P5-R3): a pack's zone relaxation or a
   * workspace opt-in. Consequential (`confirm.zone`): never pre-answered, never batched.
   */
  zoneRelaxation?: boolean;
  /** For `budget`: spend past a cap the human already accepted (D-035, P5-F2). */
  overCap?: boolean;
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
  /** For `memory`: the proposed fact and its provenance. */
  memory?: MemoryConfirmInfo;
  /** For `dispute`: the options and who backs them. */
  dispute?: DisputeInfo;
}

/**
 * Asks the human to pick one option (`dispute`): resolves with an option id, or null for
 * a rejection, silence or an error. Null fails closed (the node delivers nothing).
 */
export type Choose = (req: ConfirmRequest & { dispute: DisputeInfo }) => Promise<string | null>;

/** One queue for every question to the human, whatever its shape (review P2-F7). */
export type AskQueue = <T>(ask: () => Promise<T>) => Promise<T>;

export function askQueue(): AskQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(ask: () => Promise<T>): Promise<T> => {
    const next = tail.then(ask);
    tail = next.catch(() => undefined);
    return next;
  };
}

/**
 * A host's chooser on the shared queue; without one every dispute is rejected. Only an id
 * among the options counts; anything else is a rejection.
 */
export function hostChoose(
  choose: Choose | undefined,
  voided: (req: ConfirmRequest) => boolean,
  queue: AskQueue,
): Choose {
  if (!choose) return () => Promise.resolve(null);
  return async (req) => {
    const pick = await queue(() => (voided(req) ? Promise.resolve(null) : choose(req))).catch(
      () => null,
    );
    return typeof pick === 'string' && req.dispute.options.some((o) => o.id === pick) ? pick : null;
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

/**
 * A host's confirm, serialized; without one every confirmation is declined. A question
 * `voided` says is void when its turn comes (its run was cancelled while it waited in the
 * queue) is declined without being asked (review P3-F2).
 */
export function hostConfirm(
  confirm: Confirm | undefined,
  voided: (req: ConfirmRequest) => boolean = () => false,
  queue: AskQueue = askQueue(),
  answered?: (req: ConfirmRequest, a: AskTimes) => void,
): Confirm {
  if (!confirm) return () => Promise.resolve(false);
  const ask = async (req: ConfirmRequest): Promise<boolean> => {
    const askedAt = new Date();
    // A host that throws is not an answer: the error goes on, unrecorded, as before.
    const yes = (await confirm(req)) === true;
    try {
      answered?.(req, { askedAt, answeredAt: new Date(), yes });
    } catch {
      // Recording an answer never changes it.
    }
    return yes;
  };
  return async (req) =>
    (await queue(() => (voided(req) ? Promise.resolve(false) : ask(req)))) === true;
}

/** When a question reached the human and when they answered it (S10 R6 J2). */
export interface AskTimes {
  askedAt: Date;
  answeredAt: Date;
  yes: boolean;
}
