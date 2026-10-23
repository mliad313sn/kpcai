import { describe, expect, it } from 'vitest';
import type { GraphEvent, GraphResult, TaskGraph } from '@kernelpai/core';
import { MAX_INSTRUCTION_CHARS, withInstruction } from './control.js';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';
import type { OrchestratorOptions, RunControlEvent } from './types.js';

const A = { provider: 'a', model: 'm' };
const B = { provider: 'b', model: 'm' };
const C = { provider: 'c', model: 'm' };

/** Node "x" (title X) answers after `ms`; everything else answers at once. */
const slowX =
  (name: string, ms = 30): Script =>
  (seen) =>
    seen.prompt.includes('Task (X)')
      ? [{ delay: ms }, { text: `${name}-x` }, { end: 'end' }]
      : friendly(name)(seen);

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error('condition not reached');
}

/** a: best author, b: best critic, c: third provider. */
function harness(
  over: Partial<OrchestratorOptions> = {},
  scripts: Partial<Record<string, Script>> = {},
) {
  const adapters = [
    new RoleAdapter('a', scripts.a ?? slowX('A'), { analysis: 0.9, critique: 0.2 }),
    new RoleAdapter('b', scripts.b ?? slowX('B'), { analysis: 0.3, critique: 0.9 }),
    new RoleAdapter('c', scripts.c ?? slowX('C'), { analysis: 0.1, critique: 0.5 }),
  ];
  const control: RunControlEvent[] = [];
  let hook: (e: GraphEvent) => void = () => undefined;
  const s = setup(adapters, {
    onControl: (e) => control.push(e),
    ...over,
  });
  const events = s.events;
  s.options.onEvent = (e) => {
    events.push(e);
    hook(e);
  };
  const runner = new GraphRunner(s.options);
  const states = (id: string) =>
    events.flatMap((e) => (e.type === 'node_state' && e.nodeId === id && !e.ref ? [e.state] : []));
  const onEvent = (f: (e: GraphEvent) => void) => {
    hook = f;
  };
  const interventions = () =>
    s.journal
      .events({ sessionId: s.sessionId })
      .filter((e) => e.type === 'intervention')
      .map((e) => ({ nodeId: e.nodeId, ...e.payload }));
  return { ...s, adapters, runner, control, states, onEvent, interventions };
}

const chain = (): TaskGraph =>
  graph([gnode({ id: 'x', title: 'X' }), gnode({ id: 'y', title: 'Y', dependsOn: ['x'] })]);

const startedX = (e: GraphEvent) =>
  e.type === 'node_state' && e.nodeId === 'x' && e.state === 'running' && !e.ref;

