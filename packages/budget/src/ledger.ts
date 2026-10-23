import type { BudgetScope, SpendContext, SpendLedger } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';

/** First instant of `now`'s calendar month, in UTC. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Spend read from the journal's `cost_usd` column. Session = this session;
 * project = sessions whose cwd is `ctx.project`; month = every project since
 * the first of `ctx.now`'s calendar month (UTC).
 */
export class JournalLedger implements SpendLedger {
  constructor(private readonly journal: Pick<Journal, 'spend'>) {}

  spent(scope: Exclude<BudgetScope, 'task'>, ctx: SpendContext): number {
    switch (scope) {
      case 'session':
        return this.journal.spend({ sessionId: ctx.sessionId });
      case 'project':
        return this.journal.spend({ project: ctx.project });
      case 'month':
        return this.journal.spend({ since: startOfMonthUtc(ctx.now) });
    }
  }
}
