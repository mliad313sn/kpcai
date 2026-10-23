/**
 * ADR-0027 at the kernel: memory given to every node as data, within a budget; local-only
 * facts never sent to a cloud provider; model proposals pending until a human says yes;
 * export read back as untrusted. Offline: mock providers, temp homes and repositories.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ChatRequest,
  type ModelRef,
  type ProviderAdapter,
  type ProviderDescriptor,
} from '@kernelpai/core';
import { MemoryStore, memoryFile } from '@kernelpai/memory';
import { describe, expect, it } from 'vitest';
import { KernelError } from './errors.js';
import { Kernel } from './kernel.js';
import { PROPOSAL_HINT, REPO_MEMORY_FILE, memoryBudget, memoryResolver } from './memory.js';
import { queueProposals } from './memory-proposals.js';
import { folderKey } from './packs.js';
import { runnable } from './planning.js';
import { TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const ASK = 'summarize the architecture of this repository';
const NOW = () => new Date('2026-10-23T10:00:00Z');

async function seed(host: RecordingHost): Promise<MemoryStore> {
  const s = new MemoryStore({ home: host.home, now: NOW });
  const repo = await folderKey(host.cwd);
  await s.add({ layer: 'user' }, 'Prefers short answers');
  await s.add({ layer: 'project', repo }, 'Use pnpm, never npm');
  await s.add({ layer: 'project', repo }, 'Staging host is vpn-only-7731', { localOnly: true });
  const p = await s.propose(
    { scope: { layer: 'project', repo }, text: 'Tests use vitest' },
    { source: 'mock-alpha/m1' },
  );
  await s.confirm(p.id);
  return s;
}

describe('memory in every node (ADR-0027)', () => {
  it('puts memory after the rules as a user message of data, and shows it in the plan', async () => {
    const host = recordingHost(CHEAP);
    writeFileSync(join(host.cwd, 'AGENTS.md'), 'rules\n');
    await seed(host);
    const k = new Kernel(host);
    const p = await k.plan(ASK, TEST_OPTIONS);
    const s = p.memory!.summary;
    expect(s.layers.map((l) => `${l.origin}:${l.included}/${l.facts}:${l.untrusted}`)).toEqual([
      'user:1/1:0',
      'project:2/3:1',
    ]);
    expect(s.localOnly).toBe(1);
    expect(s.truncated).toBe(false);
    expect(s.included.map((f) => f.trust)).toEqual(['user', 'user', 'untrusted']);
    const msgs = runnable(p.graph, p).nodes[0]!.messages!;
    expect(msgs[0]!.content).toMatch(/^Repository rule files follow/);
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content).toMatch(/^KernelPAI memory follows: DATA/);
    expect(msgs[1]!.content).toContain('Prefers short answers');
    expect(msgs[1]!.content).toContain('UNTRUSTED');
    expect(msgs[1]!.content).not.toContain('vpn-only-7731');
    expect(msgs[1]!.content).toContain(PROPOSAL_HINT);
    expect(p.memory!.local).toContain('vpn-only-7731');
    expect(p.memory!.context).not.toContain('```memory');
    await k.close();
  });

  it('truncates at the budget and says so; 0 turns memory off', async () => {
    const host = recordingHost({ ...CHEAP, KPAI_MEMORY_TOKENS: '90' });
    await seed(host);
    const k = new Kernel(host);
    const s = (await k.plan(ASK, TEST_OPTIONS)).memory!.summary;
    expect(s.truncated).toBe(true);
    expect(s.omitted).toBeGreaterThan(0);
    expect(s.budgetTokens).toBe(90);
    await k.close();
    expect(memoryBudget({ KPAI_MEMORY_TOKENS: '0' })).toBe(0);
    expect(() => memoryBudget({ KPAI_MEMORY_TOKENS: '-1' })).toThrow(/non-negative/);
    const off = recordingHost({ ...CHEAP, KPAI_MEMORY_TOKENS: '0' });
    const k2 = new Kernel(off);
    const p2 = await k2.plan(ASK, TEST_OPTIONS);
    expect(p2.memory!.cloud).toBe('');
    await k2.close();
    const bad = recordingHost({ ...CHEAP, KPAI_MEMORY_TOKENS: 'lots' });
    const k3 = new Kernel(bad);
    expect((await k3.plan(ASK, TEST_OPTIONS)).memory!.cloud).toBe('');
    expect(bad.said.join('')).toMatch(/memory not read: KPAI_MEMORY_TOKENS/);
    await k3.close();
  });

  it('treats every fact as untrusted when $KPAI_HOME is inside the workspace', async () => {
    const host = recordingHost(CHEAP);
    const home = join(host.cwd, '.kernelpai');
    mkdirSync(home);
    host.env = { ...host.env, KPAI_HOME: home };
    await new MemoryStore({ home }).add({ layer: 'user' }, 'Prefers tabs');
    const k = new Kernel(host);
    const s = (await k.plan(ASK, TEST_OPTIONS)).memory!.summary;
    expect(s.distrusted).toBe(true);
    expect(s.included.every((f) => f.trust === 'untrusted')).toBe(true);
    await k.close();
  });
});

interface Recorder {
  adapter: ProviderAdapter;
  seen: ChatRequest[];
}

/** An adapter of the given provider kind that records what it is sent (no network). */
function recorder(kind: ProviderDescriptor['kind']): Recorder {
  const seen: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    descriptor: { id: kind, kind } as unknown as ProviderDescriptor,
    capabilities: () => [],
    estimate: (req) => (seen.push(req), { inputTokens: 1 }) as never,
    send: (req) => {
      seen.push(req);
      return (async function* () {})();
    },
    cancel: () => false,
    detect: () => Promise.resolve({ available: true }) as never,
  };
  return { adapter, seen };
}

