/**
 * Review P4-R1: a replay or fork keeps the taint of local-only memory. A run's
 * `architecture` node is served by a local provider while a local-only fact exists; the
 * nodes that run again after it (fork) or read it (replay) stay on local providers or fail
 * closed, and today's memory redacts what goes to the cloud. Offline: mock providers.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatRequest, ProviderAdapter } from '@kernelpai/core';
import { LOCAL_ONLY_MARK, MemoryStore } from '@kernelpai/memory';
import { readRun } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { folderKey } from './packs.js';
import type { Plan } from './types.js';
import { REQ, TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;
const FACT = 'The staging database lives on gpu-box-55217 behind the VPN';
const MARKER = 'gpu-box-55217';
const LOCALS = ['mock-local1', 'mock-local2', 'mock-local3', 'mock-local4'];

/** A `kind: local` mock; `analysis` high makes it the architecture node's author. */
function local(home: string, id: string, analysis: number): void {
  const lines = [
    `id: ${id}`,
    `name: ${id}`,
    'kind: local',
    'adapter: mock',
    'jurisdiction: US',
    'retention: none',
    'models:',
    '  - id: m1',
    '    contextWindow: 32000',
    '    maxOutput: 4096',
    '    modalities: [text, code]',
    '    price: { inputPerMTok: 0, outputPerMTok: 0 }',
    `    competence: { code_generation: 0.3, test: 0.3, writing: 0.3, critique: 0.3, analysis: ${analysis}, research: 0.3, decision: 0.3 }`,
    '',
  ];
  writeFileSync(join(home, 'providers', `${id}.yaml`), lines.join('\n'));
}

function withLocals(host: RecordingHost): void {
  LOCALS.forEach((id, i) => local(host.home, id, i === 0 ? 0.99 : 0.3));
}

async function localOnlyFact(host: RecordingHost): Promise<void> {
  const s = new MemoryStore({ home: host.home });
  await s.add({ layer: 'project', repo: await folderKey(host.cwd) }, FACT, { localOnly: true });
}

/** Providers per node of a finished run. */
function providers(o: unknown): Record<string, string[]> {
  const res = (o as { result: { results: Record<string, { contributions: unknown[] }> } }).result;
  return Object.fromEntries(
    Object.entries(res.results).map(([id, r]) => [
      id,
      [...new Set(r.contributions.map((c) => (c as { ref: { provider: string } }).ref.provider))],
    ]),
  );
}

const isLocal = (p: string): boolean => LOCALS.includes(p);

/** Records every request a non-local adapter of the plan is sent. */
function spy(plan: Pick<Plan, 'setup'>): string[] {
  const seen: string[] = [];
  const reg = plan.setup.registry;
  const real = reg.get.bind(reg);
  reg.get = (id: string): ProviderAdapter => {
    const a = real(id);
    if (a.descriptor.kind === 'local') return a;
    const send = (req: ChatRequest, o: Parameters<ProviderAdapter['send']>[1]) => {
      seen.push(JSON.stringify(req.messages));
      return a.send(req, o);
    };
    return {
      descriptor: a.descriptor,
      capabilities: () => a.capabilities(),
      estimate: (req) => a.estimate(req),
      send,
      cancel: (id) => a.cancel(id),
      detect: () => a.detect(),
    };
  };
  return seen;
}

async function taintedRun(host: RecordingHost) {
  const k = new Kernel(host);
  const h = await k.startRun({ request: REQ, options: IN_PLACE });
  const o = await h.done;
  expect(providers(o)['architecture']!.some(isLocal)).toBe(true);
  return { k, runId: h.runId };
}

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

describe('P4-R1: replay and fork keep the local-only taint', () => {
  it('a fork reusing a tainted node keeps every node it reruns on local providers', async () => {
    const host = recordingHost(CHEAP);
    withLocals(host);
    await localOnlyFact(host);
    const { k, runId } = await taintedRun(host);
    expect(readRun(k['journal'], runId)?.nodes['architecture']?.localTaint).toBe(true);
    const f = await k.forkPlan(runId, 'implementation', {}, TEST_OPTIONS);
    expect(Object.keys(f.fork!.reuse)).toEqual(['architecture']);
    expect(f.taint?.ids).toEqual(['architecture']);
    const fh = await k.startFork(f.planId, IN_PLACE);
    const fo = await fh.done;
    const p = providers(fo);
    for (const id of f.fork!.rerun) expect(p[id]!.every(isLocal), id).toBe(true);
    // The fork's own records carry the taint on, for a fork of the fork.
    const rec = readRun(k['journal'], fh.runId)!;
    expect(f.fork!.rerun.every((id) => rec.nodes[id]?.localTaint === true)).toBe(true);
    await k.close();
  });

  it('a replay of a node reading a tainted one is held on local providers', async () => {
    const host = recordingHost(CHEAP);
    withLocals(host);
    await localOnlyFact(host);
    const { k, runId } = await taintedRun(host);
    const plan = await k.replayPlan(runId, 'implementation', {}, TEST_OPTIONS);
    expect(plan.options.localOnly).toBe(true);
    expect(host.said.join('')).toMatch(/held on local providers: node architecture/);
    const r = await (await k.startReplay(plan.planId, { accepted: true })).done;
    expect(r.replay.models.length).toBeGreaterThan(0);
    expect(r.replay.models.every((m) => isLocal(m.provider))).toBe(true);
    await k.close();
  });

  it('fails closed when no local provider is left to hold it', async () => {
    const host = recordingHost(CHEAP);
    withLocals(host);
    await localOnlyFact(host);
    const { k, runId } = await taintedRun(host);
    for (const id of LOCALS) rmSync(join(host.home, 'providers', `${id}.yaml`));
    expect(await code(k.replayPlan(runId, 'implementation', {}, TEST_OPTIONS))).toBe('unroutable');
    await k.close();
  });

  it('derives the taint of a run recorded without the mark (fact added afterwards)', async () => {
    const host = recordingHost(CHEAP);
    withLocals(host);
    const { k, runId } = await taintedRun(host);
    expect(readRun(k['journal'], runId)?.nodes['architecture']?.localTaint).toBeUndefined();
    await localOnlyFact(host);
    const f = await k.forkPlan(runId, 'implementation', {}, TEST_OPTIONS);
    expect(f.taint?.ids).toEqual(['architecture']);
    const plan = await k.replayPlan(runId, 'implementation', {}, TEST_OPTIONS);
    expect(plan.options.localOnly).toBe(true);
    await k.close();
  });

  it("a fork gets today's memory: quotes of a local-only fact never reach the cloud", async () => {
    const host = recordingHost(CHEAP);
    await localOnlyFact(host);
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: IN_PLACE });
    await h.done;
    const edit = { instruction: `Remember: ${FACT}` };
    const f = await k.forkPlan(h.runId, 'implementation', edit, TEST_OPTIONS);
    expect(f.memory?.localOnlyTexts).toEqual([FACT]);
    const seen = spy(f);
    const fo = await (await k.startFork(f.planId, IN_PLACE)).done;
    expect(providers(fo)['implementation']!.length).toBeGreaterThan(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.join('\n')).not.toContain(MARKER);
    expect(seen.join('\n')).toContain(LOCAL_ONLY_MARK);
    await k.close();
  });
});
