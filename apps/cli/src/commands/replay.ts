/**
 * `kpai replay` and `kpai fork` (R-403, ADR-0029): the console's replay and fork, through
 * the same kernel paths. A replay reruns one finished node beside the original and writes
 * nothing; a fork is planned, shown with its estimate, started like any plan (band top
 * checked, D-021) and finished like `kpai do` (patches only with `--apply`, each confirmed).
 */
import {
  KernelError,
  readScopeFile,
  type GraphOptions,
  type Kernel,
  type NodeEdit,
  type ReplayPlan,
} from '@kernelpai/kernel';
import type { ReplayResult } from '@kernelpai/orchestrator';
import { formatMoney, money } from '../config.js';
import type { Io } from '../io.js';
import { sanitizeForTerminal } from '../sanitize.js';
import { finishRun, notRun, open, planText } from './graph.js';
import { duration } from './productivity.js';

const PROTOCOLS = ['solo', 'author_critic', 'debate', 'vote'] as const;
type ProtocolName = (typeof PROTOCOLS)[number];
const SHOWN_CHARS = 4_000;

export interface NodeCliOptions extends GraphOptions {
  db?: string | undefined;
  runId: string;
  nodeId: string;
  /** `-m provider/model`. */
  model?: string | undefined;
  protocol?: string | undefined;
  /** Fork only: a human instruction added to the node it starts from. */
  instruction?: string | undefined;
  apply?: boolean | undefined;
  yesApply?: boolean | undefined;
  /** `--scope <file>`: authorised scope (YAML or JSON) for packs that need one. */
  scopeFile?: string | undefined;
}

/** A usage problem in the arguments, reported with exit code 2. */
export class NodeArgsError extends Error {}

/** The edit asked on the command line; the kernel checks the model is available. */
export function nodeEdit(o: NodeCliOptions): NodeEdit {
  const edit: NodeEdit = {};
  if (o.model !== undefined) {
    const at = o.model.indexOf('/');
    if (at <= 0 || at === o.model.length - 1)
      throw new NodeArgsError(`-m must be provider/model, not "${o.model.slice(0, 100)}"`);
    edit.model = { provider: o.model.slice(0, at), model: o.model.slice(at + 1) };
  }
  if (o.protocol !== undefined) {
    if (!PROTOCOLS.includes(o.protocol as ProtocolName))
      throw new NodeArgsError(`--protocol must be one of ${PROTOCOLS.join(', ')}`);
    edit.protocol = o.protocol as ProtocolName;
  }
  if (o.instruction !== undefined && o.instruction.trim() !== '')
    edit.instruction = o.instruction.trim();
  return edit;
}

/**
 * The run flags of a replay or fork, routing included (P4-F2): the kernel holds them to the
 * original run's routing as a floor, so they can only make it stricter.
 */
async function graphOptions(o: NodeCliOptions): Promise<GraphOptions> {
  const keys = [
    'allowTest',
    'yes',
    'overBudget',
    'allowSameProvider',
    'isolated',
    'localOnly',
    'exclude',
    'profile',
  ] as const;
  const out: GraphOptions = {};
  for (const k of keys) if (o[k] !== undefined) Object.assign(out, { [k]: o[k] });
  if (o.scopeFile)
    out.scope = (await readScopeFile(o.scopeFile)) ?? { invalid: `${o.scopeFile} not found` };
  return out;
}

/** What the replay is held to, in words (P4-F2). */
function routingLine(o: GraphOptions): string {
  const parts = [
    o.localOnly ? 'local-only' : '',
    o.exclude?.length ? `excluding ${o.exclude.join(', ')}` : '',
    o.profile ? `profile ${o.profile}` : '',
  ].filter(Boolean);
  return parts.length ? ` · ${sanitizeForTerminal(parts.join(' · '))}` : '';
}

/**
 * P4-F5: likely and cap first (D-021), then a yes (`--yes` or y at the prompt) before
 * anything is spent. Returns false when the human declined.
 */
async function accepted(io: Io, plan: ReplayPlan, yes: boolean | undefined): Promise<boolean> {
  const m = money(io.env);
  const { expectedUsd, capUsd } = plan.estimate;
  const what = `replay of ${sanitizeForTerminal(plan.nodeId)} (run ${plan.runId.slice(0, 8)})`;
  io.err(
    `${what}: likely ${formatMoney(expectedUsd, m)} · up to ${formatMoney(capUsd, m)} (cap)${routingLine(plan.options)}\n`,
  );
  for (const p of plan.scope.problems) io.err(`  – scope: ${sanitizeForTerminal(p)}\n`);
  if (yes) return true;
  return io.confirm(`Run this ${what} for up to ${formatMoney(capUsd, m)}?`);
}

