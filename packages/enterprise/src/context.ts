/** What every part of the runtime shares: the store, the kernel, the feed, the clock. */
import type { GraphOptions, Kernel } from '@kernelpai/kernel';
import type { ConfirmGate } from './confirm-gate.js';
import type { Feed } from './feed.js';
import type { RunStarter } from '@kernelpai/program';
import type { EnterpriseStore } from './store.js';

/** A run this process started and watches until it settles. */
export interface LiveRun {
  programId: string;
  wpId: string;
  sessionId: string;
  jobId?: string;
  startedAt: string;
  /** Resolves once the machine recorded (or refused) the start: settle waits for it. */
  ready: Promise<void>;
  markReady: () => void;
}

/** The kernel seen from the daemon: a `RunStarter` whose cached plans can be dropped. */
export interface ProgramStarter extends RunStarter {
  forgetWp(programId: string, wpId: string): void;
}

export interface Ctx {
  store: EnterpriseStore;
  kernel: Kernel;
  feed: Feed;
  starter: ProgramStarter;
  gate: ConfirmGate;
  clock: () => Date;
  options: GraphOptions;
  /** Runs started by this process, by run id. */
  live: Map<string, LiveRun>;
  /** Last kernel activity per live run (the watchdog's stalled-worker signal). */
  activity: Map<string, string>;
  /** Jobs being delegated right now (never dispatched twice). */
  inflight: Set<string>;
  /** Settlements in flight (awaited on close). */
  settling: Set<Promise<unknown>>;
  /** Journals a typed fact, in the program's session (or the daemon's). */
  fact(programId: string | undefined, payload: Record<string, unknown>): void;
  sessionOf(programId: string | undefined): string;
}

export function sessionCache(kernel: Kernel): (programId: string | undefined) => string {
  const sessions = new Map<string, string>();
  return (programId) => {
    const key = programId ?? '';
    let id = sessions.get(key);
    if (!id) {
      id = kernel.openSession(programId ? `program ${programId}` : 'enterprise daemon', false);
      sessions.set(key, id);
    }
    return id;
  };
}

/** Cancels a kernel run; false when the kernel does not know it (another process's run). */
export function cancelRun(c: Pick<Ctx, 'kernel'>, runId: string): boolean {
  try {
    return c.kernel.cancel(runId);
  } catch {
    return false;
  }
}
