/** Budget scopes of spec §3.4. Amounts are USD (ADR-0005). */
export type BudgetScope = 'task' | 'session' | 'project' | 'month';

export interface BudgetLimits {
  task?: number;
  session?: number;
  project?: number;
  month?: number;
  /** Ask for confirmation when a task's expected cost is above this. */
  confirmAboveUsd: number;
}

export interface SpendContext {
  sessionId: string;
  /** Project key; the working directory in phases 0-2. */
  project: string;
  now: Date;
}

/** Already-spent amounts, read from the journal. */
export interface SpendLedger {
  spent(scope: Exclude<BudgetScope, 'task'>, ctx: SpendContext): number;
}

export type BudgetOption = 'reduce_scope' | 'cheaper_models' | 'continue';

export type BudgetVerdict =
  | { action: 'allow'; estimateUsd: number }
  | { action: 'confirm'; estimateUsd: number; reason: string }
  | {
      action: 'block';
      estimateUsd: number;
      scope: BudgetScope;
      limitUsd: number;
      projectedUsd: number;
      reason: string;
      options: BudgetOption[];
    };

export interface BudgetGovernor {
  check(estimateUsd: number, ctx: SpendContext): BudgetVerdict;
}