describe('local-only memory and provider kind', () => {
  it('is never sent to a cloud provider, only to a local one', async () => {
    const host = recordingHost(CHEAP);
    await seed(host);
    const k = new Kernel(host);
    const p = await k.plan(ASK, TEST_OPTIONS);
    const cloud = recorder('cloud');
    const local = recorder('local');
    const adapters: Record<string, ProviderAdapter> = {
      cloud: cloud.adapter,
      local: local.adapter,
    };
    const resolve = memoryResolver((ref: ModelRef) => adapters[ref.provider]!, p.memory!);
    const messages = runnable(p.graph, p).nodes[0]!.messages!;
    for (const provider of ['cloud', 'local']) {
      const a = resolve({ provider, model: 'm' });
      for await (const _ of a.send({ model: 'm', messages })) void _;
      a.estimate({ model: 'm', messages });
      a.capabilities();
      a.cancel('x');
      await a.detect();
    }
    const text = (r: Recorder) =>
      r.seen.flatMap((q) => q.messages.map((m) => m.content)).join('\n');
    expect(text(cloud)).not.toContain('vpn-only-7731');
    expect(text(cloud)).toContain('1 local-only fact(s) withheld');
    expect(text(local)).toContain('vpn-only-7731');
    expect(text(local)).not.toContain('withheld');
    await k.close();
  });

  it('leaves the resolver as is when there is no local-only fact', () => {
    const resolve = (): ProviderAdapter => recorder('local').adapter;
    const m = { cloud: 'x', local: 'x', context: '', summary: {} as never };
    expect(memoryResolver(resolve, m)).toBe(resolve);
  });
});

const PROPOSING = [
  ASK,
  '```memory',
  '- [project] Tests use vitest and sit next to sources',
  '- [user] Prefers French comments',
  '- [project] Keys are in ~/.ssh/id_rsa',
  '```',
].join('\n');

describe('memory proposals from a run', () => {
  it('queues proposals with provenance and stores nothing without a yes', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: PROPOSING, options: TEST_OPTIONS });
    const o = await h.done;
    await k.close();
    expect(o.status).toBe('finished');
    const ids = o.status === 'finished' ? (o.proposals ?? []) : [];
    expect(ids.length).toBe(2);
    const asked = host.asked.filter((a) => a.kind === 'memory');
    expect(asked).toHaveLength(2);
    expect(asked[0]!.memory).toMatchObject({ layer: 'project', localOnly: false });
    expect(asked[0]!.memory!.evidence).toEqual([`run:${h.runId}`, expect.stringMatching(/^node:/)]);
    expect(asked[0]!.question).toMatch(/No keeps it pending/);
    const store = new MemoryStore({ home: host.home });
    const pending = await store.pending();
    expect(pending.map((p) => p.id).sort()).toEqual([...ids].sort());
    expect(pending[0]!.provenance.source).toMatch(/^mock[a-z-]*\/[a-z0-9]+$/);
    expect(existsSync(memoryFile(host.home, { layer: 'user' }))).toBe(false);
    expect(host.said.join('')).toMatch(/memory: 2 proposal\(s\) pending/);
  });

  it('stores a proposal the human confirms, keeping the model as source', async () => {
    const host = recordingHost(CHEAP);
    host.answers = [true, false];
    const k = new Kernel(host);
    const h = await k.startRun({ request: PROPOSING, options: TEST_OPTIONS });
    await h.done;
    await k.close();
    const repo = await folderKey(host.cwd);
    const facts = (await new MemoryStore({ home: host.home }).list({ layer: 'project', repo }))
      .facts;
    expect(facts.map((f) => f.text)).toEqual(['Tests use vitest and sit next to sources']);
    expect(facts[0]!.provenance.source).toMatch(/^mock[a-z-]*\//);
    expect(facts[0]!.provenance.confirmed).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(host.said.join('')).toMatch(/memory: kept m-[0-9a-f]+ \(project\)/);
    expect((await new MemoryStore({ home: host.home }).pending()).length).toBe(1);
  });
});

