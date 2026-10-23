/**
 * Unified memory at the kernel boundary (ADR-0027). For each plan the kernel reads the user,
 * project and session layers (`$KPAI_HOME`) and the repository's exported
 * `.kpstudio/memory.md` (untrusted, like the R-306 rule files), and builds two versions of
 * one `user` message of DATA: the cloud version, put in front of every node, and the local
 * version, which also holds the `local-only` facts. The adapter wrapper swaps in the local
 * version only for `kind: local` providers, so a local-only fact never reaches the cloud.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatRequest, ProviderAdapter } from '@kernelpai/core';
import type { AdapterResolver } from '@kernelpai/executor';
import {
  DEFAULT_MEMORY_TOKENS,
  MemoryStore,
  buildMemoryContext,
  parseMemory,
  screenFact,
  type Fact,
  type InjectedFact,
  type MemoryContext,
  type MemoryOrigin,
  type MemorySource,
} from '@kernelpai/memory';
import { isInside, secretValues, type ZoneSet } from '@kernelpai/tools';
import { kpaiHome, type Env } from './env.js';
import { folderKey } from './packs.js';

/** The exported project memory, read back as untrusted repository content. */
export const REPO_MEMORY_FILE = '.kpstudio/memory.md';
const REPO_MEMORY_MAX_BYTES = 64 * 1024;

/** How models are told they may propose facts; a human confirms each one. */
export const PROPOSAL_HINT =
  'When your task is to write or change something (not to review, judge or vote), you may ' +
  'propose facts worth remembering (a convention, a decision, a past mistake, a preference): ' +
  'end your answer with a ```memory block of "- [project] fact" items (or [user], [session]; ' +
  'add local-only for facts that must stay on this machine). At most 5, one line each, no ' +
  'secrets or credential paths. A human confirms each one before it is kept.';

/** What the plan shows about memory: counts, ids and sources, never the facts' text. */
export interface MemorySummary {
  layers: Array<{
    origin: MemoryOrigin;
    facts: number;
    included: number;
    untrusted: number;
    localOnly: number;
    /** Facts a cloud provider could get that the budget left out. */
    omitted: number;
  }>;
  /** What every cloud-bound call gets, in order. */
  included: InjectedFact[];
  budgetTokens: number;
  usedTokens: number;
  /** Facts left out by the budget. */
  omitted: number;
  truncated: boolean;
  /** Local-only facts given to local providers only. */
  localOnly: number;
  /** True when `$KPAI_HOME` is inside the workspace: every fact is then untrusted. */
  distrusted: boolean;
  /** Proposals waiting for a human. */
  pending: number;
  problems: string[];
}

export interface LoadedMemory {
  /** The message every node gets (cloud-safe); empty when memory is off. */
  cloud: string;
  /** The same with local-only facts, for `kind: local` providers. */
  local: string;
  /** The facts without the proposal hint (for the model planner). */
  context: string;
  summary: MemorySummary;
}

export const NO_MEMORY: LoadedMemory = {
  cloud: '',
  local: '',
  context: '',
  summary: {
    layers: [],
    included: [],
    budgetTokens: 0,
    usedTokens: 0,
    omitted: 0,
    truncated: false,
    localOnly: 0,
    distrusted: false,
    pending: 0,
    problems: [],
  },
};

/** `KPAI_MEMORY_TOKENS`: the memory budget per call; 0 turns memory off. */
export function memoryBudget(env: Env): number {
  const raw = env['KPAI_MEMORY_TOKENS']?.trim();
  if (!raw) return DEFAULT_MEMORY_TOKENS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    throw new Error(`KPAI_MEMORY_TOKENS must be a non-negative integer, got "${raw}"`);
  return n;
}

export function memoryStore(env: Env, zones?: ZoneSet): MemoryStore {
  return new MemoryStore({
    home: kpaiHome(env),
    secrets: secretValues(env),
    ...(zones ? { zones } : {}),
  });
}

/**
 * The exported file, if any: no symlink, size-capped, each fact screened (redacted, zones)
 * like a fact being stored. Facts already in the project layer are not repeated.
 */
async function repoFacts(root: string, zones: ZoneSet, known: readonly Fact[]): Promise<Fact[]> {
  const dir = join(root, '.kpstudio');
  const file = join(root, REPO_MEMORY_FILE);
  for (const p of [dir, file]) {
    const st = await lstat(p).catch(() => undefined);
    if (!st || st.isSymbolicLink()) return [];
  }
  const text = (await readFile(file)).subarray(0, REPO_MEMORY_MAX_BYTES).toString('utf8');
  const seen = new Set(known.map((f) => `${f.id}\n${f.text}`));
  return parseMemory(text, 'project').lines.flatMap((l) => {
    if (l.kind !== 'fact' || seen.has(`${l.fact.id}\n${l.fact.text}`)) return [];
    try {
      return [{ ...l.fact, text: screenFact(l.fact.text, { zones }) }];
    } catch {
      return [];
    }
  });
}

