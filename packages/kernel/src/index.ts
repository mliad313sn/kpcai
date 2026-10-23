export * from './protocol.js';
export { Kernel } from './kernel.js';
export { KernelError, type KernelErrorCode } from './errors.js';
export {
  hostConfirm,
  serialized,
  type Confirm,
  type ConfirmKind,
  type ConfirmRequest,
} from './confirm.js';
export {
  DEFAULT_CONFIRM_ABOVE_USD,
  budgetLimits,
  buildRegistry,
  confirmThreshold,
  formatMoney,
  journalPath,
  kpaiHome,
  money,
  openJournal,
  routingProfile,
  type Env,
  type Money,
} from './env.js';
export { BudgetGate, type GateContext, type GateFlags, type GateHost } from './budget-gate.js';
export { collect, extractPatches, hasHiddenBytes, patchFiles, type Patch } from './patches.js';
export { workspaceProblem } from './workspace.js';
export { graphSetup, plannerFor, type GraphOptions, type GraphSetup } from './setup.js';
export type { ProviderInfo, ToolInfo } from './queries.js';
export type { ExplainedEstimate, KernelEvent, RoutingExplained } from './routing-info.js';
export type {
  ApplyResult,
  KernelHost,
  Plan,
  RunHandle,
  RunOutcome,
  RunState,
  StartRunInput,
} from './types.js';
