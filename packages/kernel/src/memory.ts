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
import type { ChatMessage, ChatRequest, ProviderAdapter } from '@kernelpai/core';
import type { AdapterResolver } from '@kernelpai/executor';
import type { Journal, JournalEventInput } from '@kernelpai/journal';
import { NODE_RECORDED } from '@kernelpai/orchestrator';
import {
  DEFAULT_MEMORY_TOKENS,
  LocalTaint,
  MemoryStore,
  REPOSITORY_PROVENANCE,
  buildMemoryContext,
  localOnlyRedactor,
  parseMemory,
  redactDeep,
  screenFact,
  type Fact,
  type Guard,
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
  'If you write or change something (not review/judge/vote), you may end with a ```memory ' +
  'block of facts to keep (convention, decision, mistake, preference), one "- [project] fact" ' +
  'per line ([user], [session] too; add local-only to keep it on this machine). Max 5, no ' +
  'secrets or credential paths. A human confirms each.';

/** The hint's cost on every write-type call, as the memory budget counts it (ADR-0027). */
export const PROPOSAL_HINT_MAX_TOKENS = 80;

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
  /**
   * Set when local-only facts exist: the routing restriction they put on the run (P4-F3,
   * ADR-0027 §6), shown with the plan and journaled with it.
   */
  localOnlyRule?: string;
}

/** The restriction local-only facts put on a run, as the plan states it. */
export const LOCAL_ONLY_RULE =
  'local-only facts are given to local providers only; a node a local provider serves, and ' +
  'every node depending on it, keeps its later steps (critics, judges, voters, revisions) on ' +
  'local providers, or fails with the reason; quotes of these facts are withheld from other ' +
  'providers and from the journal';

