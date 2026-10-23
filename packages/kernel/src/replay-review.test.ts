/**
 * Phase 4 review findings on replay and fork (D-024): the original run's routing is a floor
 * (P4-F2), only runs of this project are accepted (P4-F4), a replay is estimated before it
 * spends and can be cancelled (P4-F5), and it passes the authorised-scope gate (P4-F6).
 * Offline: mock providers only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Journal, JournalEvent } from '@kernelpai/journal';
import { RUN_STARTED } from '@kernelpai/orchestrator';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import {
  REQ,
  TEST_OPTIONS,
  gitRepo,
  recordingHost,
  type RecordingHost,
} from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };
const IN_PLACE = { ...TEST_OPTIONS, isolated: false } as const;
const LOCAL = ['mock-local1', 'mock-local2', 'mock-local3', 'mock-local4'];

const code = (p: Promise<unknown>): Promise<string | undefined> =>
  p.then(
    () => undefined,
    (e: unknown) => (e as { code?: string }).code ?? String(e),
  );

/** A `kind: local` mock provider beside the fixture's four cloud-like `kind: test` ones. */
function localProvider(home: string, id: string): void {
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
    '    competence: { code_generation: 0.5, test: 0.5, writing: 0.5, critique: 0.5, analysis: 0.5, research: 0.5, decision: 0.5 }',
    '',
  ];
  writeFileSync(join(home, 'providers', `${id}.yaml`), lines.join('\n'));
}

function providersOf(result: unknown): string[] {
  const results = (result as { results: Record<string, { contributions: unknown[] }> }).results;
  const refs = Object.values(results).flatMap((r) =>
    r.contributions.map((c) => (c as { ref: { provider: string } }).ref.provider),
  );
  return [...new Set(refs)];
}

/** Every event of a session, run records included (the people's view hides them). */
const raw = (k: Kernel, sessionId: string): JournalEvent[] =>
  (k as unknown as { journal: Journal }).journal.events({ sessionId, limit: 100_000 });

const calls = (k: Kernel, sessionId: string): number =>
  k.events(sessionId, 100_000).filter((e) => e.type === 'call').length;

async function localOnlyRun(host: RecordingHost) {
  for (const id of LOCAL) localProvider(host.home, id);
  const k = new Kernel(host);
  const h = await k.startRun({ request: REQ, options: { ...IN_PLACE, localOnly: true } });
  const o = await h.done;
  if (o.status !== 'finished') throw new Error('original run did not run');
  return { k, h, o };
}

describe('P4-F2: a replay or fork is held to the run’s routing', () => {
  it('journals the routing and never reaches a non-local provider for a local-only run', async () => {
    const host = recordingHost(CHEAP);
    const { k, h, o } = await localOnlyRun(host);
    expect(providersOf(o.result).every((p) => LOCAL.includes(p))).toBe(true);
    // A console sends only its defaults; the CLI used to drop --local-only.
    const r = await k.replay(h.runId, 'implementation', {}, TEST_OPTIONS);
    expect(r.replay.ok).toBe(true);
    expect(r.replay.models.every((m) => LOCAL.includes(m.provider))).toBe(true);
    const plan = await k.forkPlan(h.runId, 'implementation', {}, TEST_OPTIONS);
    expect(plan.options.localOnly).toBe(true);
    const f = await (await k.startFork(plan.planId, IN_PLACE)).done;
    if (f.status !== 'finished') throw new Error('fork did not run');
    expect(providersOf(f.result).every((p) => LOCAL.includes(p))).toBe(true);
    const start = raw(k, h.sessionId).find((e) => e.payload['action'] === RUN_STARTED);
    expect(start?.payload['routing']).toMatchObject({ localOnly: true, allowTest: true });
    // A model outside the floor cannot be pinned onto the replay either.
    const cloud = { model: { provider: 'mock-beta', model: 'm1' } };
    expect(await code(k.replay(h.runId, 'implementation', cloud, TEST_OPTIONS))).toBe('unroutable');
    await k.close();
  });

  it('keeps exclusions and refusal of test providers; given options only add to them', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...IN_PLACE, exclude: ['mock-beta'] } });
    await h.done;
    const p = await k.replayPlan(
      h.runId,
      'implementation',
      {},
      {
        ...TEST_OPTIONS,
        exclude: ['mock-alpha'],
        profile: 'economy',
      },
    );
    expect(p.options).toMatchObject({ exclude: ['mock-beta', 'mock-alpha'], profile: 'economy' });
    expect(p.estimate.nodes[0]?.steps.every((s) => s.ref?.provider !== 'mock-beta')).toBe(true);
    await k.close();
  });
});

describe('P4-F4: only runs of this project', () => {
  it('refuses to replay or fork a run journaled by another project', async () => {
    const host = recordingHost(CHEAP);
    const a = new Kernel(host);
    const h = await a.startRun({ request: REQ, options: IN_PLACE });
    await h.done;
    await a.close();
    const b = new Kernel({ ...host, cwd: gitRepo() });
    expect(await code(b.replay(h.runId, 'implementation', {}, TEST_OPTIONS))).toBe('not_found');
    expect(await code(b.forkPlan(h.runId, 'implementation', {}, TEST_OPTIONS))).toBe('not_found');
    await b.close();
    const same = new Kernel(host);
    expect((await same.replay(h.runId, 'implementation', {}, TEST_OPTIONS)).replay.ok).toBe(true);
    await same.close();
  });
});

