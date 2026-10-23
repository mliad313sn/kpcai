import {
  ProviderError,
  refToString,
  type Classification,
  type Criticality,
  type RoutingConstraints,
  type RoutingDecision,
  type TaskNode,
  type TaskType,
} from '@kernelpai/core';
import { Governor, JournalLedger } from '@kernelpai/budget';
import { FallbackExecutor, classify } from '@kernelpai/executor';
import type { Journal } from '@kernelpai/journal';
import { CompetenceRouter } from '@kernelpai/router';
import { budgetLimits, formatMoney, money, routingProfile, type Money } from '../config.js';
import { candidates as scanCandidates } from '@kernelpai/providers';
import { buildRegistry, openJournal } from '../context.js';
import type { Io } from '../io.js';
import { renderPlan, renderRejections } from '../render.js';

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
  verbose?: boolean;
  db?: string;
}

interface Planned {
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
    id: 'n1',
    type: cls.type,
    messages: [{ role: 'user', content: o.prompt }],
    criticality: o.criticality ?? 'normal',
    ...(limits.task !== undefined ? { budgetUsd: limits.task } : {}),
    ...(o.maxTokens ? { maxOutputTokens: o.maxTokens } : {}),
  };
  const registry = buildRegistry(io.env);
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
  const router = new CompetenceRouter({ profile: routingProfile(io.env, o.profile) });
  const decision = router.route(node, candidates, constraints);
  return { node, cls, decision, m };
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
    const sessionId = journal.startSession(o.prompt.slice(0, 80), io.cwd);
    journalRouting(journal, sessionId, p);
    if (!(await budgetGate(io, journal, sessionId, p, o.yes ?? false))) return 4;
    return await execute(io, journal, sessionId, p);
  } finally {
    journal.close();
  }
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

async function budgetGate(
  io: Io,
  journal: Journal,
  sessionId: string,
  p: Planned,
  yes: boolean,
): Promise<boolean> {
  const governor = new Governor(budgetLimits(io.env), new JournalLedger(journal));
  const estimate = p.decision.chosen.estimate.expectedCostUsd;
  const v = governor.check(estimate, { sessionId, project: io.cwd, now: new Date() });
  if (v.action === 'allow') return true;
  if (v.action === 'confirm' && (yes || (await io.confirm(`${v.reason} Continue?`)))) return true;
  const why =
    v.action === 'block'
      ? `blocked by ${v.scope} budget: ${formatMoney(v.projectedUsd, p.m)} > ${formatMoney(v.limitUsd, p.m)}. Options: ${v.options.join(', ')}`
      : 'declined at confirmation';
  journal.append({
    sessionId,
    type: 'intervention',
    nodeId: p.node.id,
    payload: { action: `budget: ${why}`, verdict: v },
  });
  io.err(`not run — ${why}\n`);
  return false;
}

async function execute(io: Io, journal: Journal, sessionId: string, p: Planned): Promise<number> {
  const registry = buildRegistry(io.env);
  const executor = new FallbackExecutor((ref) => registry.get(ref.provider), journal);
  const ctl = new AbortController();
  const unregister = io.onInterrupt(() => {
    journal.append({
      sessionId,
      type: 'intervention',
      nodeId: p.node.id,
      payload: { action: 'cancel' },
    });
    ctl.abort();
  });
  const started = Date.now();
  try {
    const r = await executor.execute(p.node, p.decision, {
      sessionId,
      signal: ctl.signal,
      hooks: {
        onText: (delta) => io.out(delta),
        onAttemptFailed: (a) =>
          io.err(
            `\n↷ ${refToString(a.ref)} failed (${a.errorKind ?? 'error'}): ${a.message ?? ''}\n`,
          ),
      },
    });
    const by = r.servedBy ? refToString(r.servedBy) : 'nobody';
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    io.out('\n');
    io.err(
      `— ${by}${r.fellBack ? ' (fallback)' : ''} · ${secs}s · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · ${formatMoney(r.costUsd, p.m)} · ${r.stopReason} · ${r.attempts.length} attempt(s) · session ${sessionId.slice(0, 8)}\n`,
    );
    if (r.stopReason === 'cancelled') return 130;
    return r.servedBy ? 0 : 1;
  } finally {
    unregister();
  }
}
