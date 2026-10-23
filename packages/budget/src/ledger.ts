import type { BudgetScope, SpendContext, SpendLedger } from '@kernelpai/core';
import type { Journal } from '@kernelpai/journal';

/** First instant of `now`'s calendar month, in UTC. */
export function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First instant of the calendar month after `now`'s, in UTC. */
export function startOfNextMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/**
 * Spend read from the journal's `cost_usd` column. Session = this session;
 * project = sessions whose cwd is `ctx.project`; month = every project within
 * `ctx.now`'s calendar month (UTC): [start of month, start of next month).
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
        return this.journal.spend({
          since: startOfMonthUtc(ctx.now),
          until: startOfNextMonthUtc(ctx.now),
        });
    }
  }
}
