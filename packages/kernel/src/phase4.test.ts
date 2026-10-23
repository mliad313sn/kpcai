/**
 * Phase 4 integration at the kernel: grades and measured competence (ADR-0028), accuracy
 * before launch (R-402), the bench, replay and fork (R-403), disputes failing closed (R-405),
 * run records kept out of history, and local-only memory never journaled. Offline.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '@kernelpai/memory';
import { RECORD_ACTIONS, type DisputeQuestion } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { askQueue, hostChoose, type DisputeInfo } from './confirm.js';
import { Kernel } from './kernel.js';
import { folderKey } from './packs.js';
import { disputeHook } from './run-deps.js';
import { REQ, TEST_OPTIONS, recordingHost, type RecordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;

async function ran(host: RecordingHost, request = REQ, options = IN_PLACE) {
  const k = new Kernel(host);
  const h = await k.startRun({ request, options });
  const o = await h.done;
  return { k, h, o };
}

const code = (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

describe('grades, measured competence and accuracy (ADR-0028)', () => {
  it('records a manual grade and shows the evidence; maps grade errors', async () => {
    const host = recordingHost(CHEAP);
    const { k, h } = await ran(host);
    const r = k.learning.grade({
      runId: h.runId,
      nodeId: 'implementation',
      grade: 'good',
      note: 'nice',
    });
    expect(r).toMatchObject({ runId: h.runId, nodeId: 'implementation' });
    expect(r.graded).toMatch(/^mock-/);
    const entries = k.learning.competence();
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => /here/.test(e.evidence))).toBe(true);
    expect(
      await code(() => k.learning.grade({ runId: h.runId, nodeId: 'nope', grade: 'bad' })),
    ).toBe('not_found');
    expect(
      await code(() =>
        k.learning.grade({
          runId: h.runId,
          nodeId: 'implementation',
          grade: 'bad',
          author: r.graded,
        }),
      ),
    ).toBe('invalid');
    const acc = k.learning.accuracy();
    expect(acc.runs.samples).toBe(1);
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(p.estimate.accuracy).toMatch(/^past estimates here: \d\/1 runs inside the band/);
    await k.close();
  });

  it('runs the bench after one yes, journals checks and applies nothing', async () => {
    const host = recordingHost(CHEAP);
    mkdirSync(join(host.cwd, 'src'));
    const fn = (n: number) =>
      `export function compute${n}(a: number, b: number): number {\n  const x = a * ${n} + b;\n  return x > 10 ? x - 10 : x + 1;\n}\n`;
    writeFileSync(join(host.cwd, 'src/calc.ts'), [1, 2, 3, 4].map(fn).join('\n'));
    spawnSync('git', ['add', '-A'], { cwd: host.cwd });
    spawnSync('git', ['commit', '-qm', 'src'], { cwd: host.cwd });
    const k = new Kernel(host);
    host.answers = [false];
    const no = await k.learning.bench({ options: TEST_OPTIONS });
    expect(no.ran).toBe(false);
    host.answers = [true];
    host.fallback = false;
    const r = await k.learning.bench({ options: TEST_OPTIONS });
    expect(r.ran).toBe(true);
    expect(r.tasks.length).toBeGreaterThan(0);
    expect(host.asked.filter((a) => a.kind === 'budget').at(-1)?.question).toMatch(/^Bench: /);
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: host.cwd }).stdout.toString();
    expect(status).toBe('');
    await k.close();
  });
});

describe('replay and fork (R-403)', () => {
  it('replays a node with another model beside the original', async () => {
    const host = recordingHost(CHEAP);
    const { k, h } = await ran(host);
    const model = { provider: 'mock-alpha', model: 'm1' };
    const r = await k.replay(h.runId, 'implementation', { model }, TEST_OPTIONS);
    expect(r.replay.models[0]).toEqual(model);
    expect(r.original.ok).toBe(true);
    expect(typeof r.comparison.sameOutput).toBe('boolean');
    expect(await code(k.replay('no-such-run', 'implementation', {}, TEST_OPTIONS))).toBe(
      'not_found',
    );
    expect(
      await code(
        k.replay(h.runId, 'implementation', { model: { provider: 'x', model: 'y' } }, TEST_OPTIONS),
      ),
    ).toBe('invalid');
    await k.close();
  });

  it('forks from a node: estimate covers what reruns, rules are not given twice', async () => {
    const host = recordingHost(CHEAP);
    writeFileSync(join(host.cwd, 'AGENTS.md'), 'house rules\n');
    const { k, h } = await ran(host);
    const plan = await k.forkPlan(
      h.runId,
      'tests',
      { instruction: 'cover the empty state' },
      IN_PLACE,
    );
    expect(plan.fork!.rerun).toContain('tests');
    expect(Object.keys(plan.fork!.reuse)).toContain('implementation');
    expect(plan.estimate.capUsd).toBe(plan.estimate.band.highUsd);
    const f = await k.startFork(plan.planId, IN_PLACE);
    const o = await f.done;
    expect(o.status).toBe('finished');
    if (o.status === 'finished') {
      // Patches of reused nodes were offered by the parent run, not again.
      expect(o.patches.every((p) => p.nodeId !== 'implementation')).toBe(true);
    }
    const calls = k
      .sessions(20)
      .flatMap((s) => k.events(s.id, 1000))
      .filter((e) => e.type === 'call');
    for (const c of calls) {
      const text = JSON.stringify(c.payload['request']);
      expect(text.split('Repository rule files follow').length - 1).toBeLessThanOrEqual(1);
    }
    expect(await code(() => k.startFork('nope'))).toBe('not_found');
    await k.close();
  });
});

describe('disputes fail closed (R-405)', () => {
  const info: DisputeInfo = {
    nodeId: 'n',
    kind: 'vote',
    reason: 'no majority',
    options: [{ id: 'a', label: 'A', text: 'answer A', backers: [] }],
    positions: [],
  };
  const req = { kind: 'dispute' as const, question: 'q', dispute: info };

  it('takes only an offered option; anything else rejects', async () => {
    const q = askQueue();
    expect(await hostChoose(undefined, () => false, q)(req)).toBeNull();
    expect(
      await hostChoose(
        () => Promise.resolve('a'),
        () => false,
        q,
      )(req),
    ).toBe('a');
    expect(
      await hostChoose(
        () => Promise.resolve('zz'),
        () => false,
        q,
      )(req),
    ).toBeNull();
    expect(
      await hostChoose(
        () => Promise.reject(new Error('x')),
        () => false,
        q,
      )(req),
    ).toBeNull();
    expect(
      await hostChoose(
        () => Promise.resolve('a'),
        () => true,
        q,
      )(req),
    ).toBeNull();
  });

  it('maps the orchestrator question to the confirm channel', async () => {
    const seen: unknown[] = [];
    const question: DisputeQuestion = {
      runId: 'r',
      nodeId: 'n',
      title: 't',
      kind: 'critics',
      reason: 'split critics',
      options: [
        {
          id: 'accept',
          label: 'accept',
          text: 'x'.repeat(30_000),
          backers: [{ provider: 'p', model: 'm' }],
        },
      ],
      positions: [
        { ref: { provider: 'p', model: 'm' }, role: 'critic', says: 'ok', option: 'accept' },
      ],
    };
    const hook = disputeHook((r) => (seen.push(r), Promise.resolve('accept')));
    expect(await hook(question)).toBe('accept');
    const r = seen[0] as { kind: string; runId: string; dispute: DisputeInfo };
    expect(r).toMatchObject({ kind: 'dispute', runId: 'r' });
    expect(r.dispute.options[0]!.text.length).toBe(20_000);
    expect(r.dispute.options[0]!.backers).toEqual(['p/m']);
    expect(await disputeHook(() => Promise.reject(new Error('gone')))(question)).toBeNull();
  });
});

describe('history and privacy', () => {
  it('keeps run records out of history and export; local-only memory never journaled', async () => {
    const host = recordingHost(CHEAP);
    // A local provider, so the local-only fact really is sent (to it) during the run.
    const dir = join(host.home, 'providers');
    writeFileSync(
      join(dir, 'mock-local.yaml'),
      [
        'id: mock-local',
        'name: mock-local',
        'kind: local',
        'adapter: mock',
        'baseUrl: http://127.0.0.1:9',
        'jurisdiction: local',
        'retention: none',
        'models:',
        '  - id: m1',
        '    contextWindow: 32000',
        '    maxOutput: 4096',
        '    modalities: [text, code]',
        '    price: { inputPerMTok: 0, outputPerMTok: 0 }',
        '    competence: { code_generation: 0.7, test: 0.7, writing: 0.7, critique: 0.7, analysis: 0.7, research: 0.5, decision: 0.6 }',
        '',
      ].join('\n'),
    );
    const repo = await folderKey(host.cwd);
    const s = new MemoryStore({ home: host.home });
    await s.add({ layer: 'project', repo }, 'Lab host is gpu-box-55217', { localOnly: true });
    await s.add({ layer: 'project', repo }, 'Use pnpm');
    const { k, h } = await ran(host, 'summarize the architecture', {
      ...IN_PLACE,
      localOnly: true,
    });
    const sessionId = h.sessionId;
    const all = k
      .sessions(50)
      .flatMap((x) => k['journal'].events({ sessionId: x.id, limit: 100_000 }));
    expect(all.some((e) => e.provider === 'mock-local')).toBe(true);
    const raw = JSON.stringify(all);
    expect(raw).toContain('Use pnpm');
    expect(raw).not.toContain('gpu-box-55217');
    expect(all.some((e) => RECORD_ACTIONS.has(String(e.payload['action'])))).toBe(true);
    const history = k.events(sessionId, 100_000);
    expect(history.some((e) => RECORD_ACTIONS.has(String(e.payload['action'])))).toBe(false);
    const md = k.exportMarkdown(sessionId);
    expect(md).not.toMatch(/node recorded|run started/);
    expect(md).not.toContain('gpu-box-55217');
    await k.close();
  });
});

describe('replay and fork: refusals', () => {
  it('refuses unknown runs and invalid edits, and replays with another protocol', async () => {
    const host = recordingHost(CHEAP);
    const { k, h } = await ran(host);
    const r = await k.replay(h.runId, 'implementation', { protocol: 'solo' }, TEST_OPTIONS);
    expect(r.replay.protocol).toBe('author_critic'); // principle 2: code keeps its critic
    expect(await code(k.replay(h.runId, 'nope', {}, TEST_OPTIONS))).toBe('not_found');
    expect(await code(k.forkPlan('no-such-run', 'tests', {}, TEST_OPTIONS))).toBe('not_found');
    const bad = { model: { provider: 'x', model: 'y' } };
    expect(await code(k.forkPlan(h.runId, 'tests', bad, TEST_OPTIONS))).toBe('invalid');
    await k.close();
  });
});
