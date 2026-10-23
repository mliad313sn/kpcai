import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../../studio/src/connection';
import { setLocale } from '../../studio/src/i18n/core';
import { initialState, studio } from '../../studio/src/store/store';
import { FakeKernel, TOKEN, until } from '../../studio/src/test-helpers/fake-kernel';
import { PATCH, kernelHandlers } from '../../studio/src/test-helpers/fixtures';
import { TuiApp } from './App';

const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const s = () => studio.getState();

let kernel: FakeKernel | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(async () => {
  ui?.unmount();
  disconnect();
  await kernel?.stop();
  setLocale('en');
});

async function boot(handlers: Record<string, (p: unknown) => unknown> = {}) {
  studio.setState(initialState(), true);
  setLocale('en');
  kernel = await new FakeKernel({ ...kernelHandlers(), ...handlers }).start();
  // Node's own WebSocket, as in `kp-studio-tui`.
  connect(kernel.url, TOKEN, { clientName: 'kp-studio-tui' });
  ui = render(<TuiApp />);
  await until(() => s().conn === 'open');
  return { k: kernel, ui };
}

const frame = () => ui!.lastFrame() ?? '';
const type = async (text: string) => {
  for (const ch of text) ui!.stdin.write(ch);
  await new Promise((r) => setTimeout(r, 20));
};

describe('KP Studio in the terminal', () => {
  it('plans from the request line and shows nodes, likely cost and cap', async () => {
    const { k } = await boot();
    await until(() => expect(frame()).toMatch(/Connected to KernelPAI kernel/));
    expect(frame()).toMatch(/No plan yet/);
    await type('add OAuth');
    expect(frame()).toMatch(/Request › add OAuth/);
    await type('\r');
    await until(() => expect(k.calls('plan')).toHaveLength(1));
    await until(() =>
      expect(frame()).toMatch(
        /Estimate: likely \$0\.40 · at most \$0\.50 \(hard cap\) · partly calibrated/,
      ),
    );
    expect(frame()).toMatch(/#impl Implement it · author_critic · openai\/model-b/);
    await type('\t');
    await until(() => expect(frame()).toMatch(/Selected #arch: none/));
    await type('\t');
    await until(() => expect(frame()).toMatch(/Selected #impl: best code score within budget/));
  });

  it('runs with Ctrl+R, shows the live thread and agents, pauses and cancels', async () => {
    const { k } = await boot();
    await type('add OAuth\r');
    await until(() => expect(s().plan).toBeDefined());
    await type(CTRL('r'));
    await until(() => expect(s().activeRunId).toBe('r1'));
    const ref = { provider: 'openai', model: 'model-b' };
    k.notify('run.state', { runId: 'r1', state: 'running' });
    k.notify('run.event', {
      runId: 'r1',
      event: { type: 'node_state', nodeId: 'impl', state: 'running', ref, role: 'author' },
    });
    k.notify('run.event', {
      runId: 'r1',
      event: { type: 'text', nodeId: 'impl', role: 'author', ref, delta: 'line one\n<b>two</b>' },
    });
    await until(() => expect(frame()).toMatch(/#impl ▶ running Implement it · openai\/model-b/));
    expect(frame()).toMatch(/<b>two<\/b>/);
    expect(frame()).toMatch(/openai\/model-b · #impl author/);
    await type(CTRL('p'));
    await until(() => expect(k.calls('run.pause')).toHaveLength(1));
    k.notify('run.state', { runId: 'r1', state: 'paused' });
    k.notify('run.control', { runId: 'r1', event: { type: 'run_paused', inFlight: ['impl'] } });
    await until(() => expect(frame()).toMatch(/Paused: nothing new starts; still finishing #impl/));
    await type(CTRL('p'));
    await until(() => expect(k.calls('run.resume')).toHaveLength(1));
    await type(CTRL('x'));
    await until(() => expect(k.calls('run.cancel')).toHaveLength(1));
  });

  it('asks confirmations with No as the default and shows the diff as text', async () => {
    const { k } = await boot();
    const ask = (id: string) =>
      k.notify('confirm.request', {
        confirmId: id,
        kind: 'patch',
        question: 'git.apply on src/auth.ts?',
        risk: 'write',
        patch: PATCH,
        timeoutMs: 60_000,
      });
    ask('c1');
    await until(() => expect(frame()).toMatch(/Confirmation: Apply patch\?/));
    expect(frame()).toMatch(/Risk: Writes files/);
    expect(frame()).toContain('+const token = "<script>alert(1)</script>";');
    expect(frame()).toMatch(/y = yes · n, Esc or Enter = no \(default\)/);
    await type('\r');
    await until(() => expect(k.calls('confirm.answer')).toEqual([{ confirmId: 'c1', ok: false }]));
    ask('c2');
    await until(() => expect(s().confirms).toHaveLength(1));
    await type('y');
    await until(() =>
      expect(k.calls('confirm.answer').at(-1)).toEqual({ confirmId: 'c2', ok: true }),
    );
  });

  it('declines by itself when the confirmation times out', async () => {
    const { k } = await boot();
    k.notify('confirm.request', {
      confirmId: 'c3',
      kind: 'budget',
      question: 'Spend up to $1?',
      timeoutMs: 80,
    });
    await until(() => expect(k.calls('confirm.answer')).toEqual([{ confirmId: 'c3', ok: false }]));
  });

  it("closes a cancelled run's confirmation: y no longer allows it (P3-F2)", async () => {
    const { k } = await boot();
    k.notify('confirm.request', {
      confirmId: 'c5',
      runId: 'r1',
      kind: 'tool',
      question: 'shell.exec rm -rf build?',
      risk: 'destructive',
      timeoutMs: 60_000,
    });
    await until(() => expect(frame()).toMatch(/Confirmation: Tool permission/));
    k.notify('run.state', { runId: 'r1', state: 'cancelling' });
    await until(() => expect(frame()).not.toMatch(/Confirmation: Tool permission/));
    expect(frame()).toMatch(/Run cancelled: its pending confirmation was answered No/);
    await type('y');
    await until(() => expect(k.calls('confirm.answer')).toEqual([{ confirmId: 'c5', ok: false }]));
  });

  it('speaks French when asked', async () => {
    await boot();
    setLocale('fr');
    await type('x');
    await until(() => expect(frame()).toMatch(/Demande › x/));
    expect(frame()).toMatch(/Ctrl\+R lancer/);
  });
});
