/**
 * The run budget of subscription agents (R-503, R-5E7): counted in runs and minutes, not
 * dollars (a subscription has no per-call price). Each agent run claims one run and a slice
 * of the minutes left, which becomes its time cap; unused time comes back when it ends.
 */
export interface AgentBudgetLimits {
  /** Agent runs allowed in one graph run (authors and revisions each count). */
  maxRuns: number;
  /** Wall-clock minutes of agent work allowed in one graph run. */
  maxMinutes: number;
}

export type AgentClaim =
  | { ok: true; timeoutMs: number; run: number; release: (usedMs: number) => void }
  | { ok: false; reason: string };

/** Smallest slice worth starting an agent for. */
const MIN_SLICE_MS = 1_000;

export class AgentBudget {
  private runs = 0;
  private usedMs = 0;
  private reservedMs = 0;

  constructor(private readonly limits: AgentBudgetLimits) {}

  reset(): void {
    this.runs = 0;
    this.usedMs = 0;
    this.reservedMs = 0;
  }

  /** Runs and minutes used so far (for the journal and reports). */
  used(): { runs: number; minutes: number } {
    return { runs: this.runs, minutes: Math.round((this.usedMs / 60_000) * 100) / 100 };
  }

  /** One more run, capped at `wantedMs` and at the minutes left. */
  claim(wantedMs: number): AgentClaim {
    const { maxRuns, maxMinutes } = this.limits;
    if (this.runs >= maxRuns) return { ok: false, reason: `agent run cap (${maxRuns}) reached` };
    const left = maxMinutes * 60_000 - this.usedMs - this.reservedMs;
    if (left < MIN_SLICE_MS) {
      return { ok: false, reason: `agent minutes cap (${maxMinutes} min) reached` };
    }
    const slice = Math.min(wantedMs, left);
    this.runs++;
    this.reservedMs += slice;
    let open = true;
    return {
      ok: true,
      timeoutMs: slice,
      run: this.runs,
      release: (usedMs) => {
        if (!open) return;
        open = false;
        this.reservedMs -= slice;
        this.usedMs += Math.min(Math.max(0, usedMs), slice);
      },
    };
  }
}
