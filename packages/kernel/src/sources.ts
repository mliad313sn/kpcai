/**
 * Facts the kernel gives a delegate (D-028, ADR-0031, ADR-0033): where a write lands, whether
 * a step may act on a physical device, which providers a run used and from which source
 * (`local`, `api`, `subscription`). Typed fields only: a program's envelope checker reads
 * these, never the question text or a model's output.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { resolve } from 'node:path';
import type { GraphResult, ToolBus, ToolDefinition } from '@kernelpai/core';
import type { Pack } from '@kernelpai/packs';
import type { ConfirmKind, ConfirmRequest } from './confirm.js';

export type SourceKind = 'local' | 'api' | 'subscription';

/** True when `root` is not the workspace itself: the run writes in its own worktree. */
export function inWorktree(root: string, cwd: string): boolean {
  return resolve(root) !== resolve(cwd);
}

/** A selected pack declares physical effects (D-019): its steps may actuate a device. */
export function physicalPacks(selected: readonly Pick<Pack, 'safety'>[]): boolean {
  return selected.some((p) => p.safety?.physicalEffects === true);
}

/**
 * The source of a provider from its descriptor kind. `local` only for a local provider; an
 * agent CLI under the user's subscription (R-503) is `subscription`; anything else
 * (cloud, aggregator, test, unknown) counts as `api`: a source is never claimed local
 * unless it is.
 */
export function sourceOf(kind: string | undefined): SourceKind {
  if (kind === 'local') return 'local';
  if (kind === 'subscription' || kind === 'agent') return 'subscription';
  return 'api';
}

export interface RunSources {
  /** Providers that served a step, sorted. */
  providers: string[];
  /** Each provider's source. */
  sources: Array<{ provider: string; source: SourceKind }>;
  /** The run's source: the one kind every provider shares, else `mixed`. */
  source?: SourceKind | 'mixed';
}

/** Providers that served the run's steps (contributions), with their source. */
export function runSources(
  result: Pick<GraphResult, 'results'>,
  kindOf: (provider: string) => string | undefined,
): RunSources {
  const providers = new Set<string>();
  for (const r of Object.values(result.results ?? {}))
    for (const c of r.contributions ?? []) providers.add(c.ref.provider);
  return sourcesOf([...providers], kindOf);
}

export function sourcesOf(
  list: readonly string[],
  kindOf: (provider: string) => string | undefined,
): RunSources {
  const providers = [...new Set(list)].sort();
  const sources = providers.map((provider) => ({ provider, source: sourceOf(kindOf(provider)) }));
  const kinds = new Set(sources.map((s) => s.source));
  const one = [...kinds][0];
  const source = kinds.size === 0 ? undefined : kinds.size === 1 ? one : 'mixed';
  return { providers, sources, ...(source ? { source } : {}) };
}

/** Providers a plan routes its steps to (the estimate's chosen models), with their source. */
export function plannedSources(
  estimate: {
    nodes: ReadonlyArray<{
      ref?: { provider: string } | null;
      steps?: ReadonlyArray<{ ref: { provider: string } }>;
    }>;
  },
  kindOf: (provider: string) => string | undefined,
): RunSources {
  const list: string[] = [];
  for (const n of estimate.nodes) {
    if (n.ref) list.push(n.ref.provider);
    for (const s of n.steps ?? []) list.push(s.ref.provider);
  }
  return sourcesOf(list, kindOf);
}

/**
 * A confirmation as a program's `confirm` action (packages/program `ProposedActionSchema`):
 * typed fields only. Missing facts take the value that escalates: not in a worktree,
 * physical unknown is not claimed absent when the request says so.
 */
export function confirmFacts(req: ConfirmRequest): {
  kind: 'confirm';
  confirm: ConfirmKind;
  risk?: 'read' | 'write' | 'destructive';
  amountUsd?: number;
  inWorktree: boolean;
  physical: boolean;
} {
  return {
    kind: 'confirm',
    confirm: req.kind,
    ...(req.risk ? { risk: req.risk } : {}),
    ...(req.amountUsd !== undefined ? { amountUsd: req.amountUsd } : {}),
    inWorktree: req.inWorktree === true,
    physical: req.physical === true,
  };
}

/** Builtin tools whose writes stay inside the root they are given (jailed file and patch tools). */
export const CONFINED_TOOLS: ReadonlySet<string> = new Set(['fs.write', 'fs.delete', 'git.apply']);

/**
 * The D-028 facts of one tool confirmation in a run (WP7-F2): the tool's own risk (unknown
 * counts as destructive), and `inWorktree` only for a tool confined to the run's root. A
 * shell, test run, hook, browser or MCP call reaches past the worktree whatever the run's
 * root is, so a `write-in-worktree` pre-answer must never cover it.
 */
export function toolFacts(
  tool: Pick<ToolDefinition, 'name' | 'risk' | 'source'> | undefined,
  run: { inWorktree: boolean; physical: boolean },
): { risk: 'read' | 'write' | 'destructive'; inWorktree: boolean; physical: boolean } {
  const confined = tool?.source === 'builtin' && CONFINED_TOOLS.has(tool.name);
  return {
    risk: tool?.risk ?? 'destructive',
    inWorktree: run.inWorktree && confined,
    physical: run.physical,
  };
}

/**
 * The bus with the tool of the call in progress readable from inside it (async-safe, so
 * parallel nodes and a hook's own `shell.run` each see their own tool).
 */
export function trackedBus(inner: ToolBus): {
  bus: ToolBus;
  current(): ToolDefinition | undefined;
} {
  const calling = new AsyncLocalStorage<string>();
  return {
    bus: {
      list: () => inner.list(),
      close: () => inner.close(),
      call: (c, ctx) => calling.run(c.name, () => inner.call(c, ctx)),
    },
    current: () => {
      const name = calling.getStore();
      return name === undefined ? undefined : inner.list().find((d) => d.name === name);
    },
  };
}
