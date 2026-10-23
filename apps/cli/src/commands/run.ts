import { randomUUID } from 'node:crypto';
import {
  ProviderError,
  refToString,
  type Classification,
  type Criticality,
  type ModelRef,
  type RoutingConstraints,
  type RoutingDecision,
  type TaskNode,
  type TaskType,
} from '@kernelpai/core';
import { classify, outputCalibration } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import { CompetenceRouter } from '@kernelpai/router';
import { budgetLimits, money, routingProfile, type Money } from '../config.js';
import { candidates as scanCandidates } from '@kernelpai/providers';
import { buildRegistry, openJournal } from '../context.js';
import type { Io } from '../io.js';
import { renderPlan, renderRejections } from '../render.js';
import { BudgetGate, execute } from './run-exec.js';

export interface RunOptions {
  prompt: string;
  type?: TaskType;
  criticality?: Criticality;
  profile?: string;
  maxTokens?: number;
  localOnly?: boolean;
  exclude?: string[];
  allowTest?: boolean;
  yes?: boolean;
  overBudget?: boolean;
  newSession?: boolean;
  verbose?: boolean;
  db?: string;
}

export interface Planned {
  node: TaskNode;
  cls: Classification;
  decision: RoutingDecision;
  m: Money;
}

/** classify → plan → route. Shared by `kpai route` (dry run) and `kpai run`. */
export async function plan(io: Io, o: RunOptions): Promise<Planned> {
  const m = money(io.env);
  const limits = budgetLimits(io.env);
  const cls: Classification = o.type
    ? { type: o.type, confidence: 1, reason: 'set with --type' }
    : classify(o.prompt);
  const node: TaskNode = {
    // Unique per run: sessions span runs (F5) and metrics key tasks by session + node.
    id: `n-${randomUUID().slice(0, 8)}`,
    type: cls.type,
    messages: [{ role: 'user', content: o.prompt }],
    criticality: o.criticality ?? 'normal',
    ...(limits.task !== undefined ? { budgetUsd: limits.task } : {}),
    ...(o.maxTokens ? { maxOutputTokens: o.maxTokens } : {}),
  };
  const registry = buildRegistry(io.env, io.err);
  const { candidates, unavailable } = await scanCandidates(registry);
  if (o.verbose) for (const u of unavailable) io.err(`  – ${u.provider}: ${u.reason}\n`);
  if (candidates.length === 0) {
    throw new ProviderError(
      'unavailable',
      'kernel',
      `No provider is available (${unavailable.map((u) => u.provider).join(', ')}). Set an API key or start Ollama / llama.cpp; see \`kpai providers\`.`,
    );
  }
  const constraints: RoutingConstraints = {
    ...(o.localOnly ? { localOnly: true } : {}),
    ...(o.exclude?.length ? { deniedProviders: o.exclude } : {}),
    ...(o.allowTest ? { excludeKinds: [] } : {}),
  };
  const expectedOutput = calibrationFrom(io, o);
  const router = new CompetenceRouter({
    profile: routingProfile(io.env, o.profile),
    ...(expectedOutput ? { expectedOutput } : {}),
  });
  const decision = router.route(node, candidates, constraints);
  return { node, cls, decision, m };
}

/** Typical output per model and task type, learned from this journal (review F7). */
function calibrationFrom(
  io: Io,
  o: RunOptions,
): ((ref: ModelRef, t: TaskType) => number | undefined) | undefined {
  const journal = openJournal(io.env, o.db);
  try {
    return outputCalibration(journal);
  } finally {
    journal.close();
  }
}

/** `kpai route "request"`: show the plan and routing, run nothing, spend nothing. */
export async function routeCommand(io: Io, o: RunOptions): Promise<number> {
  const p = await plan(io, o);
  io.out(renderPlan(p.node, p.cls, p.decision, p.m));
  if (o.verbose) io.out(renderRejections(p.decision));
  return 0;
}

/** `kpai run "request"`: plan, route, budget gate, execute with fallback, journal it all. */
export async function runCommand(io: Io, o: RunOptions): Promise<number> {
  const p = await plan(io, o);
  io.err(renderPlan(p.node, p.cls, p.decision, p.m));
  if (o.verbose) io.err(renderRejections(p.decision));
  const journal = openJournal(io.env, o.db);
  try {
    const sessionId = sessionFor(io, journal, o);
    journalRouting(journal, sessionId, p);
    const gate = new BudgetGate(io, journal, { sessionId, nodeId: p.node.id, m: p.m }, o);
    if (!(await gate.allow(p.decision.chosen, 'first choice'))) return 4;
    return await execute({ io, journal, sessionId, p, gate });
  } finally {
    journal.close();
  }
}

/**
 * A session spans consecutive runs in the same directory until it has been idle for
 * KPAI_SESSION_IDLE_MIN minutes (default 30), so the session budget adds up (review F5).
 */
function sessionFor(io: Io, journal: Journal, o: RunOptions): string {
  const raw = io.env['KPAI_SESSION_IDLE_MIN']?.trim();
  const minutes = raw ? Number(raw) : 30;
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`KPAI_SESSION_IDLE_MIN must be a non-negative number, got "${raw}"`);
  }
  const resumed = o.newSession
    ? undefined
    : journal.resumableSession(io.cwd, minutes * 60_000, new Date());
  if (resumed) {
    io.err(`session ${resumed.id.slice(0, 8)} (resumed; --new-session to start another)\n`);
    return resumed.id;
  }
  return journal.startSession(o.prompt.slice(0, 80), io.cwd);
}

function journalRouting(journal: Journal, sessionId: string, p: Planned): void {
  const d = p.decision;
  journal.append({
    sessionId,
    type: 'routing',
    nodeId: p.node.id,
    provider: d.chosen.ref.provider,
    model: d.chosen.ref.model,
    payload: {
      reason: d.reason,
      elapsedMs: d.elapsedMs,
      taskType: p.node.type,
      classification: p.cls,
      score: d.chosen.score,
      parts: d.chosen.parts,
      fallbacks: d.fallbacks.map((f) => refToString(f.ref)),
      rejected: d.rejected.length,
    },
  });
}
