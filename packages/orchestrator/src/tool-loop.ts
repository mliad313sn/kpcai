import {
  estimateRequest,
  refToString,
  type ChatMessage,
  type ChatRequest,
  type ContributionRole,
  type ExecutionHooks,
  type GraphNode,
  type ModelRef,
  type RoutingDecision,
  type ScoredCandidate,
  type ToolBus,
  type ToolCall,
  type ToolDefinition,
} from '@kernelpai/core';
import type { ToolAwareResult } from '@kernelpai/executor';
import type { NodeHold } from './node-budget.js';
import { preferRef, sameRef, servedCandidate } from './routing.js';
import type { StepRunner } from './step.js';
import { DEFAULT_MAX_TOOL_ROUNDS, type NodeRun, type StepSpec } from './types.js';

export type LoopResult =
  | { ok: true; text: string; ref: ModelRef; served: ScoredCandidate; costUsd: number }
  | { ok: false; error: string; cancelled: boolean; costUsd: number; text: string; ref?: ModelRef };

/** The node's tools known to the bus, and the names the bus does not know. */
export function nodeTools(
  bus: ToolBus | undefined,
  node: GraphNode,
): { defs: ToolDefinition[]; unknown: string[] } {
  const wanted = node.tools ?? [];
  if (!bus || wanted.length === 0) return { defs: [], unknown: bus ? [] : [...wanted] };
  const all = bus.list();
  const defs = new Map<string, ToolDefinition>();
  const unknown: string[] = [];
  for (const w of wanted) {
    // `<namespace>.*` (pack hints such as `mcp.ghidra.*`) matches every tool of that
    // namespace; a bare `*` or `fs*` matches nothing (no blanket grant).
    const prefix = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.\*$/.test(w) ? w.slice(0, -1) : undefined;
    const hits = all.filter((d) =>
      prefix !== undefined ? d.name.startsWith(prefix) : d.name === w,
    );
    if (hits.length === 0) unknown.push(w);
    for (const d of hits) defs.set(d.name, d);
  }
  return { defs: [...defs.values()], unknown };
}

function hooksFor(
  s: StepRunner,
  run: NodeRun,
  role: ContributionRole,
  hold?: NodeHold,
): ExecutionHooks {
  const nodeId = run.node.id;
  return {
    onAttemptStart: (ref) =>
      s.emit({
        type: 'node_state',
        nodeId,
        state: role === 'critic' ? 'review' : 'running',
        ref,
        role,
      }),
    onText: (delta, ref) => s.emit({ type: 'text', nodeId, role, ref, delta }),
    beforeFallback: (next) =>
      s.allow(next, `${role} fallback on ${nodeId}: ${refToString(next.ref)}`, run, hold),
  };
}

function noAnswer(r: ToolAwareResult): string {
  const last = r.attempts.at(-1);
  if (r.stopReason === 'cancelled') return 'cancelled';
  if (!last) return 'no model could be tried';
  return `no model answered (last: ${refToString(last.ref)} ${last.errorKind ?? 'error'}${last.message ? `: ${last.message}` : ''})`;
}

/**
 * Executes a step, running tool calls through the `ToolBus` (permission + journal) and
 * feeding results back as `tool` messages, up to `maxToolRounds` rounds. Each new round is
 * budget-gated and goes back to the model that asked for the tools first.
 */
export async function executeWithTools(
  s: StepRunner,
  run: NodeRun,
  spec: StepSpec,
  stepNode: GraphNode,
  first: RoutingDecision,
  hold?: NodeHold,
): Promise<LoopResult> {
  const defs = spec.tools === false ? [] : nodeTools(s.o.tools, run.node).defs;
  const tools: ChatRequest['tools'] = defs.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  const max = s.o.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS;
  let messages = stepNode.messages;
  let decision = first;
  let cost = 0;
  for (let round = 0; ; round++) {
    const r = await s.executor.execute({ ...stepNode, messages }, decision, {
      sessionId: s.o.sessionId,
      ...(run.signal ? { signal: run.signal } : {}),
      hooks: hooksFor(s, run, spec.role, hold),
      tools,
      tags: { ...run.tags, role: spec.role },
    });
    cost += r.costUsd;
    s.graph.add(r.costUsd);
    run.costUsd += r.costUsd;
    hold?.spend(r.costUsd);
    const done = settle(r, cost, defs.length > 0, decision);
    if (done) return done;
    const ref = r.servedBy as ModelRef;
    if (round >= max) return stop(`tool round limit (${max}) reached`, cost, r.text, ref);
    const results = await runTools(s, run, ref, r.toolCalls, defs);
    messages = [
      ...messages,
      { role: 'assistant', content: r.text, toolCalls: r.toolCalls },
      ...results,
    ];
    decision = reestimated(s, preferRef(decision, ref), stepNode, messages, tools);
    const refused = await gateRound(s, run, spec, round + 1, decision, hold);
    if (refused) return stop(refused, cost, r.text, ref);
  }
}