describe('GraphRunner pause / resume / cancel (R-304)', () => {
  it('pause lets in-flight nodes finish and starts nothing new until resume', async () => {
    const h = harness();
    h.onEvent((e) => {
      if (startedX(e)) expect(h.runner.pause()).toEqual({ ok: true });
    });
    let settled = false;
    const done = h.runner.run(chain()).then((r) => ((settled = true), r));
    await until(() => h.states('x').includes('done'));
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    expect(h.runner.status()).toEqual({
      active: true,
      paused: true,
      states: { x: 'done', y: 'pending' },
      models: {},
    });
    expect(h.runner.resume()).toEqual({ ok: true });
    const r = await done;
    expect(r.ok).toBe(true);
    expect(h.control).toEqual([{ type: 'run_paused', inFlight: ['x'] }, { type: 'run_resumed' }]);
    expect(h.interventions()).toEqual([
      { nodeId: null, action: 'pause', inFlight: ['x'] },
      { nodeId: null, action: 'resume' },
    ]);
    expect(h.runner.status().active).toBe(false);
  });

  it('cancel while paused cancels the pending nodes and keeps finished work', async () => {
    const h = harness();
    h.onEvent((e) => {
      if (startedX(e)) h.runner.pause();
    });
    const done = h.runner.run(chain());
    await until(() => h.states('x').includes('done'));
    expect(h.runner.cancel()).toEqual({ ok: true });
    const r = await done;
    expect(r.states).toEqual({ x: 'done', y: 'cancelled' });
    expect(r.results['x']?.output).toBe('A-x');
    expect(h.control.at(-1)).toEqual({ type: 'run_cancelled' });
  });

  it('an aborted signal wakes a paused run', async () => {
    const h = harness();
    const ctl = new AbortController();
    h.onEvent((e) => {
      if (startedX(e)) h.runner.pause();
    });
    const done = h.runner.run(chain(), { signal: ctl.signal });
    await until(() => h.states('x').includes('done'));
    ctl.abort();
    expect((await done).states).toEqual({ x: 'done', y: 'cancelled' });
  });

  it('refuses control actions that do not apply, with a journaled reason', async () => {
    const h = harness();
    const none = { ok: false, reason: 'no active run' };
    expect(h.runner.pause()).toEqual(none);
    expect(h.runner.resume()).toEqual(none);
    expect(h.runner.cancel()).toEqual(none);
    expect(h.runner.addInstruction('x', 'hi')).toEqual(none);
    expect(await h.runner.redirect('x', A)).toEqual(none);
    expect(h.runner.status()).toEqual({ active: false, paused: false, states: {}, models: {} });
    const out: unknown[] = [];
    h.onEvent((e) => {
      if (!startedX(e)) return;
      out.push(h.runner.resume(), h.runner.pause(), h.runner.pause(), h.runner.cancel());
      out.push(h.runner.cancel(), h.runner.pause());
    });
    await h.runner.run(chain());
    expect(out).toEqual([
      { ok: false, reason: 'not paused' },
      { ok: true },
      { ok: false, reason: 'already paused' },
      { ok: true },
      { ok: false, reason: 'already cancelled' },
      { ok: false, reason: 'run cancelled' },
    ]);
    expect(h.control).toContainEqual({
      type: 'control_refused',
      action: 'pause',
      reason: 'already paused',
    });
    expect(h.interventions()).toContainEqual({
      nodeId: null,
      action: 'resume refused',
      reason: 'not paused',
    });
  });

  it('refuses a second concurrent run on the same runner', async () => {
    const h = harness();
    const first = h.runner.run(chain());
    await expect(h.runner.run(chain())).rejects.toThrow('already running a graph');
    expect((await first).ok).toBe(true);
  });
});

/** Runs `chain()` and calls `act` once x has started; returns the result and act's value. */
async function whileXRuns<T>(h: ReturnType<typeof harness>, act: () => Promise<T> | T) {
  let got: Promise<T> | undefined;
  h.onEvent((e) => {
    if (startedX(e) && !got) got = Promise.resolve(act());
  });
  const r: GraphResult = await h.runner.run(chain());
  return { r, value: await (got as Promise<T>) };
}

