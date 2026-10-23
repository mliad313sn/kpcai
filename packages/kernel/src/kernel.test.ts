import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Kernel } from './kernel.js';
import { KernelError } from './errors.js';
import { REQ, TEST_OPTIONS, recordingHost } from './test-helpers/fixture.js';

const CHEAP = { KPAI_CONFIRM_ABOVE_USD: '100' };

const code = (p: Promise<unknown> | (() => unknown)): Promise<string | undefined> =>
  (typeof p === 'function' ? Promise.resolve().then(p) : p).then(
    () => undefined,
    (e: unknown) => (e instanceof KernelError ? e.code : String(e)),
  );

describe('Kernel.plan', () => {
  it('returns a plan with band, routing reason and score per node (R-302, R-303)', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(p.planId).toMatch(/[0-9a-f-]{36}/);
    expect(p.graph.nodes.map((n) => n.id)).toContain('implementation');
    const impl = p.estimate.nodes.find((n) => n.nodeId === 'implementation');
    expect(impl?.ref?.provider).toBe('mock-beta');
    expect(impl?.reason).toMatch(/mock-beta\/m1/);
    expect(typeof impl?.score).toBe('number');
    expect(impl?.runnerUp?.ref.provider).toBeTruthy();
    expect(p.estimate.band.highUsd).toBeGreaterThanOrEqual(p.estimate.band.lowUsd);
    await k.close();
  });

  it('budget-gates a model planner and reports unavailable providers when verbose', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const p = await k.plan(REQ, { ...TEST_OPTIONS, planner: 'model', verbose: true });
    expect(p.graph.nodes.length).toBeGreaterThan(0);
    expect(host.said.join('')).toMatch(/planning with a model: this is a paid call/);
    await k.close();
  });

  it('guards the workspace before a paid model planner', async () => {
    const host = recordingHost(CHEAP);
    host.cwd = mkdtempSync(join(tmpdir(), 'kpai-not-a-project-'));
    const k = new Kernel(host);
    expect(await code(k.plan(REQ, { ...TEST_OPTIONS, planner: 'model' }))).toBe('workspace');
    expect(await code(k.startRun({ request: REQ, options: TEST_OPTIONS }))).toBe('workspace');
    await k.close();
  });
});

describe('Kernel.startRun', () => {
  it('runs an approved plan: planned, events with reasons and tokens, patches', async () => {
    const host = recordingHost(CHEAP);
    const planned: string[] = [];
    host.onRunPlanned = (runId) => void planned.push(runId);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    const h = await k.startRun({ request: REQ, planId: p.planId });
    expect(planned).toEqual([h.runId]);
    const o = await h.done;
    expect(o.status).toBe('finished');
    if (o.status !== 'finished') return;
    expect(o.result.ok).toBe(true);
    expect(o.patches.map((x) => x.files).flat()).toEqual(['src/s.ts', 'test/s.test.ts']);
    expect(host.states).toEqual(['running', 'done']);
    const working = host.events.find((e) => e.event.type === 'node_state' && e.event.reason);
    expect(working?.event.score).toEqual(expect.any(Number));
    const contrib = host.events.find((e) => e.event.type === 'contribution' && e.event.usage);
    expect(contrib?.event.usage?.outputTokens).toBeGreaterThan(0);
    expect(k.runInfo(h.runId).state).toBe('done');
    expect(k.cancel(h.runId)).toBe(false);
    await k.close();
  });

  it('applies approved patches: confirmed with the diff, or pre-approved by yesApply', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    await h.done;
    const declined = await k.applyPatches(h.runId);
    expect(declined.every((r) => !r.ok)).toBe(true);
    const asked = host.asked.find((a) => a.kind === 'patch');
    expect(asked).toMatchObject({ risk: 'write', runId: h.runId });
    expect(asked?.patch).toMatch(/^diff --git/);
    expect(await code(k.applyPatches(h.runId, { nodeIds: ['nope'] }))).toBe('not_found');
    const done = await k.applyPatches(h.runId, { nodeIds: ['implementation'], yesApply: true });
    expect(done).toEqual([expect.objectContaining({ nodeId: 'implementation', ok: true })]);
    expect(existsSync(join(host.cwd, 'src/s.ts'))).toBe(true);
    await k.close();
  });

  it('refuses unknown or mismatched plans, unroutable plans and edits without a plan', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    expect(await code(k.startRun({ request: REQ, planId: 'nope' }))).toBe('not_found');
    const p = await k.plan(REQ, TEST_OPTIONS);
    expect(await code(k.startRun({ request: 'other', planId: p.planId }))).toBe('invalid');
    expect(await code(k.startRun({ request: REQ, graph: p.graph }))).toBe('invalid');
    const only = { ...TEST_OPTIONS, exclude: ['mock', 'mock-alpha', 'mock-beta', 'mock-gamma'] };
    expect(await code(k.startRun({ request: 'draft an email', options: only }))).toBe('unroutable');
    expect(await code(() => k.cancel('nope'))).toBe('not_found');
    expect(await code(() => k.validatePlan('nope', {}))).toBe('not_found');
    await k.close();
  });

  it('asks before an expensive graph and does not run when declined', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    const o = await h.done;
    expect(o).toMatchObject({ status: 'not_run', reason: expect.stringMatching(/threshold/) });
    expect(host.asked[0]).toMatchObject({ kind: 'budget', runId: h.runId });
    expect(host.states).toEqual(['cancelled']);
    expect(await code(k.applyPatches(h.runId))).toBe('refused');
    await k.close();
  });

  it('blocks over budget unless overBudget', async () => {
    const host = recordingHost({ ...CHEAP, KPAI_BUDGET_SESSION_USD: '0.0001' });
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    expect((await h.done).status).toBe('not_run');
    expect(host.said.join('')).toMatch(/graph blocked by session budget/);
    const over = await k.startRun({ request: REQ, options: { ...TEST_OPTIONS, overBudget: true } });
    expect((await over.done).status).toBe('finished');
    await k.close();
  });
});

