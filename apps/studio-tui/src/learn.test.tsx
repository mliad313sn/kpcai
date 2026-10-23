import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../../studio/src/connection';
import { setLocale } from '../../studio/src/i18n/core';
import { initialState, studio } from '../../studio/src/store/store';
import { FakeKernel, TOKEN, until } from '../../studio/src/test-helpers/fake-kernel';
import { kernelHandlers, PLAN } from '../../studio/src/test-helpers/fixtures';
import { MEMORY_SUMMARY } from '../../studio/src/test-helpers/learn-fixtures';
import { TuiApp } from './App';
import { keyAction } from './keys';

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
  connect(kernel.url, TOKEN, { clientName: 'kp-studio-tui' });
  ui = render(<TuiApp />);
  await until(() => s().conn === 'open');
  return kernel;
}

const frame = () => ui!.lastFrame() ?? '';
const type = async (text: string) => {
  for (const ch of text) ui!.stdin.write(ch);
  await new Promise((r) => setTimeout(r, 20));
};

const DISPUTE = {
  confirmId: 'd1',
  runId: 'r1',
  kind: 'dispute',
  question: 'Node choice is disputed.',
  dispute: {
    nodeId: 'choice',
    kind: 'vote',
    reason: 'no majority',
    options: [
      { id: 'choice-1', label: 'redis', text: 'redis\n\u001b[31mred', backers: ['a/m'] },
      { id: 'choice-2', label: 'postgres', text: 'postgres', backers: ['b/m'] },
    ],
    positions: [{ ref: 'a/m', role: 'voter', says: 'a/m votes redis' }],
  },
  timeoutMs: 60_000,
};

describe('phase 4 keys in the terminal', () => {
  it('maps numbers, y, r and grades by context', () => {
    expect(keyAction('2', {}, 'dispute')).toEqual({ kind: 'choose', index: 1 });
    expect(keyAction('y', {}, 'dispute')).toEqual({ kind: 'confirm', ok: true });
    expect(keyAction('2', {}, true)).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('r', {}, 'memory')).toEqual({ kind: 'confirm', ok: false, reject: true });
    expect(keyAction('r', {}, 'dispute')).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('y', { ctrl: true }, 'memory')).toEqual({ kind: 'confirm', ok: false });
    expect(keyAction('g', { ctrl: true }, false)).toEqual({ kind: 'grade', grade: 'good' });
    expect(keyAction('b', { ctrl: true }, false)).toEqual({ kind: 'grade', grade: 'bad' });
  });
});

describe('disputes and memory in the terminal', () => {
  it('picks an option by number, then y settles with it; y alone does not', async () => {
    const k = await boot();
    k.notify('confirm.request', DISPUTE);
    await until(() => expect(frame()).toMatch(/Node #choice: reviewers disagree/));
    expect(frame()).toMatch(/○ 1\. redis \(backed by a\/m\)/);
    expect(frame()).toMatch(/│ a\/m votes redis/);
    // Model text never drives the terminal: the escape shows as ␛.
    expect(frame()).toContain('│ ␛[31mred');
    expect(frame()).not.toContain('\u001b[31m');
    expect(frame()).toMatch(/1–2 = pick an answer/);
    await type('y');
    await until(() => expect(s().announcement.text).toMatch(/Pick an answer by its number first/));
    expect(k.calls('confirm.answer')).toHaveLength(0);
    await type('2');
    await until(() => expect(frame()).toMatch(/◉ 2\. postgres/));
    await type('y');
    await until(() => expect(k.calls('confirm.answer')).toHaveLength(1));
    expect(k.calls('confirm.answer')[0]).toEqual({ confirmId: 'd1', ok: true, choice: 'choice-2' });
  });

  it('rejects a dispute with any other key', async () => {
    const k = await boot();
    k.notify('confirm.request', DISPUTE);
    await until(() => expect(frame()).toMatch(/reviewers disagree/));
    await type('1');
    await type('\r');
    await until(() => expect(k.calls('confirm.answer')).toHaveLength(1));
    expect(k.calls('confirm.answer')[0]).toEqual({ confirmId: 'd1', ok: false });
  });

  it('quotes a memory proposal; r rejects it for good', async () => {
    const k = await boot();
    k.notify('confirm.request', {
      confirmId: 'm1',
      kind: 'memory',
      question: 'Remember this?',
      memory: {
        id: 'm-pend0001',
        layer: 'project',
        text: 'Tests sit next to sources',
        source: 'openai/model-b',
        evidence: ['run:r1'],
        localOnly: true,
      },
      timeoutMs: 60_000,
    });
    await until(() => expect(frame()).toMatch(/Proposed for project memory/));
    expect(frame()).toMatch(/│ Tests sit next to sources/);
    expect(frame()).toMatch(
      /Source: openai\/model-b \(untrusted\) · evidence: run:r1 · local only/,
    );
    expect(frame()).toMatch(/r = reject/);
    await type('r');
    await until(() => expect(k.calls('memory.reject')).toHaveLength(1));
    expect(k.calls('confirm.answer')[0]).toEqual({ confirmId: 'm1', ok: false });
  });

  it('shows the plan memory and accuracy, the disputed state and grades with Ctrl+G', async () => {
    const k = await boot({
      plan: () => ({
        ...PLAN,
        memory: MEMORY_SUMMARY,
        estimate: { ...PLAN.estimate, accuracy: 'past estimates here: 1/1 runs inside the band' },
      }),
    });
    await type('add OAuth\r');
    await until(() => expect(frame()).toMatch(/Memory: 2 facts sent to every node/));
    expect(frame()).toMatch(/Estimate accuracy: past estimates here: 1\/1 runs inside the band/);
    expect(frame()).toMatch(/⚠ 1 fact left out/);
    await type(CTRL('r'));
    await until(() => expect(s().activeRunId).toBe('r1'));
    k.notify('run.control', {
      runId: 'r1',
      event: { type: 'node_disputed', nodeId: 'impl', reason: 'split', options: [] },
    });
    await until(() => expect(frame()).toMatch(/#impl ⚖ disputed Implement it/));
    await type(CTRL('g'));
    await until(() => expect(s().announcement.text).toMatch(/Select a finished node/));
    k.notify('run.event', {
      runId: 'r1',
      event: { type: 'node_state', nodeId: 'arch', state: 'done' },
    });
    k.notify('run.done', {
      runId: 'r1',
      result: { ok: true, results: {} },
      patches: [],
      verification: {
        reviewUsd: 0,
        totalUsd: 0.01,
        share: 0,
        issuesRaised: 0,
        acceptedFindings: 0,
        usdPerAcceptedFinding: null,
      },
    });
    k.notify('run.state', { runId: 'r1', state: 'done' });
    await until(() => expect(frame()).toMatch(/Verification: review \$0/));
    await type('\t');
    await until(() => expect(s().selectedNodeId).toBe('arch'));
    await type(CTRL('g'));
    await until(() => expect(k.calls('grade')).toHaveLength(1));
    expect(k.calls('grade')[0]).toEqual({ runId: 'r1', nodeId: 'arch', grade: 'good' });
  });
});
