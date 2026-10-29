export {
  LocalToolBus,
  type LocalToolBusOptions,
  type ToolDecision,
  type ToolJournal,
} from './bus.js';
export { createToolBus, type CreateToolBusOptions, type CreatedToolBus } from './create.js';
export { builtinTools, type BuiltinOptions } from './builtins/index.js';
export { fsTools, FS_READ_MAX_BYTES } from './builtins/fs.js';
export { gitTools, type GitToolOptions, type GitApplyRules } from './builtins/git.js';
export { inspectPatch, type InspectedPatch } from './builtins/git-apply.js';
export {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_FILES,
  hashFiles,
  joinImages,
  type FileImage,
  type FileImages,
} from './builtins/images.js';
export {
  assertPrintable,
  parsePatch,
  checkSections,
  parseNumstat,
  summaryModes,
  type PatchRules,
  type PatchSection,
} from './builtins/patch.js';
export {
  shellTool,
  isAllowlisted,
  DEFAULT_SHELL_ALLOWLIST,
  SHELL_DEFAULT_TIMEOUT_MS,
  SHELL_MAX_TIMEOUT_MS,
  SHELL_MAX_OUTPUT_BYTES,
  type ShellToolOptions,
} from './builtins/shell.js';
export {
  GradedPermissionPolicy,
  DEFAULT_FORBIDDEN_PATHS,
  isConfirmAware,
  pathsInCall,
  diffPaths,
  type ConfirmAwarePolicy,
  type GradedPolicyOptions,
  type ActivePolicy,
} from './policy.js';
export {
  CREDENTIAL_ZONES,
  HEURISTIC_ZONES,
  DEFAULT_ZONES,
  ENV_TEMPLATES,
  inForbiddenZone,
  zoneHit,
  zoneSetFromGlobs,
  zoneGlobs,
  tierOf,
  type ZoneSet,
  type ZoneEntry,
  type ZoneTier,
  type ZoneOrigin,
  type ZoneRelaxation,
  type KeyProbe,
} from './zones.js';
export {
  buildZoneSet,
  relaxationProblem,
  CREDENTIAL_SAMPLES,
  EMPTY_PACK_ZONES,
  type PackZonePlan,
  type ZoneSetInput,
} from './zone-set.js';
export {
  planPackZones,
  journalPackZones,
  describePackZones,
  relaxKey,
  type PackZoneOptions,
} from './pack-zones.js';
export { keynoteProbe, KEYNOTE_SNIFF_BYTES } from './keynote.js';
export {
  loadPolicyConfig,
  buildPolicy,
  PolicyConfigSchema,
  type PolicyConfig,
  type LoadedPolicy,
} from './policy-config.js';
export {
  detectSandbox,
  type SandboxMode,
  type ShellSandbox,
  type SandboxedCommand,
} from './sandbox.js';
export {
  connectMcpServer,
  connectMcpServers,
  openMcpServer,
  exposeTools,
  loadMcpConfig,
  riskFromAnnotations,
  mcpToolName,
  resultText,
  McpConfigSchema,
  MCP_CONNECT_TIMEOUT_MS,
  MCP_CALL_TIMEOUT_MS,
  type McpConfig,
  type McpServerConfig,
  type McpConnection,
  type McpConnectResult,
  type McpGuard,
  type OpenedMcpServer,
  type OpenMcpOptions,
} from './mcp.js';
export {
  JailError,
  resolveInRoot,
  isInside,
  checkLexical,
  matchesForbidden,
  globToRegExp,
  touchesGitDir,
  type JailedPath,
  type JailOptions,
} from './paths.js';
export { scrubEnv, isSecretName, redact, secretValues } from './env.js';
export { validateInput } from './schema.js';
export { runProcess, type RunSpec, type RunResult } from './process.js';
export { truncateBytes, stripControls, previewLines, DEFAULT_MAX_RESULT_BYTES } from './text.js';
export { ToolError, type LocalTool, type ToolOutcome, type PreparedCall } from './types.js';
export {
  checkpoint,
  listCheckpoints,
  resolveCheckpoint,
  restore,
  CHECKPOINT_NS,
  type Checkpoint,
  type CheckpointOptions,
  type RestoreResult,
} from './workspace/checkpoint.js';
export {
  createRunWorktree,
  locateRunWorktree,
  diffRunWorktree,
  mergeBack,
  removeRunWorktree,
  RUN_NS,
  type RunWorktree,
  type RunDiff,
  type MergeResult,
} from './workspace/worktree.js';
export {
  readRepoRules,
  formatRepoRules,
  RULES_MAX_FILE_BYTES,
  RULES_MAX_TOTAL_BYTES,
  type RepoRule,
  type RepoRules,
  type RuleKind,
  type RulesOptions,
} from './workspace/rules.js';
export { authorize, RESTORE_DEF, MERGE_DEF, type Gate } from './workspace/gate.js';
export type { WorkspaceOptions } from './workspace/common.js';
export type { WriteResult } from './workspace/writer.js';
export {
  TEST_RUN_TOOL,
  MAX_FAILING,
  formatEvidence,
  readTestEvidence,
  testsFailed,
  evidenceSummary,
  type TestEvidence,
  type TestStatus,
  type TestCounts,
} from './test-evidence.js';
export {
  testRunTool,
  TEST_RUN_DEFAULT_TIMEOUT_MS,
  TEST_RUN_MAX_TIMEOUT_MS,
  TEST_RUN_MAX_OUTPUT_BYTES,
  TEST_RUN_TAIL_CHARS,
  type TestRunToolOptions,
} from './builtins/test-run.js';
export {
  resolveTestCommand,
  withSelection,
  REPO_TEST_CONFIG,
  TestCommandConfigSchema,
  type TestCommand,
  type TestCommandConfig,
  type RunnerKind,
} from './builtins/test-detect.js';
export { evidenceOf, parseOutput, type ParserName, type RunFacts } from './builtins/test-parse.js';
export { testConfigTamper, tamperNote, type TamperCheck } from './builtins/test-tamper.js';
export { isControlPath, isTestConfigPath, patchPaths, writesControl } from './control-files.js';
export {
  MCP_PINS_FILE,
  canonicalJson,
  checkPin,
  diffTools,
  loadPins,
  makePin,
  savePins,
  snapshotTools,
  toolsHash,
  type McpPin,
  type McpPins,
  type PinCheck,
  type ToolSnapshot,
} from './mcp-pin.js';
export {
  connectPinnedServer,
  connectPinnedServers,
  openBehindProxy,
  type PinnedConnectResult,
  type PinnedConnection,
  type PinnedMcpOptions,
} from './mcp-registry.js';
export {
  approveMcpServer,
  mcpStatus,
  removeMcpServer,
  type ApproveOptions,
  type ApproveResult,
  type McpServerStatus,
} from './mcp-admin.js';
export {
  startEgressProxy,
  egressAllowed,
  type EgressProxy,
  type EgressDenial,
} from './egress-proxy.js';
