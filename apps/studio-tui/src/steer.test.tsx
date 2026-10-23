import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../../studio/src/connection';
import { setLocale } from '../../studio/src/i18n/core';
import { initialState, studio } from '../../studio/src/store/store';
import { FakeKernel, TOKEN, until } from '../../studio/src/test-helpers/fake-kernel';
import { PATCH, kernelHandlers } from '../../studio/src/test-helpers/fixtures';
import { TuiApp } from './App';

const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);
const ESC = '\u001b';
const s = () => studio.getState();

let kernel: FakeKernel | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(async () => {
  ui?.unmount();
  disconnect();
  await kernel?.stop();
  setLocale('en');
});

const frame = () => ui!.lastFrame() ?? '';
const type = async (text: string) => {
  for (const ch of text) ui!.stdin.write(ch);
  await new Promise((r) => setTimeout(r, 20));
};

/** Plans, runs, and leaves #arch done, #impl running with openai/model-b, #tests waiting. */
async function running(): Promise<FakeKernel> {
  studio.setState(initialState(), true);
  setLocale('en');
  const k = await new FakeKernel(kernelHandlers()).start();
  kernel = k;
  connect(k.url, TOKEN, { clientName: 'kp-studio-tui' });
  ui = render(<TuiApp />);
  await until(() => s().conn === 'open');
  await type('add OAuth\r');
  await until(() => expect(s().plan).toBeDefined());
  await type(CTRL('r'));
  await until(() => expect(s().activeRunId).toBe('r1'));
  const ref = { provider: 'openai', model: 'model-b' };
  k.notify('run.state', { runId: 'r1', state: 'running' });
  k.notify('run.event', {
    runId: 'r1',
    event: { type: 'node_state', nodeId: 'arch', state: 'done' },
  });
  k.notify('run.event', {
    runId: 'r1',
    event: { type: 'node_state', nodeId: 'impl', state: 'running', ref, role: 'author' },
  });
  await until(() => expect(frame()).toMatch(/#impl ▶ running/));
  return k;
}

describe('KP Studio in the terminal: cost, diff and steering', () => {
  it('shows spend against the cap and flags spend above the band (D-021)', async () => {
    const k = await running();
    expect(frame()).toMatch(/Spent \$0 of cap \$0\.50 · band \$0\.12–\$0\.50/);
    const ref = { provider: 'openai', model: 'model-b' };
    k.notify('run.event', {
      runId: 'r1',
      event: {
        type: 'contribution',
        nodeId: 'impl',
        contribution: { role: 'author', ref, text: 'x', costUsd: 0.6 },
      },
    });
    await until(() => expect(frame()).toMatch(/Spent \$0\.60 of cap \$0\.50 · ⚠ above the band/));
  });

  it('adds an instruction to a waiting node and refuses one for a started node', async () => {
    const k = await running();
    await type(CTRL('n'));
    await until(() => expect(s().announcement.text).toMatch(/Select a node of the run with Tab/));
    await type('\t\t');
    await until(() => expect(s().selectedNodeId).toBe('impl'));
    await type(CTRL('n'));
    await until(() => expect(s().announcement.text).toMatch(/#impl has started/));
    await type('\t');
    await type(CTRL('n'));
    await until(() => expect(frame()).toMatch(/Instruction for #tests › added to this node/));
    await type('use vitest\r');
    await until(() =>
      expect(k.calls('run.instruct')).toEqual([
        { runId: 'r1', nodeId: 'tests', text: 'use vitest' },
      ]),
    );
    await until(() => expect(s().announcement.text).toBe('Instruction sent to node tests'));
    expect(frame()).toMatch(/Request › describe a task/);
  });

  it('redirects the selected node to a model typed as provider/model; Esc cancels', async () => {
    const k = await running();
    await type('\t\t');
    await type(CTRL('t'));
    await until(() => expect(frame()).toMatch(/Redirect #impl to › provider\/model/));
    await until(() => expect(frame()).toMatch(/Models: anthropic\/model-a, anthropic\/model-e/));
    await type('nomodel\r');
    await until(() => expect(s().announcement.text).toBe('Type the model as provider/model.'));
    await type(ESC);
    await until(() => expect(frame()).toMatch(/Request › /));
    await type(CTRL('t'));
    await type('anthropic/model-a\r');
    await until(() =>
      expect(k.calls('run.redirect')).toEqual([
        { runId: 'r1', nodeId: 'impl', to: { provider: 'anthropic', model: 'model-a' } },
      ]),
    );
  });

  it('announces patches with terminal keys, shows the diff and applies pending ones', async () => {
    const k = await running();
    k.notify('run.done', {
      runId: 'r1',
      result: { ok: true, results: { impl: { output: 'final', approved: true } } },
      patches: [
        { nodeId: 'impl', patch: PATCH, files: ['src/auth.ts'] },
        { nodeId: 'tests', patch: '+x', files: [] },
      ],
    });
    await until(() =>
      expect(s().announcement.text).toBe('2 patches ready: Ctrl+O shows them, Ctrl+A applies them'),
    );
    await type(CTRL('o'));
    await until(() => expect(frame()).toMatch(/Diff · 2 patches/));
    expect(frame()).toMatch(/#impl · 1 file · not applied/);
    expect(frame()).toContain('+const token = "<script>alert(1)</script>";');
    expect(frame()).toMatch(/Ctrl\+A applies the 2 pending patches/);
    await type(CTRL('a'));
    await until(() =>
      expect(k.calls('patches.apply')).toEqual([{ runId: 'r1', nodeIds: ['impl', 'tests'] }]),
    );
    await until(() => expect(frame()).toMatch(/#impl · 1 file · ✓ Applied/));
    expect(frame()).toMatch(/Esc or Ctrl\+O closes the diff/);
    await type(CTRL('a'));
    await until(() => expect(s().announcement.text).toMatch(/^No patch to apply yet/));
    await type(ESC);
    await until(() => expect(frame()).toMatch(/Thread · /));
  });
});