describe('P4-F5: estimate first, cap checked, cancellable', () => {
  it('plans likely and cap without spending, and asks on the cap before it spends', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...IN_PLACE, yes: true } });
    await h.done;
    const before = calls(k, h.sessionId);
    const plan = await k.replayPlan(h.runId, 'implementation', {}, TEST_OPTIONS);
    expect(plan.estimate.capUsd).toBeGreaterThanOrEqual(plan.estimate.expectedUsd);
    expect(plan.estimate.expectedUsd).toBeGreaterThan(0);
    expect(calls(k, h.sessionId)).toBe(before);
    host.answers = [false];
    const handle = await k.startReplay(plan.planId);
    expect(handle.replayId).toBe(plan.planId);
    expect(await code(handle.done)).toBe('budget');
    expect(host.asked.at(-1)).toMatchObject({ kind: 'budget', runId: plan.planId });
    expect(host.asked.at(-1)?.question).toMatch(/^replay estimate up to .* \(cap; likely /);
    expect(calls(k, h.sessionId)).toBe(before);
    expect(await code(k.startReplay(plan.planId))).toBe('not_found'); // a plan runs once
    await k.close();
  });

  it('run.cancel with the replay id stops it; its questions are void', async () => {
    const base = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    let hook: NonNullable<RecordingHost['confirm']> = base.confirm!;
    const voided: string[] = [];
    const host = {
      ...base,
      confirm: (req: Parameters<typeof hook>[0]) => hook(req),
      cancelConfirmations: (id: string) => void voided.push(id),
    };
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: { ...IN_PLACE, yes: true } });
    await h.done;
    const plan = await k.replayPlan(h.runId, 'implementation', {}, TEST_OPTIONS);
    let asked = 0;
    hook = (req) => {
      asked += 1;
      expect(req.runId).toBe(plan.planId);
      expect(k.cancel(plan.planId)).toBe(true);
      expect(k.cancel(plan.planId)).toBe(false);
      return Promise.resolve(true);
    };
    const before = calls(k, h.sessionId);
    const handle = await k.startReplay(plan.planId, { accepted: true });
    const r = await handle.done;
    expect(r.replay.ok).toBe(false);
    expect(asked).toBe(1); // the first step's budget question, nothing after the cancel
    expect(voided).toEqual([plan.planId]);
    expect(calls(k, h.sessionId)).toBe(before);
    const actions = raw(k, h.sessionId).map((e) => e.payload['action']);
    expect(actions).toContain('replay recorded');
    expect(await code(Promise.resolve().then(() => k.cancel(plan.planId)))).toBe('not_found');
    await k.close();
  });
});

const SCOPE_PACK = [
  'id: scoped',
  'name: Test scoped',
  'description: A pack that needs an authorised scope.',
  'profiles: [tests]',
  'markers:',
  '  - { glob: scoped.marker }',
  'safety:',
  '  requiresScope: true',
  '  scopeKinds: [binary]',
  '',
].join('\n');

describe('P4-F6: the authorised-scope gate of the current packs, now', () => {
  it('refuses a replay when a pack now needs a scope that is missing or expired', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: IN_PLACE });
    await h.done;
    // The pack arrives after the run: the replay is checked with the packs of today.
    mkdirSync(join(host.home, 'packs'), { recursive: true });
    writeFileSync(join(host.home, 'packs', 'scoped.yaml'), SCOPE_PACK);
    writeFileSync(join(host.cwd, 'scoped.marker'), 'x\n');
    const before = calls(k, h.sessionId);
    expect(await code(k.replay(h.runId, 'implementation', {}, TEST_OPTIONS))).toBe('refused');
    const scope = {
      targets: [{ kind: 'binary', value: 'sample.bin' }],
      engagementRef: 'CTF-2026-7',
      authorisedBy: 'Event organisers',
      expires: '2020-01-01',
    };
    const expired = { ...TEST_OPTIONS, scope };
    expect(await code(k.replay(h.runId, 'implementation', {}, expired))).toBe('refused');
    expect(calls(k, h.sessionId)).toBe(before);
    const refused = k
      .events(h.sessionId, 100_000)
      .filter((e) => /refused/.test(String(e.payload['action'])));
    expect(refused.length).toBeGreaterThanOrEqual(2);
    const soon = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const valid = { ...TEST_OPTIONS, scope: { ...scope, expires: soon } };
    expect((await k.replay(h.runId, 'implementation', {}, valid)).replay.ok).toBe(true);
    const accepted = k
      .events(h.sessionId, 100_000)
      .filter((e) => e.payload['action'] === 'scope accepted');
    expect(accepted.at(-1)?.payload).toMatchObject({ pack: 'scoped', runId: h.runId });
    await k.close();
  });
});