describe('Kernel steering (R-304)', () => {
  it('cancels before the run starts: nothing is applied afterwards', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    host.fallback = true;
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    expect(await code(() => k.pause(h.runId))).toBe('refused');
    expect(k.cancel(h.runId)).toBe(true);
    expect(k.cancel(h.runId)).toBe(false);
    const o = await h.done;
    expect(o).toMatchObject({ status: 'finished', cancelled: true });
    expect(host.states.at(-1)).toBe('cancelled');
    expect(await code(k.applyPatches(h.runId))).toBe('refused');
    await k.close();
  });

  it('pauses, instructs, redirects and resumes a live run through GraphRunner', async () => {
    const host = recordingHost({ KPAI_CONFIRM_ABOVE_USD: '0' });
    const controls: string[] = [];
    host.onControl = (_r, e) => void controls.push(e.type);
    let release: (() => void) | undefined;
    let first = true;
    host.confirm = (req) => {
      host.asked.push(req);
      if (req.kind === 'budget' && !first) return Promise.resolve(true);
      if (first && req.question.includes('graph estimate')) return Promise.resolve(true);
      first = false;
      return new Promise((r) => (release = () => r(true)));
    };
    const k = new Kernel(host);
    const h = await k.startRun({ request: REQ, options: TEST_OPTIONS });
    while (!release) await new Promise((r) => setTimeout(r, 5));
    k.pause(h.runId);
    expect(k.runInfo(h.runId).state).toBe('paused');
    expect(await code(() => k.pause(h.runId))).toBe('refused');
    // Confirmations are serialized: the held one must be answered before a redirect asks.
    release();
    await new Promise((r) => setTimeout(r, 50));
    k.instruct(h.runId, 'review', 'check the state parameter length');
    await k.redirect(h.runId, 'tests', { provider: 'mock-alpha', model: 'm1' });
    expect(await code(k.redirect(h.runId, 'tests', { provider: 'nope', model: 'x' }))).toBe(
      'refused',
    );
    k.resume(h.runId);
    const o = await h.done;
    expect(o.status).toBe('finished');
    expect(controls).toEqual(
      expect.arrayContaining(['run_paused', 'instruction_added', 'node_redirected', 'run_resumed']),
    );
    expect(host.states).toEqual(expect.arrayContaining(['paused', 'running']));
    expect(await code(() => k.resume(h.runId))).toBe('refused');
    await k.close();
  });
});

describe('Kernel editable plans (R-301)', () => {
  it('validates an edit, then runs exactly the edited plan with the chosen model', async () => {
    const host = recordingHost(CHEAP);
    const k = new Kernel(host);
    const p = await k.plan(REQ, TEST_OPTIONS);
    const nodes = p.graph.nodes.map((n) =>
      n.id === 'tests' ? { ...n, model: { provider: 'mock-alpha', model: 'm1' } } : n,
    );
    const check = k.validatePlan(p.planId, { nodes });
    expect(check.ok).toBe(true);
    expect(check.changes).toEqual(['tests: model routed → mock-alpha/m1']);
    const bad = k.validatePlan(p.planId, { nodes: [{ id: 'x' }] });
    expect(bad.ok).toBe(false);
    expect(await code(k.startRun({ request: REQ, planId: p.planId, graph: { nodes: [] } }))).toBe(
      'invalid',
    );
    const h = await k.startRun({ request: REQ, planId: p.planId, graph: { nodes } });
    await h.done;
    const tests = host.events.find(
      (e) => e.event.type === 'node_state' && e.event.nodeId === 'tests' && e.event.ref,
    );
    expect(tests?.event).toMatchObject({ ref: { provider: 'mock-alpha' } });
    const edited = k
      .events(p.sessionId)
      .find(
        (e) =>
          e.type === 'intervention' && (e.payload as { action?: string }).action === 'plan edited',
      );
    expect(edited).toBeDefined();
    await k.close();
  });
});