describe('GraphRunner redirect (principle 4)', () => {
  it('moves a pending node to the chosen model', async () => {
    const h = harness();
    const { r, value } = await whileXRuns(h, () => h.runner.redirect('y', C));
    expect(value).toEqual({ ok: true });
    expect(r.ok).toBe(true);
    expect(r.results['y']?.contributions.map((c) => c.ref)).toEqual([C]);
    expect(h.control).toEqual([
      { type: 'node_redirected', nodeId: 'y', from: A, to: C, restarted: false, reroutes: [] },
    ]);
    const redirect = h.interventions().find((i) => i.action === 'redirect');
    expect(redirect).toMatchObject({ nodeId: 'y', from: 'a/m', to: 'c/m', restarted: false });
  });

  it('cancels a running attempt and reruns it on the chosen model, keeping the partial work', async () => {
    const hang: Script = (seen) => [{ text: `partial:${seen.role}` }, { hang: true }];
    const h = harness({}, { a: hang });
    let redirected: Promise<unknown> | undefined;
    h.onEvent((e) => {
      if (e.type === 'text' && e.ref.provider === 'a' && !redirected) {
        redirected = h.runner.redirect('n1', B);
      }
    });
    const r = await h.runner.run(graph([gnode()]));
    expect(await redirected).toEqual({ ok: true });
    expect(r.ok).toBe(true);
    expect(r.results['n1']?.output).toBe('B:author:0');
    const res = r.results['n1'];
    expect(res?.contributions.map((c) => [c.ref.provider, c.text])).toEqual([
      ['a', 'partial:author'],
      ['b', 'B:author:0'],
    ]);
    expect(res?.costUsd).toBeCloseTo(
      res!.contributions.reduce((a, c) => a + c.costUsd, 0),
      6,
    );
    expect(h.states('n1')).toEqual(['pending', 'running', 'pending', 'running', 'done']);
    expect(h.control[0]).toMatchObject({ type: 'node_redirected', restarted: true, to: B });
    expect(h.runner.status().models).toEqual({});
  });

  it('re-routes the critic when the author moves to the critic provider (principle 2)', async () => {
    const h = harness();
    const g = graph([
      gnode({ id: 'x', title: 'X' }),
      gnode({ id: 'y', title: 'Y', dependsOn: ['x'], protocol: 'author_critic' }),
    ]);
    let got: Promise<unknown> | undefined;
    h.onEvent((e) => {
      if (startedX(e) && !got) got = h.runner.redirect('y', B);
    });
    const r = await h.runner.run(g);
    expect(await got).toEqual({ ok: true });
    expect(h.control[0]).toMatchObject({
      reroutes: [
        { role: 'critic', from: B, to: C },
        { role: 'revision', from: A, to: B },
      ],
    });
    expect(r.results['y']?.contributions.map((c) => `${c.role}@${c.ref.provider}`)).toEqual([
      'author@b',
      'critic@c',
    ]);
  });

  it('refuses a redirect that would break principle 2', async () => {
    const h = harness();
    const g = graph([
      gnode({ id: 'x', title: 'X' }),
      gnode({ id: 'r', title: 'R', type: 'critique', dependsOn: ['x'] }),
    ]);
    let got: Promise<unknown> | undefined;
    h.onEvent((e) => {
      if (startedX(e) && !got) got = h.runner.redirect('r', A);
    });
    const r = await h.runner.run(g);
    expect(await got).toEqual({
      ok: false,
      reason:
        'cannot run on a/m: solo: no provider other than a (principle 2; allowSameProvider waives it)',
    });
    expect(r.results['r']?.contributions[0]?.ref.provider).not.toBe('a');
  });

  it('refuses a redirect the budget hook declines', async () => {
    const labels: string[] = [];
    const h = harness({
      budget: (_c, label) => (labels.push(label), !label.startsWith('redirect')),
    });
    const { r, value } = await whileXRuns(h, () => h.runner.redirect('y', C));
    expect(value).toMatchObject({ ok: false });
    expect((value as { reason: string }).reason).toMatch(
      /^budget: redirect y to c\/m: estimate \$[\d.e-]+ not allowed$/,
    );
    expect(r.results['y']?.contributions[0]?.ref).toEqual(A);
    expect(h.runner.status().models).toEqual({});
  });

  it('checks maxGraphUsd: refused without a hook, asked as a graph total with one', async () => {
    const dear = new RoleAdapter(
      'e',
      friendly('E'),
      {},
      { inputPerMTok: 1000, outputPerMTok: 2000 },
    );
    const capped = harness({ maxGraphUsd: 0.01 });
    capped.options.candidates = [...capped.options.candidates, dear.candidate];
    const refused = await whileXRuns(capped, () => capped.runner.redirect('y', dear.ref));
    expect((refused.value as { reason: string }).reason).toMatch(
      /^budget: graph total: \$[\d.]+ would exceed maxGraphUsd \$0\.01 \(redirect y to e\/m\)$/,
    );
    const labels: string[] = [];
    const asked = harness({ maxGraphUsd: 0.01, budget: (_c, l) => (labels.push(l), true) });
    const real = asked.options.resolve;
    asked.options.candidates = [...asked.options.candidates, dear.candidate];
    asked.options.resolve = (ref) => (ref.provider === 'e' ? dear : real(ref));
    const runner = new GraphRunner(asked.options);
    let got: Promise<unknown> | undefined;
    asked.onEvent((e) => {
      if (startedX(e) && !got) got = runner.redirect('y', dear.ref);
    });
    const r = await runner.run(chain());
    expect(await got).toEqual({ ok: true });
    expect(labels.some((l) => /^graph total: .*\(redirect y to e\/m\)$/.test(l))).toBe(true);
    expect(r.results['y']?.contributions[0]?.ref).toEqual(dear.ref);
  });

  it('refuses finished nodes, unknown nodes and unknown models', async () => {
    const h = harness();
    let out: unknown[] = [];
    h.onEvent((e) => {
      if (e.type === 'node_state' && e.nodeId === 'y' && e.state === 'running' && !e.ref) {
        out = [h.runner.redirect('x', B), h.runner.redirect('nope', B)];
        out.push(h.runner.redirect('y', { provider: 'z', model: 'm' }));
      }
    });
    await h.runner.run(chain());
    expect(await Promise.all(out)).toEqual([
      { ok: false, reason: 'node "x" is done; finished work is kept' },
      { ok: false, reason: 'unknown node "nope"' },
      { ok: false, reason: 'model z/m is not available' },
    ]);
  });

  it('refuses when the node finished while the budget hook was deciding', async () => {
    let release: (v: boolean) => void = () => undefined;
    const h = harness({
      budget: (_c, label) =>
        label.startsWith('redirect') ? new Promise<boolean>((r) => (release = r)) : true,
    });
    let got: Promise<unknown> | undefined;
    h.onEvent((e) => {
      if (startedX(e) && !got) got = h.runner.redirect('x', B);
      if (e.type === 'node_state' && e.nodeId === 'x' && e.state === 'done') release(true);
    });
    await h.runner.run(chain());
    expect(await got).toEqual({ ok: false, reason: 'node "x" is done; finished work is kept' });
  });
});

