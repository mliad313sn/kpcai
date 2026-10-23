import type { ScoredCandidate } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';

const usd = (n: number): string => `$${Number(n.toPrecision(3))}`;

/**
 * Cumulative spend cap of one graph run (`maxGraphUsd`, review P2-F9, principle 6).
 *
 * Before each step, fallback and tool round, the projected total (spent + in flight +
 * this call's expected cost) is compared with the cap. Above it, the budget hook is asked
 * once with a label starting `graph total`: yes lets the run continue past the cap
 * (journaled override), no (or no hook) stops every further step of the graph (journaled).
 */
export class GraphBudget {
  private spent = 0;
  private reserved = 0;
  private approved = false;
  private blocked = false;
  private asking: Promise<boolean> | undefined;

  constructor(
    private readonly cap: number | undefined,
    private readonly ask: ((c: ScoredCandidate, label: string) => Promise<boolean>) | undefined,
    private readonly journal: Journal,
    private readonly sessionId: string,
  ) {}

  reset(): void {
    this.spent = 0;
    this.reserved = 0;
    this.approved = false;
    this.blocked = false;
    this.asking = undefined;
  }

  get spentUsd(): number {
    return this.spent;
  }

  add(costUsd: number): void {
    this.spent += costUsd;
  }

  reserve(costUsd: number): () => void {
    this.reserved += costUsd;
    let done = false;
    return () => {
      if (!done) this.reserved -= costUsd;
      done = true;
    };
  }

  /** False when this call must not run because of the graph cap. */
  async check(c: ScoredCandidate, label: string, nodeId?: string): Promise<boolean> {
    if (this.cap === undefined || this.approved) return true;
    const projected = this.spent + this.reserved + c.estimate.expectedCostUsd;
    if (projected <= this.cap) return true;
    if (this.blocked) return false;
    // Parallel steps share one question: the first asks, the others wait for its answer.
    if (this.asking) return this.asking;
    this.asking = this.decide(c, label, projected, nodeId);
    try {
      return await this.asking;
    } finally {
      this.asking = undefined;
    }
  }

  private async decide(
    c: ScoredCandidate,
    label: string,
    projected: number,
    nodeId: string | undefined,
  ): Promise<boolean> {
    const cap = this.cap as number;
    const question = `graph total: ${usd(projected)} would exceed maxGraphUsd ${usd(cap)} (${label})`;
    let ok: boolean;
    try {
      ok = this.ask !== undefined && (await this.ask(c, question)) !== false;
    } catch {
      ok = false;
    }
    if (ok) this.approved = true;
    else this.blocked = true;
    this.journal.append({
      sessionId: this.sessionId,
      type: 'intervention',
      ...(nodeId ? { nodeId } : {}),
      payload: {
        action: ok ? 'graph total override' : 'graph total reached',
        label: question,
        spentUsd: this.spent,
        projectedUsd: projected,
        maxGraphUsd: cap,
      },
    });
    return ok;
  }
}
