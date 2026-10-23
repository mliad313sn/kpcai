import type { ScoredCandidate } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';
import type { NodeRun } from './types.js';

const usd = (n: number): string => `$${Number(n.toPrecision(3))}`;
const r6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** An in-flight step's claim on its node's budget, shrinking as the step spends. */
export interface NodeHold {
  /** Records spend of the step (tool round or fallback attempt done). */
  spend(costUsd: number): void;
  /** Claims `topUsd` for the step's next call (a tool round). */
  claim(topUsd: number): void;
  release(): void;
  readonly remainingUsd: number;
}

interface NodeState {
  holds: Set<NodeHold>;
  approved: boolean;
  blocked: boolean;
  asking: Promise<boolean> | undefined;
}

/**
 * Per-node spend cap (`GraphNode.budgetUsd`, review P3-F5), enforced like `maxGraphUsd`.
 *
 * Before each step, fallback and tool round of a node with a budget, the node's spend so
 * far (earlier attempts included) plus the claims of its other in-flight steps plus this
 * call's band top is compared with `budgetUsd`. Above it, the budget hook is asked once
 * per node with a label starting `node <id> total`: yes lets the node go past its budget
 * (journaled override), no (or no hook) fails every further step of the node (journaled).
 */
export class NodeBudgets {
  private readonly nodes = new Map<string, NodeState>();

  constructor(
    private readonly ask: ((c: ScoredCandidate, label: string) => Promise<boolean>) | undefined,
    private readonly journal: Journal,
    private readonly sessionId: string,
  ) {}

  reset(): void {
    this.nodes.clear();
  }

  /** Claims `topUsd` of the node's budget for a step about to run. */
  hold(nodeId: string, topUsd: number): NodeHold {
    const st = this.state(nodeId);
    let left = Math.max(0, topUsd);
    const h: NodeHold = {
      spend: (cost) => {
        left = Math.max(0, left - cost);
      },
      claim: (top) => {
        left = Math.max(0, top);
      },
      release: () => {
        st.holds.delete(h);
      },
      get remainingUsd() {
        return left;
      },
    };
    st.holds.add(h);
    return h;
  }

  /**
   * Why this call must not run because of the node's budget; undefined when it may.
   * `own` is the calling step's hold (not counted twice).
   */
  async check(
    run: NodeRun,
    c: ScoredCandidate,
    topUsd: number,
    label: string,
    own?: NodeHold,
  ): Promise<string | undefined> {
    const cap = run.node.budgetUsd;
    const id = run.node.id;
    if (cap === undefined) return undefined;
    const st = this.state(id);
    if (st.approved) return undefined;
    const spent = r6((run.priorUsd ?? 0) + run.costUsd);
    let held = 0;
    for (const h of st.holds) if (h !== own) held += h.remainingUsd;
    const projected = r6(spent + held + topUsd);
    if (projected <= cap) return undefined;
    const question = `node ${id} total: up to ${usd(projected)} would exceed budgetUsd ${usd(cap)} (${label})`;
    const refusal = `node budget: ${question}`;
    if (st.blocked) return refusal;
    // Parallel steps of one node (debate) share one question.
    st.asking ??= this.decide(st, c, question, { id, cap, spent, projected });
    const ok = await st.asking;
    st.asking = undefined;
    return ok ? undefined : refusal;
  }

  private async decide(
    st: NodeState,
    c: ScoredCandidate,
    question: string,
    f: { id: string; cap: number; spent: number; projected: number },
  ): Promise<boolean> {
    let ok: boolean;
    try {
      ok = this.ask !== undefined && (await this.ask(c, question)) !== false;
    } catch {
      ok = false;
    }
    if (ok) st.approved = true;
    else st.blocked = true;
    this.journal.append({
      sessionId: this.sessionId,
      type: 'intervention',
      nodeId: f.id,
      payload: {
        action: ok ? 'node budget override' : 'node budget reached',
        label: question,
        spentUsd: f.spent,
        projectedUsd: f.projected,
        budgetUsd: f.cap,
      },
    });
    return ok;
  }

  private state(id: string): NodeState {
    let st = this.nodes.get(id);
    if (!st) {
      st = { holds: new Set(), approved: false, blocked: false, asking: undefined };
      this.nodes.set(id, st);
    }
    return st;
  }
}