describe('GraphRunner addInstruction (R-304)', () => {
  it('appends a human instruction to a pending node and journals it', async () => {
    const h = harness();
    const { r, value } = await whileXRuns(h, () =>
      h.runner.addInstruction('y', '  Use TypeScript '),
    );
    expect(value).toEqual({ ok: true });
    expect(r.ok).toBe(true);
    const prompt = h.adapters[0]!.seen.find((v) => v.prompt.includes('Task (Y)'))?.prompt ?? '';
    expect(prompt).toContain(
      'Do the thing\n\nInstruction added by the user during the run:\nUse TypeScript',
    );
    expect(prompt.indexOf('Use TypeScript')).toBeLessThan(
      prompt.indexOf('Results of earlier steps'),
    );
    expect(h.interventions()).toContainEqual({
      nodeId: 'y',
      action: 'instruction added',
      text: 'Use TypeScript',
    });
    expect(h.control).toEqual([{ type: 'instruction_added', nodeId: 'y', text: 'Use TypeScript' }]);
  });

  it('refuses running nodes, unknown nodes, empty and oversized text', async () => {
    const h = harness();
    const { value } = await whileXRuns(h, () => [
      h.runner.addInstruction('x', 'later'),
      h.runner.addInstruction('ghost', 'hi'),
      h.runner.addInstruction('y', '   '),
      h.runner.addInstruction('y', 'x'.repeat(MAX_INSTRUCTION_CHARS + 1)),
    ]);
    expect(value.map((v) => (v.ok ? 'ok' : v.reason))).toEqual([
      'node "x" is running; instructions go to pending nodes',
      'unknown node "ghost"',
      'empty instruction',
      `instruction longer than ${MAX_INSTRUCTION_CHARS} characters`,
    ]);
  });

  it('adds a user message when the node has none', () => {
    const n = withInstruction(gnode({ messages: [{ role: 'system', content: 'sys' }] }), 'go');
    expect(n.messages.at(-1)).toEqual({
      role: 'user',
      content: 'Instruction added by the user during the run:\ngo',
    });
  });
});
