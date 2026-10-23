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
  type TaskType,
} from '@kernelpai/core';
import { FallbackExecutor } from '@kernelpai/executor';
import type { Pack } from '@kernelpai/packs';
import { extractJson } from '../parse.js';
import type { BudgetHook, OrchestratorOptions } from '../types.js';
import { graphProblems } from '../validate.js';
import type { PlannedNode } from '../types.js';
import { proposedTypeAliases } from './packs.js';
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
  /**
   * Active domain packs: their `proposedTaskTypes` are offered to the model and mapped
   * onto core types via `mapsTo` (kept as `proposedType`); the default fallback is a
   * `TemplatePlanner` with the same packs.
   */
  packs?: readonly Pack[];
}

export function plannerPrompt(request: string, extraTypes: readonly string[] = []): string {
  const types = ['analysis', 'code_generation', 'writing', 'research', 'test', 'critique'];
  types.push('decision', ...extraTypes);
  return [
    'Role: planner',
    `Split the request into a small task graph of at most ${MAX_PLAN_NODES} nodes. Use "critical" for security-sensitive work.`,
    'Reply with only a JSON object:',
    `{"reason": "...", "nodes": [{"id": "impl", "title": "...", "type": "${types.join('|')}", "protocol": "solo|author_critic|debate|vote", "dependsOn": ["other-id"], "criticality": "low|normal|critical", "prompt": "what this node must do", "tools": ["fs.read"]}]}`,
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
  private readonly aliases: ReadonlyMap<string, TaskType>;

  constructor(
    private readonly deps: PlannerDeps,
    private readonly options: ModelPlannerOptions = {},
  ) {
    if (typeof deps.budget !== 'function') {
      throw new TypeError('ModelPlanner needs a budget hook (principle 6)');
    }
    this.executor = new FallbackExecutor(deps.resolve, deps.journal, deps.executor);
    this.fallback =
      options.fallback ?? new TemplatePlanner(options.packs ? { packs: options.packs } : {});
    this.aliases = proposedTypeAliases(options.packs ?? []);
  }

  async plan(request: string, ctx: PlanContext): Promise<TaskGraph> {
    let text: string;
    try {
      text = await this.ask(plannerPrompt(request, [...this.aliases.keys()]), ctx);
    } catch (err) {
      return this.fallBack(request, ctx, err instanceof Error ? err.message : String(err));
    }
    const tools = this.options.allowedTools ?? DEFAULT_CODE_TOOLS;
    const parsed = parsePlan(text, request, tools, this.aliases);
    if (!parsed.ok) return this.fallBack(request, ctx, parsed.error);
    return {
      id: this.options.newId?.() ?? randomUUID(),
      request,
      nodes: parsed.nodes,
      createdBy: 'model',
      reason: `model plan: ${parsed.reason}`,
    };
  }

  private async ask(prompt: string, ctx: PlanContext): Promise<string> {
    const node: TaskNode = {
      id: 'plan',
      type: 'decision',
      criticality: 'normal',
      messages: [{ role: 'user', content: prompt }],
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

/**
 * Pack-proposed type names in a raw plan become their core type (`mapsTo`); the proposed
 * name is returned by node index.
 */
function mapTypes(json: unknown, aliases: ReadonlyMap<string, TaskType>): Map<number, string> {
  const proposed = new Map<number, string>();
  const nodes = (json as { nodes?: unknown } | null)?.nodes;
  if (aliases.size === 0 || !Array.isArray(nodes)) return proposed;
  nodes.forEach((n: unknown, i) => {
    const node = n as { type?: unknown } | null;
    const core = typeof node?.type === 'string' ? aliases.get(node.type) : undefined;
    if (node && core) {
      proposed.set(i, node.type as string);
      node.type = core;
    }
  });
  return proposed;
}

/**
 * Validates a planner reply into graph nodes; each node's prompt carries the original
 * request. `aliases` maps pack-proposed type names onto core types.
 */
export function parsePlan(
  text: string,
  request: string,
  allowedTools: readonly string[],
  aliases: ReadonlyMap<string, TaskType> = new Map(),
): Parsed {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, error: 'no JSON object in the reply' };
  const proposed = mapTypes(json, aliases);
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
  const nodes: PlannedNode[] = p.data.nodes.map((n, i) => ({
    id: n.id,
    title: n.title,
    type: n.type,
    protocol: n.protocol,
    dependsOn: n.dependsOn,
    criticality: n.criticality,
    messages: [{ role: 'user', content: `${n.prompt}\n\nOverall request:\n${request}` }],
    ...(n.tools ? { tools: n.tools.filter((t) => allowed.has(t)) } : {}),
    ...(proposed.has(i) ? { proposedType: proposed.get(i) as string } : {}),
  }));
  const problems = graphProblems(nodes);
  if (problems.length > 0) return { ok: false, error: problems.join('; ') };
  return { ok: true, nodes, reason: p.data.reason ?? `${nodes.length} node(s)` };
}
