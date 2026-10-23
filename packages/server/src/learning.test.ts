/**
 * ADR-0028 and R-403/R-405 over the real protocol: grades, competence, accuracy, replay,
 * fork, and dispute answers through `confirm.answer {choice}`. Loopback only, no network.
 */
import { userInfo } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { parseResult, type MethodName } from '@kernelpai/kernel/protocol';
import { REQ, recordingHost } from '../../kernel/src/test-helpers/fixture.js';
import { ConfirmBroker } from './confirm-broker.js';
import { startServer, type KernelServer } from './server.js';
import { connect, type TestClient } from './test-helpers/client.js';

const servers: KernelServer[] = [];
const clients: TestClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

async function boot() {
  const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '100' });
  const server = await startServer({
    kernel: { env: host.env, cwd: host.cwd },
    confirmTimeoutMs: 3000,
    serverFile: false,
    defaults: { allowTest: true },
  });
  servers.push(server);
  const c = await connect(`ws://127.0.0.1:${server.port}/rpc`, { token: server.token });
  clients.push(c);
  return { host, c };
}

async function ok<M extends MethodName>(c: TestClient, method: M, params?: unknown) {
  const r = await c.call(method, params);
  expect(r.error, `${method}: ${r.error?.message}`).toBeUndefined();
  expect(parseResult(method, r.result).ok, method).toBe(true);
  return r.result as Record<string, unknown>;
}

async function runToEnd(c: TestClient, method: 'run.start' | 'run.fork', params: unknown) {
  const { runId } = (await ok(c, method, params)) as { runId: string };
  const done = await c.waitFor((n) => n.method === 'run.done' && n.params.runId === runId);
  return { runId, done: done.params };
}

describe('learning, replay and fork over the protocol', () => {
  it('grades, lists competence and accuracy, replays and forks', async () => {
    const { c } = await boot();
    const { runId, done } = await runToEnd(c, 'run.start', {
      request: REQ,
      options: { isolated: false },
    });
    expect(done.verification).toMatchObject({ reviewUsd: expect.any(Number) });
    const g = await ok(c, 'grade', {
      runId,
      nodeId: 'implementation',
      grade: 'good',
      author: 'ana',
    });
    expect(g.graded).toMatch(/^mock-/);
    const comp = (await ok(c, 'competence')) as { entries: unknown[] };
    expect(comp.entries.length).toBeGreaterThan(0);
    const acc = (await ok(c, 'stats.accuracy')) as { runs: { samples: number } };
    expect(acc.runs.samples).toBe(1);
    const bad = await c.call('grade', { runId, nodeId: 'nope', grade: 'good' });
    expect(bad.error?.code).toBe(-32004);
    const replay = await ok(c, 'run.replay', {
      runId,
      nodeId: 'implementation',
      model: { provider: 'mock-alpha', model: 'm1' },
    });
    expect(replay).toMatchObject({ runId, nodeId: 'implementation' });
    const fork = (await ok(c, 'run.forkPlan', {
      runId,
      nodeId: 'tests',
      edit: { instruction: 'add an edge case' },
    })) as { planId: string; rerun: string[]; reused: string[] };
    expect(fork.rerun).toContain('tests');
    expect(fork.reused).toContain('implementation');
    const forked = await runToEnd(c, 'run.fork', { planId: fork.planId });
    expect(forked.runId).not.toBe(runId);
    const missing = await c.call('run.fork', { planId: 'nope' });
    expect(missing.error?.code).toBe(-32004);
  });
});

