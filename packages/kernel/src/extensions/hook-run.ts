/**
 * Running hooks through the tool bus (R-502, ADR-0033). Each hook is one `shell.run` call:
 * the bus validates, applies the permission policy and its zones, confirms (an unsandboxed
 * process is always confirmed), runs with a scrubbed environment and a timeout, and
 * journals it. The event is the program's last argument, as JSON. Exit code 0 lets the
 * step go on; anything else (an error, a timeout, a refusal, a "no") is a veto for
 * `before-plan` and `before-tool`. Hook output is untrusted: it is quoted, never parsed,
 * and it can veto but never approve or widen anything.
 */
import type { ToolBus, ToolCall, ToolContext, ToolResult } from '@kernelpai/core';
import { redact, secretValues, stripControls, type ToolJournal } from '@kernelpai/tools';
import type { Env } from '../env.js';
import { hookMatches, type HookEvent, type HookSpec, type LoadedHooks } from './hooks.js';

/** The tool context's model for hook calls: the user's own command, not a model's. */
export const HOOK_MODEL = { provider: 'kernel', model: 'hook' } as const;
const MAX_PAYLOAD_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 1_000;

export interface HookRun {
  name: string;
  ok: boolean;
  /** What the hook printed or why it did not run: untrusted, capped, control-free. */
  output: string;
}

export interface HookVerdict {
  ok: boolean;
  runs: HookRun[];
  /** One line on the first failure, for a veto message. */
  reason?: string;
}

export interface HookContext {
  root: string;
  sessionId: string;
  /** The node, run or step the hook runs for (its calls get their own write batch). */
  nodeId: string;
  env: Env;
  signal?: AbortSignal;
  /** Asks the human, with the bus's question about the hook's command line. */
  confirm(question: string): Promise<boolean>;
}

/** The event as the hook's last argument: capped, secrets redacted. */
export function hookPayload(env: Env, event: HookEvent, data: Record<string, unknown>): string {
  const secrets = secretValues(env);
  let text = redact(JSON.stringify({ event, ...data }), secrets);
  if (text.length > MAX_PAYLOAD_CHARS) {
    const small = { event, ...data, input: undefined, inputTruncated: true };
    text = redact(JSON.stringify(small), secrets).slice(0, MAX_PAYLOAD_CHARS);
  }
  return text;
}

const quoted = (t: string): string => stripControls(t).slice(0, MAX_OUTPUT_CHARS);

async function runOne(
  bus: ToolBus,
  h: HookSpec,
  payload: string,
  ctx: HookContext,
): Promise<HookRun> {
  const what = `${h.origin === 'repo' ? 'repository' : 'your'} hook "${h.name}" (${h.event})`;
  const call: ToolCall = {
    id: `hook-${h.name}`,
    name: 'shell.run',
    input: { command: h.command, args: [...h.args, payload], timeoutMs: h.timeoutMs },
  };
  const tctx: ToolContext = {
    model: { ...HOOK_MODEL },
    root: ctx.root,
    sessionId: ctx.sessionId,
    nodeId: `${ctx.nodeId}#hook-${h.name}`,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
    // Allow-listed in $KPAI_HOME: no question. Otherwise the human sees the command line.
    confirm: (q) => (h.allowListed ? Promise.resolve(true) : ctx.confirm(`Run ${what}?\n${q}`)),
  };
  try {
    const r = await bus.call(call, tctx);
    return { name: h.name, ok: !r.isError, output: quoted(r.content) };
  } catch (err) {
    return { name: h.name, ok: false, output: quoted(String(err)) };
  }
}

/**
 * Runs the hooks of one event in order. Veto events stop at the first failure, and fail
 * closed while a hooks file is broken; `after-patch` hooks all run and only report.
 */
export async function runHooks(
  bus: ToolBus,
  loaded: LoadedHooks,
  event: HookEvent,
  data: Record<string, unknown>,
  ctx: HookContext,
  tool?: string,
): Promise<HookVerdict> {
  const veto = event !== 'after-patch';
  if (veto && loaded.broken.length > 0) {
    const reason = `hooks file ${loaded.broken.join(', ')} is invalid: fix it to continue`;
    return { ok: false, runs: [], reason };
  }
  const list = loaded.hooks.filter(
    (h) => h.event === event && (tool === undefined || hookMatches(h, tool)),
  );
  const runs: HookRun[] = [];
  if (list.length === 0) return { ok: true, runs };
  const payload = hookPayload(ctx.env, event, data);
  for (const h of list) {
    const r = await runOne(bus, h, payload, ctx);
    runs.push(r);
    if (!r.ok && veto) {
      const reason = `vetoed by hook "${h.name}": ${r.output.split('\n').slice(0, 6).join(' | ')}`;
      return { ok: false, runs, reason };
    }
  }
  return { ok: runs.every((r) => r.ok), runs };
}

export interface HookedBusDeps {
  hooks: LoadedHooks;
  env: Env;
  journal: ToolJournal;
  runId: string;
}

/**
 * The run's tool bus with `before-tool` hooks in front (R-502): every call a model makes
 * first runs the matching hooks (through the inner bus, so they never trigger themselves);
 * a veto, an error or a timeout refuses the call, journaled, and the model sees why.
 */
export function hookedBus(inner: ToolBus, d: HookedBusDeps): ToolBus {
  const active = d.hooks.broken.length > 0 || d.hooks.hooks.some((h) => h.event === 'before-tool');
  if (!active) return inner;
  return {
    list: () => inner.list(),
    close: () => inner.close(),
    async call(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
      const data = { tool: call.name, input: call.input, nodeId: ctx.nodeId, runId: d.runId };
      const v = await runHooks(
        inner,
        d.hooks,
        'before-tool',
        data,
        { ...ctx, env: d.env },
        call.name,
      );
      if (v.ok) return inner.call(call, ctx);
      const reason = v.reason ?? 'vetoed by a hook';
      try {
        d.journal.append({
          sessionId: ctx.sessionId,
          type: 'intervention',
          nodeId: ctx.nodeId,
          payload: { action: 'tool vetoed by hook', tool: call.name, runId: d.runId, reason },
        });
      } catch {
        // A journal failure never turns a veto into a call.
      }
      return { content: `tool call refused: ${reason}`, isError: true };
    },
  };
}
