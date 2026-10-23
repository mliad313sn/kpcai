/**
 * Phase 4 against the real kernel server with offline mock providers: memory with
 * provenance and proposals (ADR-0027), a vote dispute settled by the human (R-405), and
 * replay, fork, grades and evidence (R-402, R-403, ADR-0028), through the console's own
 * store actions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { connect, disconnect } from './connection';
import { answerConfirm, requestPlan, startRun } from './store/actions';
import { gradeNode, loadEvidence, planFork } from './store/learning';
import { planReplay, runReplay } from './store/replay';
import {
  addFact,
  confirmProposal,
  editFact,
  loadMemory,
  rejectProposal,
  removeFact,
} from './store/memory';
import { initialState, patch, studio } from './store/store';
import { until } from './test-helpers/fake-kernel';
import { REAL_REQUEST, startRealKernel, type RealKernel } from './test-helpers/real-kernel';

const WS = WebSocket as unknown as typeof globalThis.WebSocket;
const s = () => studio.getState();

let k: RealKernel | undefined;
afterEach(async () => {
  disconnect();
  await k?.stop();
  k = undefined;
});

async function boot() {
  studio.setState(initialState(), true);
  k = await startRealKernel({ KPAI_CONFIRM_ABOVE_USD: '100' });
  patch({ runOptions: { allowTest: true, isolated: false } });
  connect(k.wsUrl, k.server.token, { WebSocketImpl: WS, backoff: { initialMs: 10, maxMs: 20 } });
  await until(() => s().conn === 'open' && s().models.length > 0, 5000);
}

async function run(request: string): Promise<string> {
  await requestPlan(request);
  await startRun();
  const runId = s().activeRunId!;
  await until(() => s().runs[runId]?.state === 'done' && s().runs[runId]?.ok !== undefined, 15_000);
  return runId;
}

const PROPOSING = [
  'summarize the architecture',
  '```memory',
  '- [project] Tests use vitest and sit next to sources',
  '- [user] Prefers short answers',
  '```',
].join('\n');

describe('phase 4 on the real kernel server', () => {
  it('edits memory, keeps one proposal, rejects the other, and plans with memory', async () => {
    await boot();
    expect(await addFact('project', 'Use pnpm', true)).toBe(true);
    await loadMemory();
    const fact = s().memory.layers.project!.facts[0]!;
    expect(fact).toMatchObject({
      text: 'Use pnpm',
      provenance: { source: 'human', localOnly: true },
    });
    expect(await editFact('project', fact.id, { text: 'Use pnpm 10' })).toBe(true);
    expect(s().memory.layers.project!.facts[0]!.text).toBe('Use pnpm 10');
    // Two proposals arrive as `memory` questions once the run is done; "not now" leaves both.
    const stop = studio.subscribe((st) => {
      for (const c of st.confirms) if (c.kind === 'memory') void answerConfirm(c.confirmId, false);
    });
    await run(PROPOSING);
    await until(() => s().memory.pending.length === 2, 10_000);
    stop();
    const [a, b] = s().memory.pending;
    expect(a!.provenance.source).toMatch(/^mock/); // a model, never "human"
    await confirmProposal(a!.id);
    await rejectProposal(b!.id);
    expect(s().memory.pending).toHaveLength(0);
    await requestPlan('summarize the architecture again');
    const m = s().plan!.memory!;
    // The kept model fact is sent as untrusted data; the local-only human fact is withheld
    // from the cloud version of the message (and counted).
    expect(m.included).toContainEqual(expect.objectContaining({ id: a!.id, trust: 'untrusted' }));
    expect(m.localOnly).toBe(1);
    await removeFact('project', fact.id);
    expect(s().memory.layers.project!.facts.some((f) => f.id === fact.id)).toBe(false);
  });

  it('settles a vote dispute with the chosen option', async () => {
    await boot();
    const stop = studio.subscribe((st) => {
      for (const c of st.confirms)
        if (c.kind === 'dispute') void answerConfirm(c.confirmId, true, c.dispute!.options[1]!.id);
    });
    const votes =
      '[[vote:redis@mock-alpha]] [[vote:postgres@mock-beta]] [[vote:sqlite@mock-gamma]] [[vote:mysql@mock-delta]]';
    const runId = await run(`which database should we use: redis or postgres? ${votes}`);
    stop();
    const r = s().runs[runId]!;
    const [nodeId, d] = Object.entries(r.disputes ?? {})[0]!;
    expect(d.status).toBe('chosen');
    expect(d.record?.by).toBe('human');
    expect(r.nodes[nodeId]?.output).toBe(
      d.record!.options.find((o) => o.id === d.record!.choice)!.label.split(' ')[0],
    );
    expect(r.controls.map((c) => c.event.type)).toEqual(
      expect.arrayContaining(['node_disputed', 'dispute_resolved']),
    );
  });

  it('replays, forks, grades and reads the evidence', async () => {
    await boot();
    const runId = await run(REAL_REQUEST);
    expect(s().runs[runId]!.verification).toMatchObject({ reviewUsd: expect.any(Number) });
    const node = 'implementation';
    // P4-F5: the estimate first (nothing spent), then that plan runs once.
    const planned = await planReplay(runId, node, {
      model: { provider: 'mock-alpha', model: 'm1' },
    });
    if (!planned.ok) throw new Error(planned.error);
    expect(planned.plan.estimate.capUsd).toBeGreaterThan(0);
    expect(s().replays[`${runId}:${node}`]).toBeUndefined();
    await runReplay(planned.plan);
    const replay = s().replays[`${runId}:${node}`];
    expect(replay?.pending).toBe(false);
    if (replay && !replay.pending) {
      expect(replay.result.replay.models[0]).toEqual({ provider: 'mock-alpha', model: 'm1' });
      expect(replay.result.original.verdicts.length).toBeGreaterThan(0);
    }
    expect(await gradeNode(runId, node, 'good', 'fine')).toBe(true);
    expect(s().grades[`${runId}:${node}`]?.graded).toMatch(/^mock-/);
    await loadEvidence();
    expect(s().evidence.accuracy?.runs.samples).toBeGreaterThanOrEqual(1);
    expect(s().evidence.competence?.length).toBeGreaterThan(0);
    await planFork(runId, 'tests', { instruction: 'add an edge case' });
    const plan = s().plan!;
    expect(plan.fork?.rerun).toContain('tests');
    expect(plan.fork?.reused).toContain(node);
    await startRun();
    const forkId = s().activeRunId!;
    expect(forkId).not.toBe(runId);
    await until(() => s().runs[forkId]?.state === 'done', 15_000);
    expect(s().runs[forkId]!.forkOf).toEqual({ runId, nodeId: 'tests' });
    expect(s().runs[forkId]!.nodes[node]?.state).toBe('done');
  });
});
