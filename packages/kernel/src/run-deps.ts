/**
 * The orchestrator options of a run, a replay or a fork: one place for the safety wiring
 * (budget gate at every spend point, the run's tool bus and jail, local-only memory, tool
 * confirmations, disputes asked of the human and failing closed).
 */
import { refToString } from '@kernelpai/core';
import { outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import type {
  DisputeHook,
  DisputeQuestion,
  OrchestratorOptions,
  RunControlEvent,
} from '@kernelpai/orchestrator';
import { createToolBus } from '@kernelpai/tools';
import { BudgetGate, type GateHost } from './budget-gate.js';
import type { Choose, DisputeInfo } from './confirm.js';
import { kpaiHome } from './env.js';
import { homeZones } from './home-zone.js';
import { NO_MEMORY, localTaint, memoryJournal, memoryResolver, taintConstraint } from './memory.js';
import { busPacks } from './packs.js';
import { RouterTap, UsageTap } from './routing-info.js';
import type { GraphOptions } from './setup.js';
import type { Plan } from './types.js';

export interface DepsInput {
  journal: Journal;
  gateHost: GateHost;
  choose: Choose;
  /** What the wiring reads of a plan (a replay builds just this). */
  plan: Pick<Plan, 'sessionId' | 'graph' | 'setup' | 'm' | 'packs' | 'memory'> & {
    estimate: { capUsd: number };
  };
  flags: GraphOptions;
  runId: string;
  /** The jail: the run's worktree when isolated, else the workspace. */
  root: string;
  /** The session spends and records are journaled in (default the plan's). */
  sessionId?: string;
  onControl?: (e: RunControlEvent) => void;
}

export interface RunDeps {
  options: OrchestratorOptions;
  router: RouterTap;
  usage: UsageTap;
  close(): Promise<void>;
}

export const MAX_OPTION_CHARS = 20_000;
const MAX_LABEL_CHARS = 200;
export const TRUNCATED_NOTE = ' [too long to show in full: cannot be chosen]';

/** An option as offered to the human; `truncated` ones are shown cut and never accepted. */
export type OfferedOption = DisputeInfo['options'][number] & { truncated?: true };

/**
 * A dispute as the confirm channel carries it; model text is capped, never interpreted.
 * An option longer than the cap is shown cut, marked `truncated` and labelled so in any
 * client: what the human sees must be what is chosen (P4-F11), so it cannot be picked.
 */
export function disputeInfo(q: DisputeQuestion): Omit<DisputeInfo, 'options'> & {
  options: OfferedOption[];
} {
  return {
    nodeId: q.nodeId,
    kind: q.kind,
    reason: q.reason,
    options: q.options.map((o): OfferedOption => {
      const cut = o.text.length > MAX_OPTION_CHARS;
      const label = cut
        ? `${o.label.slice(0, MAX_LABEL_CHARS - TRUNCATED_NOTE.length)}${TRUNCATED_NOTE}`
        : o.label;
      return {
        id: o.id,
        label,
        text: o.text.slice(0, MAX_OPTION_CHARS),
        backers: o.backers.map(refToString),
        ...(cut ? { truncated: true as const } : {}),
      };
    }),
    positions: q.positions.map((p) => ({
      ref: refToString(p.ref),
      role: p.role,
      says: p.says,
      ...(p.option ? { option: p.option } : {}),
    })),
  };
}

/**
 * R-405: the human picks an option or rejects; silence, an error or no human rejects. The
 * choice must be an option offered in full: an unknown id or a `truncated` option is
 * refused here, whatever the client sent, and the node fails closed.
 */
export function disputeHook(choose: Choose): DisputeHook {
  return async (q) => {
    const question = `Node ${q.nodeId} is disputed (${q.reason}). Pick one answer or reject them all.`;
    const dispute = disputeInfo(q);
    try {
      const choice = await choose({
        kind: 'dispute',
        question,
        runId: q.runId,
        risk: 'write',
        dispute,
      });
      if (choice === null) return null;
      const offered = dispute.options.find((o) => o.id === choice);
      return offered && !offered.truncated ? choice : null;
    } catch {
      return null;
    }
  };
}

export async function runDeps(i: DepsInput): Promise<RunDeps> {
  const { plan: p, gateHost: host } = i;
  const sessionId = i.sessionId ?? p.sessionId;
  // Local-only memory (ADR-0027 §6, P4-F3): local providers get the facts; a node that saw
  // them, and its dependents, stay on local providers; every quote of one is withheld from
  // non-local providers and from the journal.
  const memory = p.memory ?? NO_MEMORY;
  const taint = localTaint(memory, p.graph.nodes);
  const isLocal = (provider: string): boolean => {
    try {
      return p.setup.registry.get(provider).descriptor.kind === 'local';
    } catch {
      return false;
    }
  };
  const journal = memoryJournal(i.journal, memory, taint, isLocal);
  const { bus, mcpErrors, policyError } = await createToolBus({
    kpaiHome: kpaiHome(host.env),
    // $KPAI_HOME/memory/** when the home is inside the workspace (ADR-0030).
    policyOptions: { forbiddenPaths: homeZones(host.env, host.cwd) },
    // Tool calls and results are journaled with local-only quotes withheld too.
    journal,
    env: host.env,
    // The run's domain packs: additions always, approved relaxations journaled (D-020).
    packs: busPacks(p.packs, sessionId),
  });
  for (const e of mcpErrors) host.say(`  – mcp ${e.server}: ${e.message}\n`);
  if (policyError) host.say(`  – policy.json ignored (defaults apply): ${policyError}\n`);
  const ctx = { sessionId, nodeId: p.graph.id, m: p.m, runId: i.runId };
  const gate = new BudgetGate(host, i.journal, ctx, i.flags);
  const router = new RouterTap(p.setup.router);
  const usage = new UsageTap();
  const options: OrchestratorOptions = {
    // The user accepted this cap (the band's top, D-021); going beyond it asks again (P2-F9).
    maxGraphUsd: p.estimate.capUsd,
    router,
    candidates: p.setup.candidates,
    constraints: p.setup.constraints,
    // Local providers also get the local-only memory facts (ADR-0027).
    resolve: memoryResolver((ref) => p.setup.registry.get(ref.provider), memory),
    nodeConstraints: taintConstraint(taint),
    // Per-call estimates use the same calibrated output sizes as routing (S8 finding).
    executor: { expectedOutput: outputCalibration(i.journal) },
    journal: usage.wrap(journal),
    sessionId,
    budget: (cand, label) => gate.allow(cand, label),
    tools: bus,
    confirm: (question) => host.confirm({ kind: 'tool', question, runId: i.runId }),
    root: i.root,
    allowSameProvider: i.flags.allowSameProvider === true,
    // R-404 (ADR-0030): the runner sets each node's protocol, journaled per change.
    ...(p.setup.reviewPolicy ? { reviewPolicy: p.setup.reviewPolicy } : {}),
    dispute: disputeHook(i.choose),
    ...(i.onControl ? { onControl: i.onControl } : {}),
  };
  return { options, router, usage, close: () => bus.close() };
}
