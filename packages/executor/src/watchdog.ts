/** Per-attempt stall detection: first-chunk and idle timeouts. */
export interface StallTimeouts {
  /** Max wait for the first stream event after `start`. 0 disables. */
  firstChunkMs: number;
  /** Max gap between two stream events once output has begun. 0 disables. */
  idleMs: number;
}

/**
 * An AbortController for one attempt, composed with the caller's signal.
 * A stall aborts this attempt only and records which timeout fired (`stalledAfterMs`);
 * an outer abort (user cancel) propagates and leaves `stalledAfterMs` undefined.
 */
export class Watchdog {
  readonly controller = new AbortController();
  stalledAfterMs: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly timeouts: StallTimeouts;
  private readonly outer: AbortSignal | undefined;
  private readonly onOuterAbort = (): void => this.controller.abort();

  constructor(timeouts: StallTimeouts, outer: AbortSignal | undefined) {
    this.timeouts = timeouts;
    this.outer = outer;
    if (outer?.aborted) this.controller.abort();
    else outer?.addEventListener('abort', this.onOuterAbort, { once: true });
    this.arm(timeouts.firstChunkMs);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Call on every stream event after `start`: switches to (and resets) the idle timeout. */
  activity(): void {
    this.arm(this.timeouts.idleMs);
  }

  /** True when this attempt was aborted by a stall rather than by the caller. */
  get stalled(): boolean {
    return this.stalledAfterMs !== undefined && this.outer?.aborted !== true;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.outer?.removeEventListener('abort', this.onOuterAbort);
  }

  private arm(ms: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (!(ms > 0) || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.stalledAfterMs = ms;
      this.controller.abort();
    }, ms);
  }
}
