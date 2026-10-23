import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  TaskTypeSchema,
  refToString,
  type GraphNode,
  type PlanContext,
  type Planner,
  type TaskGraph,
  type TaskNode,
} from '@kernelpai/core';
import { FallbackExecutor } from '@kernelpai/executor';
import { extractJson } from '../parse.js';
import type { BudgetHook, OrchestratorOptions } from '../types.js';
import { graphProblems } from '../validate.js';
import { DEFAULT_CODE_TOOLS, TemplatePlanner } from './template.js';

export const MAX_PLAN_NODES = 12;

const NodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/),
  title: z.string().min(1).max(120),
  type: TaskTypeSchema,
  protocol: z.enum(['solo', 'author_critic', 'debate', 'vote']),
  dependsOn: z.array(z.string()).max(MAX_PLAN_NODES).default([]),
  criticality: z.enum(['low', 'normal', 'critical']).default('normal'),
  prompt: z.string().min(1).max(20_000),
  tools: z.array(z.string()).max(32).optional(),
});

/** The JSON a planner model must return. */
export const PlanSchema = z.object({
  reason: z.string().max(2000).optional(),
  nodes: z.array(NodeSchema).min(1),
});

/**
 * `budget` is required (review P2-F8, principle 6): a planner call costs money, so callers
 * cannot forget the spend gate. Pass `() => true` explicitly to allow everything.
 */
export type PlannerDeps = Pick<
  OrchestratorOptions,
  'router' | 'candidates' | 'constraints' | 'resolve' | 'journal' | 'sessionId' | 'executor'
> & { budget: BudgetHook };

export interface ModelPlannerOptions {
  /** Used when the model's plan is rejected; default a `TemplatePlanner`. */
  fallback?: Planner;
  /** Tools a model plan may give a node (others are dropped); default read-only code tools. */
  allowedTools?: readonly string[];
  newId?: () => string;
}

export function plannerPrompt(request: string): string {
  return [
    'Role: planner',
    `Split the request into a small task graph of at most ${MAX_PLAN_NODES} nodes. Use "critical" for security-sensitive work.`,
    'Reply with only a JSON object:',
    '{"reason": "...", "nodes": [{"id": "impl", "title": "...", "type": "analysis|code_generation|writing|research|test|critique|decision", "protocol": "solo|author_critic|debate|vote", "dependsOn": ["other-id"], "criticality": "low|normal|critical", "prompt": "what this node must do", "tools": ["fs.read"]}]}',
    '',
    'Request:',
    request,
  ].join('\n');
}

/**
 * Asks a routed model (a `decision` node, `Role: planner`) for a JSON task graph, validates
 * it (schema, ≤ 12 nodes, known dependencies, no cycle) and falls back to the template
 * planner with the reason when the model fails, is blocked by budget or returns a bad plan.
 * Model output is untrusted: it can only grant tools from `allowedTools`.
 */
export class ModelPlanner implements Planner {
  private readonly executor: FallbackExecutor;
  private readonly fallback: Planner;

  constructor(
    private readonly deps: PlannerDeps,
    private readonly options: ModelPlannerOptions = {},
  ) {
    if (typeof deps.budget !== 'function') {
      throw new TypeError('ModelPlanner needs a budget hook (principle 6)');
    }
    this.executor = new FallbackExecutor(deps.resolve, deps.journal, deps.executor);
    this.fallback = options.fallback ?? new TemplatePlanner();
  }

  async plan(request: string, ctx: PlanContext): Promise<TaskGraph> {
    let text: string;
    try {
      text = await this.ask(request, ctx);
    } catch (err) {
      return this.fallBack(request, ctx, err instanceof Error ? err.message : String(err));
    }
    const parsed = parsePlan(text, request, this.options.allowedTools ?? DEFAULT_CODE_TOOLS);
    if (!parsed.ok) return this.fallBack(request, ctx, parsed.error);
    return {
      id: this.options.newId?.() ?? randomUUID(),
      request,
      nodes: parsed.nodes,
      createdBy: 'model',
      reason: `model plan: ${parsed.reason}`,
    };
  }

  private async ask(request: string, ctx: PlanContext): Promise<string> {
    const node: TaskNode = {
      id: 'plan',
      type: 'decision',
      criticality: 'normal',
      messages: [{ role: 'user', content: plannerPrompt(request) }],
    };
    const d = this.deps.router.route(node, this.deps.candidates, this.deps.constraints ?? {});
    const { journal, sessionId } = this.deps;
    journal.append({
      sessionId,
      type: 'routing',
      nodeId: node.id,
      provider: d.chosen.ref.provider,
      model: d.chosen.ref.model,
      payload: {
        role: 'planner',
        reason: d.reason,
        fallbacks: d.fallbacks.map((f) => refToString(f.ref)),
      },
    });
    const gate = this.deps.budget;
    if (!(await gate(d.chosen, `planner: ${refToString(d.chosen.ref)}`))) {
      throw new Error('planner blocked by budget');
    }
    const r = await this.executor.execute(node, d, {
      sessionId,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      hooks: { beforeFallback: (next) => gate(next, `planner fallback: ${refToString(next.ref)}`) },
      tags: { role: 'planner' },
    });
    if (!r.servedBy) throw new Error(`planner model did not answer (${r.stopReason})`);
    return r.text;
  }

  private async fallBack(request: string, ctx: PlanContext, why: string): Promise<TaskGraph> {
    const g = await this.fallback.plan(request, ctx);
    return { ...g, reason: `model plan rejected (${why}); ${g.reason}` };
  }
}

type Parsed = { ok: true; nodes: GraphNode[]; reason: string } | { ok: false; error: string };

/** Validates a planner reply into graph nodes; each node's prompt carries the original request. */
export function parsePlan(text: string, request: string, allowedTools: readonly string[]): Parsed {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: 'no JSON object in the reply' };
  const p = PlanSchema.safeParse(json);
  if (!p.success) {
    const first = p.error.issues[0];
    return {
      ok: false,
      error: `invalid plan at ${first?.path.join('.') || 'root'}: ${first?.message ?? ''}`,
    };
  }
  if (p.data.nodes.length > MAX_PLAN_NODES) {
    return { ok: false, error: `${p.data.nodes.length} nodes (max ${MAX_PLAN_NODES})` };
  }
  const allowed = new Set(allowedTools);
  const nodes: GraphNode[] = p.data.nodes.map((n) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    protocol: n.protocol,
    dependsOn: n.dependsOn,
    criticality: n.criticality,
    messages: [{ role: 'user', content: `${n.prompt}\n\nOverall request:\n${request}` }],
    ...(n.tools ? { tools: n.tools.filter((t) => allowed.has(t)) } : {}),
  }));
  const problems = graphProblems(nodes);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  return { ok: true, nodes, reason: p.data.reason ?? `${nodes.length} node(s)` };
}
