/**
 * Runs one agent CLI headless as a node's author (R-503, ADR-0034): in a fresh checkout of
 * the workspace (the node's worktree), with a scrubbed environment, a time cap and a kill
 * on cancel. What comes back is untrusted: a sanitized summary and the diff of the
 * checkout, checked; the diff then goes through the normal review and approval path. Any
 * change the run made outside its worktree fails it ("escaped") and nothing is handed on.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Env } from '../env.js';
import { agentArgs, type AgentDescriptor } from './descriptor.js';
import { agentEnv } from './env.js';
import { parseOutput, sanitize, type AgentUsage } from './output.js';
import { runProcess, type SpawnResult } from './spawn.js';
import {
  applyDraft,
  changedSince,
  closeWorktree,
  diffFiles,
  diffProblem,
  openWorktree,
  snapshot,
  worktreeDiff,
  type NodeWorktree,
} from './worktree.js';

/** Longest prompt passed as one command-line argument (Linux caps one at 128 KiB). */
export const MAX_ARG_PROMPT_CHARS = 100_000;

export type AgentRunStatus =
  'ok' | 'failed' | 'timeout' | 'cancelled' | 'rate_limited' | 'escaped' | 'refused';

export interface AgentRunRequest {
  descriptor: AgentDescriptor;
  /** The workspace whose HEAD the node's worktree starts from. */
  root: string;
  prompt: string;
  /** An earlier draft (diff) to start from: a revision continues the agent's own work. */
  draft?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** The parent environment (scrubbed before the child sees it). */
  env: Env;
  /** KernelPAI's API key variable names (`auth.env` of every provider descriptor). */
  scrub: readonly string[];
}

export interface AgentRunResult {
  status: AgentRunStatus;
  /** The agent's own words, sanitized and capped: untrusted data. */
  summary: string;
  /** The checkout's change against its base ('' unless ok). */
  diff: string;
  files: string[];
  usage: AgentUsage;
  durationMs: number;
  exitCode: number | null;
  error?: string;
  /** Paths changed outside the worktree (status `escaped`). */
  outside?: string[];
  /** Output went past the capture cap and was cut. */
  truncated: boolean;
}

/** The type of `runAgent`, so callers can inject another runner. */
export type AgentRunner = (req: AgentRunRequest) => Promise<AgentRunResult>;

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function empty(status: AgentRunStatus, error: string): AgentRunResult {
  return {
    status,
    summary: '',
    diff: '',
    files: [],
    usage: {},
    durationMs: 0,
    exitCode: null,
    error,
    truncated: false,
  };
}

export const runAgent: AgentRunner = async (req) => {
  const d = req.descriptor;
  if (d.promptVia === 'arg' && req.prompt.length > MAX_ARG_PROMPT_CHARS) {
    return empty('refused', `prompt longer than ${MAX_ARG_PROMPT_CHARS} characters for ${d.id}`);
  }
  const env = agentEnv(req.env, [...req.scrub, ...d.scrubEnv]);
  let wt: NodeWorktree;
  try {
    wt = await openWorktree(req.root, env);
  } catch (err) {
    return empty('refused', `the node's worktree could not be made: ${errorText(err)}`);
  }
  try {
    await applyDraft(wt, req.draft ?? '', env);
    return await inWorktree(req, wt, env);
  } catch (err) {
    return empty('failed', errorText(err));
  } finally {
    await closeWorktree(wt);
  }
};

async function inWorktree(
  req: AgentRunRequest,
  wt: NodeWorktree,
  env: Record<string, string>,
): Promise<AgentRunResult> {
  const d = req.descriptor;
  const tmp = join(wt.jail, 'tmp');
  const before = await snapshot(wt, env);
  const p = await runProcess({
    binary: d.binary,
    args: agentArgs(d, req.prompt),
    cwd: wt.path,
    env: { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    ...(d.promptVia === 'stdin' ? { stdin: req.prompt } : {}),
    timeoutMs: req.timeoutMs,
    ...(req.signal ? { signal: req.signal } : {}),
  });
  const outside = changedSince(before, await snapshot(wt, env));
  const parsed = parseOutput(d, p.stdout, p.stderr, p.exitCode);
  const base = {
    summary: parsed.text,
    diff: '',
    files: [],
    usage: parsed.usage,
    durationMs: p.durationMs,
    exitCode: p.exitCode,
    truncated: p.truncated,
  };
  if (outside.length > 0) {
    const shown = outside.slice(0, 5).join(', ');
    return {
      ...base,
      status: 'escaped',
      outside,
      error: `agent wrote outside its worktree: ${shown}`,
    };
  }
  const stop = stopped(p, parsed.rateLimited, parsed.error, d);
  if (stop) return { ...base, ...stop };
  const diff = await worktreeDiff(wt, env);
  const problem = diffProblem(diff);
  if (problem) return { ...base, status: 'refused', error: problem };
  return { ...base, status: 'ok', diff, files: diffFiles(diff) };
}

/** Why a finished process gives no usable work, if it does not. */
function stopped(
  p: SpawnResult,
  rateLimited: boolean,
  flagged: boolean,
  d: AgentDescriptor,
): { status: AgentRunStatus; error: string } | undefined {
  if (p.cancelled) return { status: 'cancelled', error: 'cancelled' };
  if (p.timedOut) return { status: 'timeout', error: `${d.id} ran out of time` };
  if (p.spawnError !== undefined)
    return { status: 'failed', error: `${d.binary} could not start: ${p.spawnError}` };
  if (rateLimited) return { status: 'rate_limited', error: `${d.id}: rate limit or quota reached` };
  if (p.exitCode !== 0 || flagged) {
    const tail = sanitize(p.stderr).trim().slice(-300);
    return {
      status: 'failed',
      error: `${d.id} failed (exit ${p.exitCode})${tail ? `: ${tail}` : ''}`,
    };
  }
  return undefined;
}

/** True when the agent's binary starts and answers its version arguments. */
export async function detectAgent(
  d: AgentDescriptor,
  env: Env,
  scrub: readonly string[],
): Promise<{ available: boolean; reason: string }> {
  const p = await runProcess({
    binary: d.binary,
    args: d.versionArgs,
    cwd: tmpdir(),
    env: agentEnv(env, [...scrub, ...d.scrubEnv]),
    timeoutMs: 10_000,
  });
  if (p.exitCode === 0) return { available: true, reason: `${d.binary} found` };
  return { available: false, reason: p.spawnError ?? `${d.binary} exited with ${p.exitCode}` };
}
