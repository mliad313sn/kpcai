// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { PATCH } from '../test-helpers/fixtures';
import { renderStudio, scriptRunStart, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

async function planAndRun(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'add OAuth{Enter}');
  const run = await screen.findByRole('button', { name: 'Run (cap $0.40)' });
  await user.click(run);
  await until(() => studio.getState().activeRunId === 'r1');
}

describe('KP Studio layout', () => {
  it('has the five zones as landmarks and a welcome state', async () => {
    ({ kernel } = await renderStudio());
    expect(screen.getByRole('heading', { level: 1, name: 'KP Studio' })).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Command bar' })).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    for (const name of ['Explorer', 'Workspace', 'Agents', 'Execution thread'])
      expect(screen.getByRole('region', { name })).toBeTruthy();
    expect(screen.getByText('Connected to KernelPAI kernel')).toBeTruthy();
    expect(screen.getByText(/is connected to the KernelPAI kernel/)).toBeTruthy();
    expect(await screen.findByText('add OAuth')).toBeTruthy(); // session in the explorer
    expect(document.title).toBe('KP Studio');
  });

  it('plans first and shows the graph and cost range before running', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'add OAuth{Enter}');
    const thread = screen.getByRole('region', { name: 'Execution thread' });
    await within(thread).findByText('Design the OAuth flow');
    expect(within(thread).getAllByText('planned').length).toBeGreaterThanOrEqual(3);
    expect(within(thread).getByText(/Estimate \$0\.12–\$0\.35/)).toBeTruthy();
    expect(within(thread).getByText('est. $0.09–$0.30')).toBeTruthy();
    expect(kernel.calls('run.start')).toEqual([]);
    expect(screen.getByRole('status').textContent).toMatch(/Plan ready/);
    await user.click(screen.getByRole('button', { name: 'Run (cap $0.40)' }));
    await until(() => kernel!.calls('run.start').length === 1);
  });

  it('can discard a plan', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'x{Enter}');
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(screen.getByText(/task graph appears here/)).toBeTruthy();
  });

  it('shows a live run: node states with text, agents board, streamed output', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await planAndRun(user);
    scriptRunStart(kernel);
    const agents = screen.getByRole('region', { name: 'Agents' });
    await within(agents).findByText('model-b');
    expect(within(agents).getByText('#impl')).toBeTruthy();
    expect(within(agents).getByText('0.90')).toBeTruthy();
    expect(within(agents).getByText('running')).toBeTruthy();
    const thread = screen.getByRole('region', { name: 'Execution thread' });
    expect(within(thread).getByText('done')).toBeTruthy();
    await until(() => expect(document.title).toBe('KP Studio — running'));
    // Streamed model text is rendered as text, never as HTML.
    expect(await screen.findByText('export const <i>x</i>')).toBeTruthy();
    expect(document.querySelector('.output i')).toBeNull();
  });

  it('opens a node detail with routing, prompt as text, redirect and run controls', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await planAndRun(user);
    scriptRunStart(kernel);
    await screen.findByText('model-b');
    await user.click(screen.getByRole('button', { name: /#impl/, pressed: false }));
    const detail = screen.getByRole('complementary', { name: /#impl/ });
    expect(within(detail).getByText(/Protocol upgraded: code nodes/)).toBeTruthy();
    expect(within(detail).getByText('google/model-c')).toBeTruthy();
    await user.click(within(detail).getByRole('button', { name: 'Redirect to…' }));
    await user.type(within(detail).getByLabelText('Model'), 'anthropic/model-a{Enter}');
    await until(() => kernel!.calls('run.redirect').length === 1);
    expect(kernel.calls('run.redirect')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      to: { provider: 'anthropic', model: 'model-a' },
    });
    await user.click(within(detail).getByRole('button', { name: /Pause/ }));
    await until(() => kernel!.calls('run.pause').length === 1);
    kernel.notify('run.state', { runId: 'r1', state: 'paused' });
    await user.click(await within(detail).findByRole('button', { name: /Resume/ }));
    await user.click(within(detail).getByRole('button', { name: /Cancel/ }));
    await until(() => kernel!.calls('run.cancel').length === 1);
    await user.click(within(detail).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('shows the prompt of a planned node as text', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'x{Enter}');
    await user.click(await screen.findByRole('button', { name: /#arch/ }));
    const detail = screen.getByRole('complementary');
    expect(within(detail).getByText(/Design <b>OAuth<\/b>/)).toBeTruthy();
    expect(detail.querySelector('b')).toBeNull();
    expect(within(detail).getByText(/No routing reason for this node/)).toBeTruthy();
    // Arrow keys move between nodes.
    screen.getByRole('button', { name: /#arch/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.id).toBe('node-impl');
  });

  it('shows patches exactly as received and applies them', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await planAndRun(user);
    kernel.notify('run.done', {
      runId: 'r1',
      result: { ok: true, results: { impl: { output: 'final', approved: true } } },
      patches: [
        { nodeId: 'impl', patch: PATCH, files: ['src/auth.ts'] },
        { nodeId: 'tests', patch: '+x', files: [] },
      ],
    });
    const tab = await screen.findByRole('tab', { name: 'Diff (2)' });
    await user.click(tab);
    const pre = document.querySelector('pre.diff')!;
    expect(pre.textContent).toBe(PATCH + '\n');
    expect(document.querySelector('script:not([src])')).toBeNull();
    await user.click(screen.getAllByRole('button', { name: 'Apply' })[0]!);
    await until(() => kernel!.calls('patches.apply').length === 1);
    expect(kernel.calls('patches.apply')[0]).toEqual({ runId: 'r1', nodeIds: ['impl'] });
    expect(await screen.findByRole('button', { name: '✓ Applied' })).toBeTruthy();
  });

  it('switches tabs with the keyboard and shows phase-5 placeholders', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    screen.getByRole('tab', { name: 'Conversation' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByText(/No patch yet/)).toBeTruthy();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/The file viewer arrives in phase 5/)).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByText(/The terminal arrives in phase 5/)).toBeTruthy();
    await user.keyboard('{Home}{x}');
    expect(screen.getByRole('tab', { name: 'Conversation' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});
