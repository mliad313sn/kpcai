import {
  formatUsd,
  type BudgetGovernor,
  type BudgetLimits,
  type BudgetOption,
  type BudgetScope,
  type BudgetVerdict,
  type SpendContext,
  type SpendLedger,
} from '@kernelpai/core';

/** What a blocked user may choose (spec §3.4). */
export const BLOCK_OPTIONS: readonly BudgetOption[] = [
  'reduce_scope',
  'cheaper_models',
  'continue',
];

/** Scopes checked in order, narrowest first; the first one exceeded blocks. */
export const SCOPE_ORDER: readonly BudgetScope[] = ['task', 'session', 'project', 'month'];

/**
 * Multi-level budget governor (spec §3.4, ADR-0005). Projected spend = already
 * spent in the scope + this task's estimate; strictly above the limit blocks.
 * Otherwise an estimate strictly above `confirmAboveUsd` asks for confirmation.
 */
export class Governor implements BudgetGovernor {
  constructor(
    private readonly limits: BudgetLimits,
    private readonly ledger: SpendLedger,
  ) {}

  check(estimateUsd: number, ctx: SpendContext): BudgetVerdict {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
      throw new RangeError(`Budget estimate must be a finite amount >= 0, got ${estimateUsd}`);
    }
    for (const scope of SCOPE_ORDER) {
      const limitUsd = this.limits[scope];
      if (limitUsd === undefined) continue;
      const spent = scope === 'task' ? 0 : this.ledger.spent(scope, ctx);
      const projectedUsd = spent + estimateUsd;
      if (projectedUsd > limitUsd) {
        return {
          action: 'block',
          estimateUsd,
          scope,
          limitUsd,
          projectedUsd,
          reason: blockReason(scope, spent, estimateUsd, limitUsd),
          options: [...BLOCK_OPTIONS],
        };
      }
    }
    if (estimateUsd > this.limits.confirmAboveUsd) {
      return {
        action: 'confirm',
        estimateUsd,
        reason: `estimated ${formatUsd(estimateUsd)} is above the ${formatUsd(this.limits.confirmAboveUsd)} confirmation threshold`,
      };
    }
    return { action: 'allow', estimateUsd };
  }
}

function blockReason(scope: BudgetScope, spent: number, estimate: number, limit: number): string {
  if (scope === 'task') {
    return `task estimate ${formatUsd(estimate)} exceeds the ${formatUsd(limit)} task budget`;
  }
  return `${scope} budget ${formatUsd(limit)} would be exceeded: ${formatUsd(spent)} spent + ${formatUsd(estimate)} estimated`;
}