describe('review findings over the protocol (D-024)', () => {
  it('P4-F9: a grade is always authored by the local user, never by the client', async () => {
    const { c } = await boot();
    const { runId } = await runToEnd(c, 'run.start', {
      request: REQ,
      options: { isolated: false },
    });
    await ok(c, 'grade', { runId, nodeId: 'implementation', grade: 'bad', author: 'mallory' });
    const sessions = (await ok(c, 'sessions.list', {})) as { sessions: Array<{ id: string }> };
    const events = await Promise.all(
      sessions.sessions.map((s) => ok(c, 'sessions.events', { sessionId: s.id })),
    );
    const grades = events
      .flatMap((e) => (e as { events: Array<{ payload?: Record<string, unknown> }> }).events)
      .filter((e) => e.payload?.['grade'] === 'bad');
    expect(grades).toHaveLength(1);
    expect(grades[0]?.payload?.['author']).toBe(userInfo().username || 'user');
  });

  it('P4-F5/F2: run.replayPlan shows likely and cap; run.replay runs it; options add to the floor', async () => {
    const { c } = await boot();
    const { runId } = await runToEnd(c, 'run.start', {
      request: REQ,
      options: { isolated: false, exclude: ['mock-beta'] },
    });
    const plan = (await ok(c, 'run.replayPlan', {
      runId,
      nodeId: 'implementation',
      options: { exclude: ['mock-alpha'] },
    })) as {
      planId: string;
      routing: { exclude: string[] };
      estimate: { expectedUsd: number; capUsd: number };
    };
    expect(plan.routing.exclude).toEqual(['mock-beta', 'mock-alpha']);
    expect(plan.estimate.capUsd).toBeGreaterThanOrEqual(plan.estimate.expectedUsd);
    const r = (await ok(c, 'run.replay', {
      runId,
      nodeId: 'implementation',
      planId: plan.planId,
    })) as { replayId: string; replay: { models: Array<{ provider: string }> } };
    expect(r.replayId).toBe(plan.planId);
    const used = r.replay.models.map((m) => m.provider);
    expect(used.some((p) => p === 'mock-beta' || p === 'mock-alpha')).toBe(false);
    const again = await c.call('run.replay', {
      runId,
      nodeId: 'implementation',
      planId: plan.planId,
    });
    expect(again.error?.code).toBe(-32004);
    const gone = await c.call('run.cancel', { runId: plan.planId });
    expect(gone.error?.code).toBe(-32004);
  });
  it('P4-R3: run.replayPlan refuses a diversity waiver the run had not, and shows one it had', async () => {
    const { c } = await boot();
    const kept = await runToEnd(c, 'run.start', { request: REQ, options: { isolated: false } });
    const waive = { allowSameProvider: true };
    const refused = await c.call('run.replayPlan', {
      runId: kept.runId,
      nodeId: 'implementation',
      options: waive,
    });
    expect(refused.error?.message).toMatch(/allowSameProvider is refused/);
    const waived = await runToEnd(c, 'run.start', {
      request: REQ,
      options: { isolated: false, ...waive },
    });
    const plan = (await ok(c, 'run.replayPlan', {
      runId: waived.runId,
      nodeId: 'implementation',
      options: waive,
    })) as { routing: { allowSameProvider?: boolean } };
    expect(plan.routing.allowSameProvider).toBe(true);
  });
});

describe('stats.productivity (R-406)', () => {
  it('returns a result that passes the protocol schema, with and without detail', async () => {
    const { c } = await boot();
    const { runId, done } = await runToEnd(c, 'run.start', {
      request: REQ,
      options: { isolated: false },
    });
    const p = (await ok(c, 'stats.productivity')) as Record<string, unknown> & {
      runs: number;
      review: { acceptedFindings: number };
    };
    expect(p.runs).toBeGreaterThanOrEqual(1);
    expect(p).not.toHaveProperty('list');
    const v = (done as { verification?: { acceptedFindings: number } }).verification;
    expect(p.review.acceptedFindings).toBe(v?.acceptedFindings);
    const d = (await ok(c, 'stats.productivity', {
      since: '2000-01-01T00:00:00Z',
      reworkDays: 3,
      detail: true,
    })) as { list: unknown[]; reworkWindowMs: number; since: string };
    expect(d.list).toEqual([]);
    expect(d.reworkWindowMs).toBe(3 * 86_400_000);
    expect(d.since).toBe('2000-01-01T00:00:00.000Z');
    expect(runId).toBeTruthy();
    for (const params of [{ since: 'soon' }, { reworkDays: 0 }, { reworkDays: 400 }]) {
      const bad = await c.call('stats.productivity', params);
      expect(bad.error?.code, JSON.stringify(params)).toBe(-32602);
    }
  });
});

describe('dispute answers (R-405)', () => {
  const dispute = {
    nodeId: 'n',
    kind: 'vote',
    reason: 'no majority',
    options: [
      { id: 'a', label: 'A', text: 'one', backers: ['p/m'] },
      { id: 'b', label: 'B', text: 'two', backers: [] },
    ],
    positions: [],
  };
  const req = { kind: 'dispute' as const, question: 'pick', dispute };

  function broker(reply: (params: { confirmId: string }) => [boolean, string?] | undefined) {
    const ref: { b?: ConfirmBroker } = {};
    const sent: unknown[] = [];
    const broadcast = (_name: string, params: unknown): number => {
      sent.push(params);
      const r = reply(params as { confirmId: string });
      if (r) queueMicrotask(() => ref.b!.answer((params as { confirmId: string }).confirmId, ...r));
      return 1;
    };
    const b = new ConfirmBroker(broadcast, 50);
    ref.b = b;
    return { b, sent };
  }

  it('returns the option picked, and null for a rejection, an unknown id or silence', async () => {
    const pick = broker(() => [true, 'b']);
    expect(await pick.b.choose(req)).toBe('b');
    expect(pick.sent[0]).toMatchObject({ kind: 'dispute', dispute: { nodeId: 'n' } });
    expect(await broker(() => [false, 'a']).b.choose(req)).toBeNull();
    expect(await broker(() => [true, 'zz']).b.choose(req)).toBeNull();
    expect(await broker(() => [true]).b.choose(req)).toBeNull();
    expect(await broker(() => undefined).b.choose(req)).toBeNull();
    expect(await broker(() => [true]).b.ask({ kind: 'budget', question: 'q' })).toBe(true);
  });
});