/** Budget gate of a tool round (graph cap, node cap, hook); why it must not run, if so. */
async function gateRound(
  s: StepRunner,
  run: NodeRun,
  spec: StepSpec,
  round: number,
  decision: RoutingDecision,
  hold: NodeHold | undefined,
): Promise<string | undefined> {
  const label = `${spec.role} tool round ${round} on ${run.node.id}`;
  const refused = await s.refusal(decision.chosen, label, run, hold);
  if (refused) {
    s.intervention(run.node.id, { action: 'tool round blocked by budget', role: spec.role, label });
    return refused;
  }
  hold?.claim(s.topUsd(decision.chosen));
  return undefined;
}

/**
 * The decision with its first choice re-priced on the conversation as it now stands (tool
 * calls, tool results and tool definitions included), so each tool round is gated on its
 * real input size (review P2-F9) rather than on the first prompt's.
 */
export function reestimated(
  s: StepRunner,
  decision: RoutingDecision,
  node: GraphNode,
  messages: ChatMessage[],
  tools: ChatRequest['tools'],
): RoutingDecision {
  const c = decision.chosen;
  const card = s.o.candidates.find((k) => sameRef(k.ref, c.ref))?.card;
  if (!card) return decision;
  const flat: ChatMessage[] = messages.map((m) => ({
    role: m.role,
    content: m.toolCalls ? `${m.content}${JSON.stringify(m.toolCalls)}` : m.content,
  }));
  if (tools && tools.length > 0) flat.push({ role: 'system', content: JSON.stringify(tools) });
  const expected = s.o.executor?.expectedOutput?.(c.ref, node.type);
  const req = {
    model: c.ref.model,
    messages: flat,
    ...(node.maxOutputTokens ? { maxOutputTokens: node.maxOutputTokens } : {}),
  };
  const estimate = estimateRequest(
    req,
    card,
    expected === undefined ? {} : { expectedOutputTokens: expected },
  );
  return { ...decision, chosen: { ...c, estimate } };
}

/** The step's result when this execution ends it; undefined when tools must run. */
function settle(
  r: ToolAwareResult,
  costUsd: number,
  withTools: boolean,
  decision: RoutingDecision,
): LoopResult | undefined {
  if (!r.servedBy) {
    return {
      ok: false,
      error: noAnswer(r),
      cancelled: r.stopReason === 'cancelled',
      costUsd,
      text: '',
    };
  }
  if (r.stopReason === 'cancelled') {
    return {
      ok: false,
      error: 'cancelled',
      cancelled: true,
      costUsd,
      text: r.text,
      ref: r.servedBy,
    };
  }
  if (!withTools || r.stopReason !== 'tool_use' || r.toolCalls.length === 0) {
    const served = servedCandidate(decision, r.servedBy);
    return { ok: true, text: r.text, ref: r.servedBy, served, costUsd };
  }
  return undefined;
}

function stop(error: string, costUsd: number, text: string, ref: ModelRef): LoopResult {
  return { ok: false, error, cancelled: false, costUsd, text, ref };
}

/** Runs each call in order; a tool the node does not allow is refused without reaching the bus. */
async function runTools(
  s: StepRunner,
  run: NodeRun,
  model: ModelRef,
  calls: ToolCall[],
  defs: ToolDefinition[],
): Promise<ChatMessage[]> {
  const allowed = new Set(defs.map((d) => d.name));
  const out: ChatMessage[] = [];
  for (const call of calls) {
    const res = allowed.has(call.name)
      ? await callBus(s, run, model, call)
      : refuse(s, run, model, call);
    out.push({ role: 'tool', content: res.content, toolCallId: call.id, isError: res.isError });
  }
  return out;
}

async function callBus(
  s: StepRunner,
  run: NodeRun,
  model: ModelRef,
  call: ToolCall,
): Promise<{ content: string; isError: boolean }> {
  const bus = s.o.tools as ToolBus;
  try {
    return await bus.call(call, {
      model,
      root: s.o.root ?? process.cwd(),
      sessionId: s.o.sessionId,
      nodeId: run.node.id,
      ...(run.signal ? { signal: run.signal } : {}),
      confirm: s.o.confirm ?? (() => Promise.resolve(false)),
    });
  } catch (err) {
    return {
      content: `tool ${call.name} failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

function refuse(
  s: StepRunner,
  run: NodeRun,
  model: ModelRef,
  call: ToolCall,
): { content: string; isError: boolean } {
  s.o.journal.append({
    sessionId: s.o.sessionId,
    type: 'tool',
    nodeId: run.node.id,
    provider: model.provider,
    model: model.model,
    payload: { name: call.name, decision: 'deny', reason: 'tool not allowed for this node' },
  });
  return { content: `tool "${call.name}" is not available to this step`, isError: true };
}