export interface LoadedMemory {
  /** The message every node gets (cloud-safe); empty when memory is off. */
  cloud: string;
  /** The same with local-only facts, for `kind: local` providers. */
  local: string;
  /** The facts without the proposal hint (for the model planner). */
  context: string;
  summary: MemorySummary;
  /**
   * The text of every local-only fact (screened), for redaction before anything reaches a
   * non-local provider or the journal (P4-F3). Never shown, journaled or sent to the cloud.
   */
  localOnlyTexts?: readonly string[];
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
 * The exported file, if any: no symlink, size-capped, each fact screened (redacted with the
 * environment's secret values, zones) like a fact being stored (P4-F8). What the file says
 * about provenance is ignored: source `repository`, no date or evidence, never local-only
 * (P4-F1). Facts already in the project layer are not repeated.
 */
async function repoFacts(root: string, guard: Guard, known: readonly Fact[]): Promise<Fact[]> {
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
      const text = screenFact(l.fact.text, guard);
      return [{ ...l.fact, text, provenance: { ...REPOSITORY_PROVENANCE }, extra: {} }];
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
  guard: Guard & { zones: ZoneSet },
): Promise<{ sources: MemorySource[]; problems: string[]; pending: number }> {
  const zones = guard.zones;
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
  const fromRepo = await repoFacts(root, guard, layers[1].facts).catch((err: unknown) => {
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
    const guard = { zones, secrets: secretValues(env) };
    const s = await sources(env, root, sessionId, guard);
    const distrustAll = await homeInJail(env, root);
    // Every fact is screened again as it is injected (hand edits, today's zones: P4-F1).
    const opts = { budgetTokens, distrustAll, guard };
    const cloud = buildMemoryContext(s.sources, { ...opts, local: false });
    const local = buildMemoryContext(s.sources, { ...opts, local: true });
    const withHint = (c: MemoryContext): string =>
      [c.text, PROPOSAL_HINT].filter(Boolean).join('\n\n');
    const refused = local.refused
      ? [`${local.refused} fact(s) refused at injection (forbidden zone, size or empty)`]
      : [];
    const summary = summarize(s.sources, cloud, {
      distrusted: distrustAll,
      pending: s.pending,
      problems: [...s.problems, ...refused],
    });
    const texts = localOnlyTexts(s.sources, guard);
    if (texts.length > 0) {
      summary.localOnlyRule = LOCAL_ONLY_RULE;
      say(`  – memory: ${texts.length} local-only fact(s): ${LOCAL_ONLY_RULE}\n`);
    }
    return {
      cloud: withHint(cloud),
      local: withHint(local),
      context: cloud.text,
      summary,
      localOnlyTexts: texts,
    };
  } catch (err) {
    say(`  – memory not read: ${err instanceof Error ? err.message : String(err)}\n`);
    return NO_MEMORY;
  }
}

/** The screened text of every local-only fact of the run's layers. */
function localOnlyTexts(src: readonly MemorySource[], guard: Guard): string[] {
  return src.flatMap((s) =>
    s.facts.flatMap((f) => {
      if (!f.provenance.localOnly) return [];
      try {
        return [screenFact(f.text, guard)];
      } catch {
        return [];
      }
    }),
  );
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

/** A non-local provider's adapter: every quote of a local-only fact is withheld (P4-F3). */
function redactingAdapter(inner: ProviderAdapter, redact: (t: string) => string): ProviderAdapter {
  const clean = (m: ChatMessage): ChatMessage => redactDeep(m, redact);
  const swap = (req: ChatRequest): ChatRequest => ({ ...req, messages: req.messages.map(clean) });
  return {
    descriptor: inner.descriptor,
    capabilities: () => inner.capabilities(),
    estimate: (req) => inner.estimate(swap(req)),
    send: (req, options) => inner.send(swap(req), options),
    cancel: (id) => inner.cancel(id),
    detect: () => inner.detect(),
  };
}

export function hasLocalOnly(m: LoadedMemory): boolean {
  return (m.localOnlyTexts?.length ?? 0) > 0 || (m.cloud !== '' && m.cloud !== m.local);
}

/**
 * The run's resolver. A `kind: local` provider gets the local-only facts (the cloud message
 * swapped for the local one). Every other provider gets the cloud message already in the
 * node, and, when local-only facts exist, requests with every quote of one withheld: what
 * a local step wrote (dependency outputs, reviews, tool results) is not trusted to be free
 * of them (P4-F3, defence in depth behind the taint).
 */
export function memoryResolver(resolve: AdapterResolver, m: LoadedMemory): AdapterResolver {
  if (!hasLocalOnly(m)) return resolve;
  const redact = localOnlyRedactor(m.localOnlyTexts ?? []);
  const swapLocal = m.cloud !== '' && m.cloud !== m.local;
  return (ref) => {
    const a = resolve(ref);
    if (a.descriptor.kind === 'local') return swapLocal ? localMemoryAdapter(a, m) : a;
    return redactingAdapter(a, redact);
  };
}

/**
 * What a replay or fork knows before it starts (P4-R1): the recorded graph and the nodes
 * whose recorded output may quote local-only facts. Seeded, they taint the nodes after them.
 */
export interface TaintSeed {
  nodes: ConstructorParameters<typeof LocalTaint>[0];
  ids: readonly string[];
}

/**
 * Taint (P4-F3): once local-only facts exist, a node one of whose calls went to a local
 * provider, and every node depending on it, keeps all later steps on local providers
 * (`nodeConstraints`), or fails closed with the reason. A seed (P4-R1) marks recorded nodes
 * tainted from the start, and keeps the taint on even if today's memory has no such fact.
 */
export function localTaint(
  m: LoadedMemory,
  nodes: ConstructorParameters<typeof LocalTaint>[0],
  seed?: TaintSeed,
): LocalTaint {
  const ids = seed?.ids ?? [];
  const taint = new LocalTaint(seed?.nodes ?? nodes, hasLocalOnly(m) || ids.length > 0);
  for (const id of ids) taint.observe(id, true);
  return taint;
}

export function taintConstraint(
  taint: LocalTaint,
): (nodeId: string) => { constraints: { localOnly: true }; reason: string } | undefined {
  return (nodeId) => {
    const from = taint.source(nodeId);
    if (from === undefined) return undefined;
    const via = from === nodeId ? '' : ` (through node ${from})`;
    return {
      constraints: { localOnly: true },
      reason:
        `node ${nodeId} has seen local-only memory facts${via}: its later steps run on ` +
        'local providers only (ADR-0027 §6); add a local provider, or mark the facts shareable',
    };
  };
}

/**
 * The run's journal: calls to a local provider taint their node, a tainted node's record is
 * marked `localTaint` (so its replays and forks know, P4-R1), and every payload has the
 * quotes of local-only facts withheld before it is written (P4-F3).
 */
export function memoryJournal(
  journal: Journal,
  m: LoadedMemory,
  taint: LocalTaint,
  isLocal: (provider: string) => boolean,
): Journal {
  if (!taint.active) return journal;
  const redact = localOnlyRedactor(m.localOnlyTexts ?? []);
  const mark = (input: JournalEventInput): JournalEventInput['payload'] =>
    input.type === 'intervention' &&
    input.payload['action'] === NODE_RECORDED &&
    input.nodeId !== undefined &&
    taint.source(input.nodeId) !== undefined
      ? { ...input.payload, localTaint: true }
      : input.payload;
  return new Proxy(journal, {
    get: (target, prop) => {
      if (prop === 'append') {
        return (input: JournalEventInput) => {
          if (input.type === 'call' && input.nodeId && input.provider)
            taint.observe(input.nodeId, isLocal(input.provider));
          return target.append({ ...input, payload: redactDeep(mark(input), redact) });
        };
      }
      const v: unknown = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
