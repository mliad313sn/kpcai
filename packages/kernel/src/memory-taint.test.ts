/**
 * Review P4-F3 and P4-F1/F8 at the kernel: a local model that saw local-only facts may
 * quote them, so its node (critics too) and its dependents stay on local providers or fail
 * closed, and every quote is withheld from non-local providers and from the journal.
 * Offline: mock providers, one wrapped to echo the memory message it receives.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRequest, ProviderAdapter, ProviderDescriptor } from '@kernelpai/core';
import { MemoryStore, LOCAL_ONLY_MARK } from '@kernelpai/memory';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { LOCAL_ONLY_RULE, localTaint, memoryJournal, memoryResolver } from './memory.js';
import { queueProposals } from './memory-proposals.js';
import { folderKey } from './packs.js';
import { TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const ASK = 'summarize the architecture of this repository';
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;
const SECRET = 'Staging host is vpn-only-7731.corp behind the bastion';
const MARKER = 'vpn-only-7731';

function provider(home: string, id: string, kind: string, analysis: number, critique: number) {
  writeFileSync(
    join(home, 'providers', `${id}.yaml`),
    [
      `id: ${id}`,
      `name: ${id}`,
      `kind: ${kind}`,
      'adapter: mock',
      'baseUrl: http://127.0.0.1:9',
      `jurisdiction: ${kind === 'local' ? 'local' : 'US'}`,
      'retention: none',
      'models:',
      '  - id: m1',
      '    contextWindow: 32000',
      '    maxOutput: 4096',
      '    modalities: [text, code]',
      '    price: { inputPerMTok: 0, outputPerMTok: 0 }',
      `    competence: { code_generation: 0.5, test: 0.5, writing: 0.5, critique: ${critique}, analysis: ${analysis}, research: 0.5, decision: 0.5 }`,
      '',
    ].join('\n'),
  );
}

/** Wraps an adapter so it first writes back the memory message it was given. */
function echoing(inner: ProviderAdapter): ProviderAdapter {
  return {
    ...inner,
    descriptor: inner.descriptor,
    capabilities: () => inner.capabilities(),
    estimate: (req) => inner.estimate(req),
    async *send(req, options) {
      const memory = req.messages.find(
        (m) => typeof m.content === 'string' && m.content.startsWith('KernelPAI memory'),
      );
      yield { type: 'text', delta: `I was told: ${String(memory?.content)}\n` };
      yield* inner.send(req, options);
    },
  };
}

interface Seen {
  /** Every request a non-local adapter was sent, as text. */
  cloud: string[];
}

/** A kernel whose plan's registry echoes on `echo` and records what non-local providers get. */
async function setup(host: RecordingHost, echo: string) {
  const s = new MemoryStore({ home: host.home });
  await s.add({ layer: 'project', repo: await folderKey(host.cwd) }, SECRET, { localOnly: true });
  await s.add({ layer: 'project', repo: await folderKey(host.cwd) }, 'Use pnpm, never npm');
  const k = new Kernel(host);
  const p = await k.plan(ASK, IN_PLACE);
  const seen: Seen = { cloud: [] };
  const reg = p.setup.registry;
  const real = reg.get.bind(reg);
  reg.get = (id: string): ProviderAdapter => {
    const a = real(id);
    if (id === echo) return echoing(a);
    if (a.descriptor.kind === 'local') return a;
    return {
      ...a,
      descriptor: a.descriptor,
      capabilities: () => a.capabilities(),
      estimate: (req) => a.estimate(req),
      send: (req: ChatRequest, o) => {
        seen.cloud.push(JSON.stringify(req.messages));
        return a.send(req, o);
      },
    };
  };
  const base = p.graph.nodes[0]!;
  const node = (id: string, dependsOn: string[], protocol: string) => ({
    ...base,
    id,
    title: id,
    type: 'analysis',
    deliverable: 'answer',
    dependsOn,
    protocol,
  });
  const graph = { ...p.graph, nodes: [node('a', [], 'author_critic'), node('b', ['a'], 'solo')] };
  const h = await k.startRun({ request: ASK, planId: p.planId, graph, options: IN_PLACE });
  const o = await h.done;
  const journal = k
    .sessions(50)
    .flatMap((x) => k['journal'].events({ sessionId: x.id, limit: 100_000 }));
  return { k, o, seen, journal };
}

describe('P4-F3: local-only facts stay local after a local model saw them', () => {
  it('fails closed when no other local provider can review: no cloud critic, nothing journaled', async () => {
    const host = recordingHost(CHEAP);
    provider(host.home, 'mock-local1', 'local', 0.99, 0.1);
    provider(host.home, 'mock-cloud', 'cloud', 0.1, 0.99);
    const { k, o, seen, journal } = await setup(host, 'mock-local1');
    const r = o.status === 'finished' ? o.result.results : {};
    expect(r['a']!.contributions[0]!.ref.provider).toBe('mock-local1');
    expect(r['a']!.contributions.some((c) => c.role === 'critic')).toBe(false);
    expect(r['a']!.ok).toBe(false);
    expect(r['a']!.error).toMatch(/node a has seen local-only memory facts/);
    expect(seen.cloud.join('\n')).not.toContain(MARKER);
    const raw = JSON.stringify(journal);
    expect(raw).not.toContain(MARKER);
    expect(raw).toContain(LOCAL_ONLY_MARK);
    await k.close();
  });

  it('keeps the critic and every dependent node on local providers when it can', async () => {
    const host = recordingHost(CHEAP);
    provider(host.home, 'mock-local1', 'local', 0.99, 0.1);
    provider(host.home, 'mock-local2', 'local', 0.2, 0.5);
    provider(host.home, 'mock-cloud', 'cloud', 0.9, 0.99);
    const { k, o, seen, journal } = await setup(host, 'mock-local1');
    const r = o.status === 'finished' ? o.result.results : {};
    expect(r['a']!.ok).toBe(true);
    const plan = journal.find((e) => e.type === 'routing' && e.payload['memory']);
    expect(plan!.payload['memory']).toMatchObject({ localOnlyRule: LOCAL_ONLY_RULE });
    expect(host.said.join('')).toContain(`1 local-only fact(s): ${LOCAL_ONLY_RULE}`);
    const providers = ['a', 'b'].flatMap((id) => r[id]!.contributions.map((c) => c.ref.provider));
    expect(providers).toContain('mock-local2');
    expect(providers.every((x) => x.startsWith('mock-local'))).toBe(true);
    expect(seen.cloud.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify(journal)).not.toContain(MARKER);
    await k.close();
  });
});

