/**
 * @kernelpai/enterprise — the Enterprise runtime (ADR-0031, ADR-0035): the durable program
 * store under $KPAI_HOME, the kernel wiring (`RunStarter`, envelope pre-answers), the
 * headless daemon with its queue and worker pool, and the S10 safeguards (heartbeat,
 * watchdog, dead-man file, spend-rate cap, progress-gated burn, expiry, assurance labels,
 * risk-proportional approvals).
 */
export { EnterpriseRuntime, type RuntimeOptions } from './runtime.js';
export { EnterpriseStore, type ProgramRecord } from './store.js';
export { DEFAULT_CONFIG, configFrom, type EnterpriseConfig } from './config.js';
export { HEARTBEAT_FILE, readHeartbeat, type Heartbeat } from './liveness.js';
export { PRE_ANSWER_RULES } from './confirm-gate.js';
export { programContext, KernelRunStarter } from './starter.js';
export type { Activity, Emit } from './feed.js';
export type { DraftInput, Drafted } from './draft.js';
export type { ProgramMeta, Ref } from './meta.js';
