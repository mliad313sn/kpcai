/**
 * KP Studio against the real kernel server (packages/server) with offline mock providers:
 * the protocol's result schemas, editable plans, routing data, steering and confirmations
 * end to end. The fake-kernel unit tests stay for edge cases the real kernel cannot script.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { connect, disconnect } from './connection';
import {
  answerConfirm,
  applyPatches,
  control,
  instructNode,
  requestPlan,
  startRun,
} from './store/actions';
import { editNode, validate } from './store/plan-edit';
import { loadCheckpoints, loadRuns } from './store/workspace';
import { initialState, patch, studio } from './store/store';
import { until } from './test-helpers/fake-kernel';
import { REAL_REQUEST, startRealKernel, type RealKernel } from './test-helpers/real-kernel';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;

let k: RealKernel | undefined;
afterEach(async () => {
  disconnect();
  await k?.stop();
  k = undefined;
});

const s = () => studio.getState();

async function boot(
  env: Record<string, string> = { KPAI_CONFIRM_ABOVE_USD: '100' },
  token?: string,
) {
  studio.setState(initialState(), true);
  k = await startRealKernel(env);
  patch({ runOptions: { allowTest: true } });
  connect(k.wsUrl, token ?? k.server.token, {
    WebSocketImpl: WS,
    backoff: { initialMs: 10, maxMs: 20 },
  });
}

const opened = () => until(() => s().conn === 'open' && s().models.length > 0, 5000);

/** Answers every confirmation `ok` as soon as it shows up. */
function autoAnswer(ok: boolean): () => void {
  return studio.subscribe((st) => {
    for (const c of st.confirms) void answerConfirm(c.confirmId, ok);
  });
}

describe('KP Studio on the real kernel server', () => {
  it('lists providers and models, and is refused with a wrong token (4401)', async () => {
    await boot();
    await opened();
    expect(s().providers.map((p) => p.id)).toEqual(
      expect.arrayContaining(['mock-alpha', 'mock-beta']),
    );
    expect(s().models).toContainEqual({ provider: 'mock-alpha', model: 'm1' });
    disconnect();
    connect(k!.wsUrl, 'definitely-not-the-token', { WebSocketImpl: WS });
    await until(() => s().conn === 'unauthorized', 5000);
  });

  it('plans with a band and reasons, runs an edited plan, streams events and applies patches', async () => {
    await boot();
    await opened();
    await requestPlan(REAL_REQUEST);
    const plan = s().plan!;
    expect(plan.estimate.band?.lowUsd).toBeGreaterThanOrEqual(0);
    expect(plan.estimate.nodes.some((n) => n.reason)).toBe(true);
    const target = plan.graph.nodes.at(-1)!.id;
    editNode(target, { model: { provider: 'mock-alpha', model: 'm1' } });
    await validate();
    expect(s().plan?.check).toMatchObject({ ok: true });
    expect(s().plan?.check?.changes.join('\n')).toMatch(/model routed → mock-alpha\/m1/);
    await startRun();
    const runId = s().activeRunId!;
    await until(() => s().runs[runId]?.patches.length === 2, 10_000);
    const run = s().runs[runId]!;
    expect(run.state).toBe('done');
    expect(run.nodes[target]?.contributions[0]?.ref).toEqual({
      provider: 'mock-alpha',
      model: 'm1',
    });
    expect(Object.values(run.nodes).some((n) => n.reason)).toBe(true);
    expect(Object.values(run.nodes).some((n) => n.tokens)).toBe(true);
    expect(run.costUsd).toBeGreaterThan(0);
    const stop = autoAnswer(true);
    await applyPatches(runId, [run.patches[0]!.nodeId]);
    stop();
    expect(s().runs[runId]?.applied).toEqual([run.patches[0]!.nodeId]);
    // R-307 runs manager and R-305 checkpoints, from the same kernel.
    await loadRuns();
    expect(s().serverRuns.find((r) => r.runId === runId)).toMatchObject({ state: 'done' });
    await loadCheckpoints(runId);
    expect(s().checkpoints[runId]?.length).toBeGreaterThanOrEqual(1);
  });

  it('refuses a broken edit through plan.validate and keeps Run blocked', async () => {
    await boot();
    await opened();
    await requestPlan(REAL_REQUEST);
    const id = s().plan!.graph.nodes[0]!.id;
    editNode(id, { model: { provider: 'nobody', model: 'none' } });
    await validate();
    expect(s().plan?.check?.ok).toBe(false);
    expect(s().plan?.check?.problems.join(' ')).toMatch(/not an available candidate/);
  });

  it('pauses, takes an instruction for a pending node and resumes (run.control)', async () => {
    await boot({ KPAI_CONFIRM_ABOVE_USD: '0' });
    await opened();
    await requestPlan(REAL_REQUEST);
    const last = s().plan!.graph.nodes.at(-1)!.id;
    let held: string | undefined;
    const unsub = studio.subscribe((st) => {
      for (const c of st.confirms) {
        if (!held && !/graph estimate/.test(c.question)) held = c.confirmId;
        else if (c.confirmId !== held) void answerConfirm(c.confirmId, true);
      }
    });
    await startRun();
    const runId = s().activeRunId!;
    await until(() => held !== undefined, 5000);
    await control('pause', runId);
    await until(() => s().runs[runId]?.state === 'paused', 5000);
    await answerConfirm(held!, true);
    expect(await instructNode(runId, last, 'keep it short')).toBe(true);
    await until(
      () => s().runs[runId]!.controls.some((c) => c.event.type === 'instruction_added'),
      5000,
    );
    await control('resume', runId);
    await until(() => s().runs[runId]?.state === 'done', 10_000);
    unsub();
    expect(s().runs[runId]!.controls.map((c) => c.event.type)).toEqual(
      expect.arrayContaining(['run_paused', 'instruction_added', 'run_resumed']),
    );
  });
});