/** True when model tools could have written the memory files (`$KPAI_HOME` in the jail). */
async function homeInJail(env: Env, root: string): Promise<boolean> {
  const real = async (p: string): Promise<string> => realpath(p).catch(() => p);
  return isInside(await real(root), await real(kpaiHome(env)));
}

async function sources(
  env: Env,
  root: string,
  sessionId: string,
  zones: ZoneSet,
): Promise<{ sources: MemorySource[]; problems: string[]; pending: number }> {
  const store = memoryStore(env, zones);
  const repo = await folderKey(root);
  const layers = await Promise.all([
    store.list({ layer: 'user' }),
    store.list({ layer: 'project', repo }),
    store.list({ layer: 'session', sessionId }),
  ]);
  const problems = layers.flatMap((l) =>
    l.problems.map((p) => `${l.scope.layer} memory line ${p.line}: ${p.message}`),
  );
  const fromRepo = await repoFacts(root, zones, layers[1].facts).catch((err: unknown) => {
    problems.push(
      `${REPO_MEMORY_FILE} not read: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  });
  const out: MemorySource[] = layers.map((l) => ({ origin: l.scope.layer, facts: l.facts }));
  out.push({ origin: 'repository', facts: fromRepo });
  return { sources: out, problems, pending: (await store.pending()).length };
}

function summarize(
  src: readonly MemorySource[],
  cloud: MemoryContext,
  extra: Pick<MemorySummary, 'distrusted' | 'pending' | 'problems'>,
): MemorySummary {
  const layers = src
    .filter((s) => s.facts.length > 0)
    .map((s) => {
      const mine = cloud.included.filter((f) => f.origin === s.origin);
      const localOnly = s.facts.filter((f) => f.provenance.localOnly).length;
      return {
        origin: s.origin,
        facts: s.facts.length,
        included: mine.length,
        untrusted: mine.filter((f) => f.trust === 'untrusted').length,
        localOnly,
        omitted: s.facts.length - localOnly - mine.length,
      };
    });
  return {
    layers,
    included: cloud.included,
    budgetTokens: cloud.budgetTokens,
    usedTokens: cloud.usedTokens,
    omitted: cloud.omitted,
    truncated: cloud.omitted > 0,
    localOnly: cloud.withheld,
    ...extra,
  };
}

/** The memory of a run: what every node gets, and the summary the plan shows. */
export async function loadMemory(
  env: Env,
  root: string,
  sessionId: string,
  zones: ZoneSet,
  say: (text: string) => void,
): Promise<LoadedMemory> {
  try {
    const budgetTokens = memoryBudget(env);
    if (budgetTokens === 0) return NO_MEMORY;
    const s = await sources(env, root, sessionId, zones);
    const distrustAll = await homeInJail(env, root);
    const opts = { budgetTokens, distrustAll };
    const cloud = buildMemoryContext(s.sources, { ...opts, local: false });
    const local = buildMemoryContext(s.sources, { ...opts, local: true });
    const withHint = (c: MemoryContext): string =>
      [c.text, PROPOSAL_HINT].filter(Boolean).join('\n\n');
    const summary = summarize(s.sources, cloud, {
      distrusted: distrustAll,
      pending: s.pending,
      problems: s.problems,
    });
    return { cloud: withHint(cloud), local: withHint(local), context: cloud.text, summary };
  } catch (err) {
    say(`  – memory not read: ${err instanceof Error ? err.message : String(err)}\n`);
    return NO_MEMORY;
  }
}

/** A local provider's adapter: the cloud memory message is replaced by the local one. */
function localMemoryAdapter(inner: ProviderAdapter, m: LoadedMemory): ProviderAdapter {
  const swap = (req: ChatRequest): ChatRequest => ({
    ...req,
    messages: req.messages.map((x) =>
      x.role === 'user' && x.content === m.cloud ? { ...x, content: m.local } : x,
    ),
  });
  return {
    descriptor: inner.descriptor,
    capabilities: () => inner.capabilities(),
    estimate: (req) => inner.estimate(swap(req)),
    send: (req, options) => inner.send(swap(req), options),
    cancel: (id) => inner.cancel(id),
    detect: () => inner.detect(),
  };
}

/**
 * The run's resolver: as is for every provider that is not `kind: local` (they get the
 * cloud message already in the node), else wrapped to receive the local-only facts too.
 */
export function memoryResolver(resolve: AdapterResolver, m: LoadedMemory): AdapterResolver {
  if (!m.cloud || m.cloud === m.local) return resolve;
  return (ref) => {
    const a = resolve(ref);
    return a.descriptor.kind === 'local' ? localMemoryAdapter(a, m) : a;
  };
}