describe('P4-F3: defence in depth', () => {
  const m = {
    cloud: 'cloud memory',
    local: `local memory: ${SECRET}`,
    context: '',
    summary: {} as never,
    localOnlyTexts: [SECRET],
  };

  it('withholds every quote from a non-local provider, not from a local one', async () => {
    const got: Record<string, string> = {};
    const adapter = (kind: ProviderDescriptor['kind']): ProviderAdapter =>
      ({
        descriptor: { id: kind, kind } as ProviderDescriptor,
        capabilities: () => [],
        estimate: () => ({ inputTokens: 1 }) as never,
        send: (req: ChatRequest) => {
          got[kind] = JSON.stringify(req.messages);
          return (async function* () {})();
        },
      }) as unknown as ProviderAdapter;
    const resolve = memoryResolver((ref) => adapter(ref.provider as 'local'), m);
    const quoted = `Upstream said: the STAGING host is  vpn-only-7731.corp behind`;
    for (const kind of ['cloud', 'local', 'test']) {
      const a = resolve({ provider: kind, model: 'm1' });
      for await (const _ of a.send({ model: 'm1', messages: [{ role: 'user', content: quoted }] }))
        void _;
    }
    expect(got['cloud']).not.toContain(MARKER);
    expect(got['cloud']).toContain(LOCAL_ONLY_MARK);
    expect(got['test']).not.toContain(MARKER);
    expect(got['local']).toContain(MARKER);
  });

  it('withholds quotes from journal payloads and taints on local calls', () => {
    const written: unknown[] = [];
    const journal = { append: (e: unknown) => (written.push(e), e), x: 1 } as never;
    const taint = localTaint(m, [{ id: 'n', dependsOn: [] }]);
    const j = memoryJournal(journal, m, taint, (p) => p === 'loc');
    j.append({ sessionId: 's', type: 'call', nodeId: 'n', provider: 'cloud', payload: {} });
    expect(taint.source('n')).toBeUndefined();
    j.append({ sessionId: 's', type: 'call', nodeId: 'n', provider: 'loc', payload: {} });
    j.append({ sessionId: 's', type: 'response', payload: { text: `x ${SECRET} y` } });
    expect(taint.source('n')).toBe('n');
    expect(JSON.stringify(written)).not.toContain(MARKER);
    expect((j as unknown as { x: number }).x).toBe(1);
    const none = { ...m, local: m.cloud, localOnlyTexts: [] };
    // Nothing to protect (no local-only fact, no seeded taint): the journal as it is.
    const idle = localTaint(none, [{ id: 'n', dependsOn: [] }]);
    expect(memoryJournal(journal, none, idle, () => true)).toBe(journal);
  });
});

describe('P4-F3: proposals of a tainted node', () => {
  it('are kept local-only, whatever the model tagged', async () => {
    const host = recordingHost(CHEAP);
    const kinds: Record<string, string> = { loc: 'local', cl: 'cloud' };
    const plan = {
      sessionId: 's',
      packs: { selected: [], approved: [] },
      graph: {
        nodes: [
          { id: 'a', dependsOn: [] },
          { id: 'b', dependsOn: ['a'] },
          { id: 'c', dependsOn: [] },
        ],
      },
      setup: { registry: { get: (id: string) => ({ descriptor: { kind: kinds[id] } }) } },
      memory: { cloud: 'c', local: 'l', context: '', summary: {}, localOnlyTexts: [SECRET] },
    } as never;
    const journal = { append: () => undefined } as never;
    const ctx = { env: host.env, cwd: host.cwd, journal, runId: 'r', plan };
    const node = (nodeId: string, provider: string, fact: string) => ({
      nodeId,
      protocol: 'solo',
      output: ['done', '```memory', `- [project] ${fact}`, '```'].join('\n'),
      contributions: [{ role: 'solo', ref: { provider, model: 'm1' }, text: '', costUsd: 0 }],
      costUsd: 0,
      ok: true,
    });
    const result = {
      graphId: 'g',
      states: {},
      costUsd: 0,
      ok: true,
      results: {
        a: node('a', 'loc', 'The bastion is the only way in'),
        b: node('b', 'cl', 'Deploys go through the bastion host'),
        c: node('c', 'cl', 'Docs live in docs/'),
      },
    } as never;
    expect(await queueProposals(ctx, result)).toHaveLength(3);
    const pending = await new MemoryStore({ home: host.home }).pending();
    const local = Object.fromEntries(
      pending.map((p) => [p.provenance.evidence[1], p.provenance.localOnly]),
    );
    expect(local).toEqual({ 'node:a': true, 'node:b': true, 'node:c': false });
  });
});
