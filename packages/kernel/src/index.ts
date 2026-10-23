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
export {
  workspaceProblem,
  workspaceVerdict,
  saveOptIns,
  type WorkspaceVerdict,
} from './workspace.js';
export {
  selectPacks,
  packSummary,
  busPacks,
  saveZoneDecisions,
  type PackChoice,
  type PackContext,
  type SelectedPacks,
} from './packs.js';
export { checkScope, readScopeFile, scopeSummary, SCOPE_FILE, type ScopeCheck } from './scope.js';
export {
  ARTIFACT_KINDS,
  ARTIFACT_MAX_BYTES,
  artifactProblem,
  collectArtifacts,
  type Artifact,
  type ArtifactKind,
  type ArtifactProvenance,
  type NodeArtifact,
  type RefusedArtifact,
} from './artifacts.js';
export { summarizeRules, withNodeContext, type LoadedRules, type RulesSummary } from './rules.js';
export {
  WT_SUFFIX,
  WorkspaceOps,
  isGitTree,
  type CheckpointInfo,
  type DiffStats,
} from './workspace-ops.js';
export { graphSetup, plannerFor, type GraphOptions, type GraphSetup } from './setup.js';
export type { ProviderInfo, ToolInfo } from './queries.js';
export type {
  ExplainedEstimate,
  ExplainedStep,
  KernelEvent,
  RoutingExplained,
} from './routing-info.js';
export type { KernelPlanCheck } from './planning.js';
export type {
  ApplyResult,
  ArtifactApplyResult,
  RunSummary,
  KernelHost,
  Plan,
  RunHandle,
  RunOutcome,
  RunState,
  StartRunInput,
} from './types.js';
