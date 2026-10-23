import {
  refToString,
  type PermissionPolicy,
  type ToolBus,
  type ToolCall,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '@kernelpai/core';
import type { JournalEventInput } from '@kernelpai/journal';
import { redact, secretValues, type Env } from './env.js';
import type { McpConnection } from './mcp.js';
import { JailError } from './paths.js';
import { GradedPermissionPolicy, isConfirmAware } from './policy.js';
import { validateInput } from './schema.js';
import {
  DEFAULT_MAX_RESULT_BYTES,
  stripControls,
  summarize,
  summarizeInput,
  truncateBytes,
} from './text.js';
import { ToolError, type LocalTool, type ToolOutcome } from './types.js';

/** The slice of `Journal` the bus needs (so tests can pass a recorder). */
export interface ToolJournal {
  append(input: JournalEventInput): unknown;
}

export interface LocalToolBusOptions {
  tools?: readonly LocalTool[];
  mcp?: readonly McpConnection[];
  policy?: PermissionPolicy;
  journal?: ToolJournal;
  /** Cap on the result text handed back to the model (default 32 kB). */
  maxResultBytes?: number;
  /** Environment whose secret values are redacted from results and journal (default process.env). */
  env?: Env;
}

/** How the permission step ended, as journaled. */
export type ToolDecision =
  'allow' | 'confirmed' | 'declined' | 'deny' | 'invalid' | 'unknown' | 'cancelled';

interface Trace {
  call: ToolCall;
  ctx: ToolContext;
  started: number;
  def?: ToolDefinition;
  decision: ToolDecision;
  reason?: string;
}

/**
 * The universal tool bus (spec §3.3): built-ins and MCP tools behind one
 * interface. Every call is validated, permission-checked, run, truncated and
 * journaled. Tool errors come back as `isError` results; `call` never throws.
 */
export class LocalToolBus implements ToolBus {
  private readonly tools = new Map<string, LocalTool>();
  private readonly connections: McpConnection[] = [];
  readonly policy: PermissionPolicy;
  private readonly journal: ToolJournal | undefined;
  private readonly maxResultBytes: number;
  private readonly secrets: string[];

  constructor(options: LocalToolBusOptions = {}) {
    this.policy = options.policy ?? new GradedPermissionPolicy();
    this.journal = options.journal;
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    this.secrets = secretValues(options.env ?? process.env);
    for (const t of options.tools ?? []) this.register(t);
    for (const c of options.mcp ?? []) this.attach(c);
  }

  register(tool: LocalTool): void {
    if (this.tools.has(tool.def.name))
      throw new Error(`tool ${tool.def.name} is already registered`);
    this.tools.set(tool.def.name, tool);
  }

  attach(connection: McpConnection): void {
    this.connections.push(connection);
    for (const t of connection.tools) this.register(t);
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  async call(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const trace: Trace = { call, ctx, started: Date.now(), decision: 'unknown' };
    try {
      const outcome = await this.dispatch(trace);
      return this.finish(trace, outcome);
    } catch (err) {
      return this.finish(trace, { content: `tool failed: ${errorText(err)}`, isError: true });
    }
  }

  async close(): Promise<void> {
    const conns = this.connections.splice(0);
    await Promise.allSettled(conns.map((c) => c.close()));
  }

  private async dispatch(trace: Trace): Promise<ToolOutcome> {
    const { call, ctx } = trace;
    const tool = this.tools.get(call.name);
    if (!tool) return { content: `unknown tool: ${call.name}`, isError: true };
    trace.def = tool.def;
    if (ctx.signal?.aborted) return this.refuse(trace, 'cancelled', 'cancelled before running');
    const errors = validateInput(tool.def.inputSchema, call.input);
    if (errors.length > 0) {
      return this.refuse(trace, 'invalid', `invalid input for ${call.name}: ${errors.join('; ')}`);
    }
    const input = call.input as Record<string, unknown>;
    const def = tool.riskFor ? { ...tool.def, risk: tool.riskFor(input) } : tool.def;
    trace.def = def;
    const allowed = await this.permit(trace, def, tool.alwaysConfirm?.(input) === true);
    if (!allowed)
      return {
        content: `permission ${trace.decision}: ${trace.reason ?? ''}`.trim(),
        isError: true,
      };
    try {
      return await tool.run(input, ctx);
    } catch (err) {
      if (err instanceof JailError || err instanceof ToolError)
        return { content: err.message, isError: true };
      throw err;
    }
  }

  private refuse(trace: Trace, decision: ToolDecision, content: string): ToolOutcome {
    trace.decision = decision;
    trace.reason = content;
    return { content, isError: true };
  }

  /** Applies the policy (and the forced confirmation of unsandboxed tools); records the decision. */
  private async permit(trace: Trace, def: ToolDefinition, forceConfirm: boolean): Promise<boolean> {
    const { call, ctx } = trace;
    let decision = safeDecide(this.policy, def, call, ctx);
    if (decision === 'deny') {
      trace.decision = 'deny';
      trace.reason = isConfirmAware(this.policy) ? this.policy.reason?.(def, call, ctx) : undefined;
      trace.reason ??= `${def.name} is not permitted`;
      return false;
    }
    const policyAsked = decision === 'confirm';
    if (decision === 'allow' && forceConfirm) decision = 'confirm';
    if (decision === 'allow') {
      trace.decision = 'allow';
      return true;
    }
    const yes = await ctx.confirm(this.question(def, call, ctx)).catch(() => false);
    trace.decision = yes ? 'confirmed' : 'declined';
    if (!yes) {
      trace.reason = 'declined by the user';
      return false;
    }
    if (policyAsked && isConfirmAware(this.policy)) this.policy.confirmed(def, call, ctx);
    return true;
  }

  private question(def: ToolDefinition, call: ToolCall, ctx: ToolContext): string {
    const input = JSON.stringify(redactDeep(summarizeInput(call.input) ?? null, this.secrets));
    const shown = stripControls(input).slice(0, 600);
    return `Allow ${def.name} (${def.risk}) for ${refToString(ctx.model)} on node ${ctx.nodeId}? ${shown}`;
  }

  private finish(trace: Trace, outcome: ToolOutcome): ToolResult {
    const cut = truncateBytes(redact(outcome.content, this.secrets), this.maxResultBytes);
    this.record(trace, outcome, cut.truncated);
    return { content: cut.text, isError: outcome.isError };
  }

  private record(trace: Trace, outcome: ToolOutcome, truncated: boolean): void {
    if (!this.journal) return;
    const { call, ctx, def } = trace;
    const payload: Record<string, unknown> = {
      tool: call.name,
      callId: call.id,
      source: def?.source ?? null,
      risk: def?.risk ?? null,
      decision: trace.decision,
      durationMs: Date.now() - trace.started,
      isError: outcome.isError,
      truncated,
      input: redactDeep(summarizeInput(call.input) ?? null, this.secrets),
      result: summarize(redact(outcome.content, this.secrets)),
    };
    if (trace.reason) payload.reason = stripControls(trace.reason).slice(0, 500);
    if (outcome.meta) payload.meta = outcome.meta;
    try {
      this.journal.append({
        sessionId: ctx.sessionId,
        type: 'tool',
        nodeId: ctx.nodeId,
        provider: ctx.model.provider,
        model: ctx.model.model,
        payload,
      });
    } catch {
      // A journal failure must not turn into a thrown tool call.
    }
  }
}

function errorText(err: unknown): string {
  return stripControls(err instanceof Error ? err.message : String(err)).slice(0, 2000);
}

function safeDecide(
  policy: PermissionPolicy,
  def: ToolDefinition,
  call: ToolCall,
  ctx: ToolContext,
): ReturnType<PermissionPolicy['decide']> {
  try {
    return policy.decide(def, call, ctx);
  } catch {
    return 'deny';
  }
}

/** Redacts every string inside a JSON-like value (keeps the structure valid). */
function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
  return out;
}