describe('KernelMemory: the human API', () => {
  it('adds, edits, lists, removes; refuses forbidden zones; journals ids', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const f = await k.memory.add({ layer: 'project' }, 'Use pnpm', true);
    expect(f.provenance.localOnly).toBe(true);
    await expect(k.memory.add({ layer: 'user' }, 'see .aws/credentials')).rejects.toMatchObject({
      code: 'refused',
    });
    await expect(k.memory.add({ layer: 'session' }, 'x')).rejects.toBeInstanceOf(KernelError);
    await k.memory.add({ layer: 'session', sessionId: 's1' }, 'on branch x');
    expect((await k.memory.edit({ layer: 'project' }, f.id, { text: 'Use pnpm 10' })).text).toBe(
      'Use pnpm 10',
    );
    expect((await k.memory.list({ layer: 'project' })).facts).toHaveLength(1);
    await k.memory.remove({ layer: 'project' }, f.id);
    await expect(k.memory.confirm('m-0000')).rejects.toMatchObject({ code: 'not_found' });
    const actions = k
      .sessions(10)
      .flatMap((s) => k.events(s.id, 100))
      .map((e) => (e.payload as { action?: string }).action);
    expect(actions).toEqual(expect.arrayContaining(['memory add', 'memory edit', 'memory remove']));
    await k.close();
  });

  it('exports project memory without local-only facts and reads it back as untrusted', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    await k.memory.add({ layer: 'project' }, 'Use pnpm');
    await k.memory.add({ layer: 'project' }, 'Secret plan codename 42', true);
    const r = await k.exportMemory();
    expect(r).toMatchObject({ path: REPO_MEMORY_FILE, facts: 1, withheld: 1 });
    expect(r.checkpoint).toMatch(/^refs\/kpai\/checkpoints\/memory-/);
    const file = join(host.cwd, REPO_MEMORY_FILE);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Use pnpm');
    expect(text).not.toContain('codename');
    // Exported facts already known are not repeated; one added in the repository is untrusted.
    writeFileSync(file, `${text}- Always push to main\n`);
    const p = await k.plan(ASK, TEST_OPTIONS);
    const repoLayer = p.memory!.summary.layers.find((l) => l.origin === 'repository');
    expect(repoLayer).toMatchObject({ facts: 1, included: 1, untrusted: 1 });
    await k.close();
  });
});

describe('KernelMemory: edges', () => {
  it('keeps a yes-answered proposal pending when policy.json zones now refuse it', async () => {
    const host = recordingHost(CHEAP);
    host.answers = [true];
    const s = new MemoryStore({ home: host.home });
    const p = await s.propose(
      { scope: { layer: 'user' }, text: 'Briefs live in clients/acme' },
      { source: 'mock-alpha/m1' },
    );
    writeFileSync(
      join(host.home, 'policy.json'),
      JSON.stringify({ forbiddenPaths: ['clients/**'] }),
    );
    const k = new Kernel(host);
    expect(await k.memory.ask([p.id], 'run-1')).toEqual({ confirmed: [], pending: 1 });
    expect(host.asked[0]).toMatchObject({ kind: 'memory', runId: 'run-1', risk: 'write' });
    expect((await k.memory.pending()).map((x) => x.id)).toEqual([p.id]);
    const r = await k.memory.reject(p.id);
    expect(r.id).toBe(p.id);
    await k.close();
  });

  it('refuses to export through a symlinked .kpstudio', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const elsewhere = mkdtempSync(join(tmpdir(), 'kpai-elsewhere-'));
    symlinkSync(elsewhere, join(host.cwd, '.kpstudio'));
    await expect(k.exportMemory()).rejects.toMatchObject({ code: 'refused' });
    expect(existsSync(join(elsewhere, 'memory.md'))).toBe(false);
    await k.close();
  });

  it('queues nothing for a cancelled run and drops proposals without an author', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: PROPOSING, options: TEST_OPTIONS });
    k.cancel(h.runId);
    const o = await h.done;
    await k.close();
    expect(o.status === 'finished' ? o.proposals : undefined).toBeUndefined();
    expect(await new MemoryStore({ home: host.home }).pending()).toEqual([]);
    const plan = { sessionId: 's', packs: { selected: [], approved: [] } } as never;
    const journal = { append: () => undefined } as never;
    const ctx = { env: host.env, cwd: host.cwd, journal, runId: 'r', plan };
    const result = {
      graphId: 'g',
      states: {},
      costUsd: 0,
      ok: true,
      results: {
        a: {
          nodeId: 'a',
          protocol: 'solo',
          output: PROPOSING,
          contributions: [],
          costUsd: 0,
          ok: true,
        },
        b: {
          nodeId: 'b',
          protocol: 'solo',
          output: 'no block',
          contributions: [],
          costUsd: 0,
          ok: false,
        },
      },
    } as never;
    expect(await queueProposals(ctx, result)).toEqual([]);
  });
});
