import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { connect, disconnect } from '../connection';
import { FakeKernel, RpcFailure, TOKEN, until } from '../test-helpers/fake-kernel';
import { PATCH, PLAN, kernelHandlers } from '../test-helpers/fixtures';
import {
  answerConfirm,
  applyPatches,
  control,
  discardPlan,
  redirectNode,
  requestPlan,
  startRun,
  submit,
} from './actions';
import { initialState, studio } from './store';

let kernel: FakeKernel;
const s = () => studio.getState();

async function boot(handlers: Record<string, (p: unknown) => unknown> = {}) {
  kernel = await new FakeKernel({ ...kernelHandlers(), ...handlers }).start();
  connect(kernel.url, TOKEN, {
    WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    backoff: { initialMs: 10, maxMs: 20 },
  });
  await until(() => expect(s().conn).toBe('open'));
  await until(() => expect(s().models).toHaveLength(2));
}

beforeEach(() => studio.setState(initialState(), true));
afterEach(async () => {
  disconnect();
  await kernel?.stop();
});

describe('actions against a fake kernel', () => {
  it('loads sessions and models once connected', async () => {
    await boot();
    expect(s().sessions.map((x) => x.id)).toEqual(['s1']);
    expect(s().announcement.text).toBe('Connected to the KernelPAI kernel');
  });

  it('plans first, then runs the plan the user saw (zéro surprise)', async () => {
    await boot();
    await submit('add OAuth with tests');
    expect(kernel.calls('plan')).toEqual([
      { request: 'add OAuth with tests', options: { profile: 'balanced' } },
    ]);
    expect(kernel.calls('run.start')).toEqual([]);
    expect(s().plan?.estimate.totalUsd).toBe(0.4);
    expect(s().announcement.text).toMatch(/Plan ready: 3 nodes, likely \$0.40, at most \$0.50/);
    await startRun();
    expect(kernel.calls('run.start')).toEqual([
      { request: 'add OAuth with tests', planId: 'p1', options: { profile: 'balanced' } },
    ]);
    expect(s().plan).toBeUndefined();
    expect(s().activeRunId).toBe('r1');
    expect(s().runs.r1?.graph?.nodes).toHaveLength(3);
  });

  it('follows a run through notifications', async () => {
    await boot();
    await requestPlan('x');
    await startRun();
    const ref = { provider: 'openai', model: 'model-b' };
    kernel.notify('run.state', { runId: 'r1', state: 'running' });
    kernel.notify('run.event', {
      runId: 'r1',
      event: { type: 'node_state', nodeId: 'impl', state: 'running', ref, role: 'author' },
    });
    kernel.notify('run.event', { runId: 'r1', event: { type: 'bogus' } });
    kernel.notify('run.event', {
      runId: 'r1',
      event: {
        type: 'contribution',
        nodeId: 'impl',
        contribution: { role: 'author', ref, text: 'code', costUsd: 0.05 },
      },
    });
    kernel.notify('run.event', {
      runId: 'r1',
      event: { type: 'node_state', nodeId: 'impl', state: 'done' },
    });
    kernel.notify('run.done', {
      runId: 'r1',
      result: { ok: true, results: { impl: { output: 'final' } } },
      patches: [{ nodeId: 'impl', patch: PATCH, files: ['src/auth.ts'] }],
    });
    kernel.notify('run.state', { runId: 'r1', state: 'done' });
    await until(() => expect(s().runs.r1?.state).toBe('done'));
    const run = s().runs.r1!;
    expect(run.nodes.impl).toMatchObject({ state: 'done', output: 'final', costUsd: 0.05 });
    expect(run.patches[0]?.patch).toBe(PATCH);
    expect(s().logs.map((l) => l.message)).toContain('Dropped a malformed run event');
    expect(s().announcement.text).toBe('Run finished');
  });

  it('accepts run.planned for a run started elsewhere and drops malformed plans', async () => {
    await boot();
    kernel.notify('run.planned', {
      runId: 'r9',
      planId: 'p9',
      graph: PLAN.graph,
      estimate: PLAN.estimate,
    });
    kernel.notify('run.planned', { runId: 'r8', planId: 'p8', graph: { nope: 1 }, estimate: {} });
    kernel.notify('log', { level: 'warn', message: 'careful' });
    await until(() => expect(s().logs.at(-1)?.message).toBe('careful'));
    expect(s().runs.r9?.graph?.id).toBe('g1');
    expect(s().runs.r8).toBeUndefined();
    expect(s().logs.map((l) => l.message)).toContain('Dropped a malformed plan');
  });

  it('sends run controls, redirects and patch application', async () => {
    await boot();
    await requestPlan('x');
    await startRun();
    await control('pause', 'r1');
    await control('resume', 'r1');
    await control('cancel', 'r1');
    await redirectNode('r1', 'impl', { provider: 'anthropic', model: 'model-a' });
    studio.setState({
      runs: { r1: { ...s().runs.r1!, patches: [{ nodeId: 'impl', patch: PATCH, files: [] }] } },
    });
    await applyPatches('r1');
    expect(kernel.calls('run.pause')).toEqual([{ runId: 'r1' }]);
    expect(kernel.calls('run.resume')).toEqual([{ runId: 'r1' }]);
    expect(kernel.calls('run.cancel')).toEqual([{ runId: 'r1' }]);
    expect(kernel.calls('run.redirect')).toEqual([
      { runId: 'r1', nodeId: 'impl', to: { provider: 'anthropic', model: 'model-a' } },
    ]);
    expect(kernel.calls('patches.apply')).toEqual([{ runId: 'r1' }]);
    expect(s().runs.r1?.applied).toEqual(['impl']);
  });

  it('answers a confirmation once', async () => {
    await boot();
    kernel.notify('confirm.request', {
      confirmId: 'c1',
      kind: 'tool',
      question: 'rm -rf?',
      timeoutMs: 5000,
    });
    await until(() => expect(s().confirms).toHaveLength(1));
    await answerConfirm('c1', true);
    await answerConfirm('c1', false);
    expect(kernel.calls('confirm.answer')).toEqual([{ confirmId: 'c1', ok: true }]);
    expect(s().confirms).toEqual([]);
  });

  it('runs / commands', async () => {
    await boot();
    expect(await submit('')).toBe(false);
    expect(await submit('/nope')).toBe(false);
    expect(s().announcement.text).toMatch(/Unknown command \/nope/);
    expect(await submit('/plan')).toBe(false);
    expect(await submit('/run')).toBe(false);
    await submit('/stats');
    expect(s().notice).toEqual({
      title: 'Stats',
      body: JSON.stringify({ calls: 3, costUsd: 0.12 }, null, 2),
    });
    await submit('/tools');
    expect(s().notice?.title).toBe('Tools');
    await submit('/help');
    expect(s().notice?.body).toContain('/sessions');
    await submit('/sessions');
    expect(kernel.calls('sessions.list').length).toBeGreaterThanOrEqual(2);
    await submit('/run do it');
    expect(s().plan?.request).toBe('do it');
    expect(kernel.calls('run.start')).toEqual([]);
    await submit('/run');
    expect(kernel.calls('run.start')).toHaveLength(1);
    await submit('/plan again');
    discardPlan();
    expect(s().plan).toBeUndefined();
  });

  it('reports failures without throwing', async () => {
    const boom = () => {
      throw new RpcFailure(-32603, 'boom');
    };
    await boot({
      plan: () => ({ wrong: true }),
      'run.cancel': boom,
      'run.redirect': boom,
      'patches.apply': boom,
      'confirm.answer': boom,
      stats: boom,
    });
    await requestPlan('x');
    expect(s().plan).toBeUndefined();
    expect(s().planning).toBe(false);
    expect(s().logs.at(-1)?.message).toMatch(/Planning failed: plan: /);
    await control('cancel', 'r1');
    expect(s().logs.at(-1)?.message).toBe('Cancel failed: boom');
    await redirectNode('r1', 'n', { provider: 'p', model: 'm' });
    await applyPatches('r1', ['n']);
    await submit('/stats');
    expect(
      s()
        .logs.slice(-3)
        .map((l) => l.message),
    ).toEqual(['Redirect failed: boom', 'Applying the patch failed: boom', 'Stats failed: boom']);
    studio.setState({
      confirms: [{ confirmId: 'c', kind: 'budget', question: 'q', timeoutMs: 1, receivedAt: 0 }],
    });
    await answerConfirm('c', false);
    expect(s().logs.at(-1)?.message).toBe('Answering the confirmation failed: boom');
  });

  it('fails cleanly when not connected or when a result breaks the protocol', async () => {
    await boot({ 'run.start': () => ({}), 'sessions.list': () => [] });
    await requestPlan('x');
    await startRun();
    expect(s().logs.at(-1)?.message).toMatch(/Starting the run failed: run.start: runId/);
    disconnect();
    await requestPlan('y');
    expect(s().logs.at(-1)?.message).toBe('Planning failed: not connected to the kernel');
    await startRun();
    studio.setState({ plan: undefined });
    await startRun();
  });
});