/** Runs a planned replay; Ctrl+C cancels it (the attempt keeps its partial output). */
async function runReplay(io: Io, kernel: Kernel, plan: ReplayPlan, o: NodeCliOptions) {
  const flags = { yes: o.yes, overBudget: o.overBudget, accepted: true };
  const handle = await kernel.startReplay(plan.planId, flags);
  const unregister = io.onInterrupt(() => void kernel.cancel(handle.replayId));
  try {
    return await handle.done;
  } finally {
    unregister();
  }
}

/** Kernel refusals of a replay or fork: bad arguments are 2, an unknown run or node 1. */
function failed(io: Io, err: unknown): number {
  if (err instanceof NodeArgsError) {
    io.err(`${err.message}\n`);
    return 2;
  }
  if (err instanceof KernelError && err.code === 'budget') {
    io.err(`${err.message}\n`);
    return 4;
  }
  if (err instanceof KernelError && (err.code === 'invalid' || err.code === 'not_found')) {
    io.err(`not run — ${err.message}\n`);
    return err.code === 'invalid' ? 2 : 1;
  }
  return notRun(io, err);
}

function attempt(label: string, a: ReplayResult['original'], m: ReturnType<typeof money>): string {
  const models = a.models.map((r) => `${r.provider}/${r.model}`).join(', ') || '–';
  const head = `${label}: ${a.protocol} · ${sanitizeForTerminal(models)} · ${formatMoney(a.costUsd, m)} · ${duration(a.durationMs)}${a.ok ? '' : ' · failed'}`;
  const text = a.ok ? a.output : (a.error ?? '');
  const cut = text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
  return `--- ${head}\n${sanitizeForTerminal(cut)}\n`;
}

/** `kpai replay <run> <node> [-m provider/model] [--protocol p]`: writes nothing. */
export async function replayCommand(io: Io, o: NodeCliOptions): Promise<number> {
  if (o.instruction !== undefined) {
    io.err('--instruction is for kpai fork; a replay reruns the node as it was asked\n');
    return 2;
  }
  const kernel = open(io, o);
  try {
    const plan = await kernel.replayPlan(o.runId, o.nodeId, nodeEdit(o), await graphOptions(o));
    if (!(await accepted(io, plan, o.yes))) {
      io.err('not run — replay declined\n');
      return 4;
    }
    const r = await runReplay(io, kernel, plan, o);
    const m = money(io.env);
    io.out(attempt('original', r.original, m));
    io.out(attempt('replay', r.replay, m));
    const c = r.comparison;
    const sign = (x: number): string => (x > 0 ? '+' : x < 0 ? '−' : '±');
    io.err(
      `replay ${r.replayId.slice(0, 8)} of ${o.nodeId}: ${c.sameOutput ? 'same output' : 'different output'} · cost ${sign(c.costDeltaUsd)}${formatMoney(Math.abs(c.costDeltaUsd), m)} · time ${sign(c.durationDeltaMs)}${duration(Math.abs(c.durationDeltaMs))}\n`,
    );
    return r.replay.ok ? 0 : 1;
  } catch (err) {
    return failed(io, err);
  } finally {
    await kernel.close();
  }
}

/** `kpai fork <run> <node> [-m provider/model] [--instruction text]`: planned, then run. */
export async function forkCommand(io: Io, o: NodeCliOptions): Promise<number> {
  const kernel = open(io, o);
  try {
    const options = await graphOptions(o);
    const plan = await kernel.forkPlan(o.runId, o.nodeId, nodeEdit(o), options);
    const f = plan.fork;
    io.err(planText(plan));
    if (f)
      io.err(
        `fork of ${o.runId.slice(0, 8)}: rerun ${f.rerun.join(', ') || '–'} · reused ${Object.keys(f.reuse).join(', ') || '–'}\n`,
      );
    const handle = await kernel.startFork(plan.planId, options);
    return await finishRun(io, kernel, plan, handle, o);
  } catch (err) {
    return failed(io, err);
  } finally {
    await kernel.close();
  }
}
