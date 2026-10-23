// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyEvent, newRun } from '../store/reducer';
import { initialState, log, studio } from '../store/store';
import type { RunView } from '../store/types';
import { GRAPH, PATCH } from '../test-helpers/fixtures';
import { renderStudio, teardown, until } from '../test-helpers/ui';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import type { TaskGraph } from '../rpc/schemas';
import { App } from './App';

const A = { provider: 'anthropic', model: 'model-a' };
const B = { provider: 'google', model: 'model-c' };

function seededRun(): RunView {
  let r: RunView = { ...newRun('r1', 'add <OAuth>', 0), graph: GRAPH as TaskGraph, state: 'done' };
  const events = [
    { type: 'node_state', nodeId: 'impl', state: 'running', ref: A, role: 'author' },
    {
      type: 'contribution',
      nodeId: 'impl',
      contribution: { role: 'author', ref: A, text: 'first draft', costUsd: 0.01 },
    },
    {
      type: 'contribution',
      nodeId: 'impl',
      contribution: {
        role: 'critic',
        ref: B,
        text: '{"approve":false}',
        costUsd: 0.02,
        verdict: {
          approve: false,
          summary: 'missing tests',
          issues: [{ severity: 'major', text: 'no refresh token test' }],
        },
      },
    },
    {
      type: 'contribution',
      nodeId: 'tests',
      contribution: {
        role: 'critic',
        ref: B,
        text: 'ok',
        costUsd: 0,
        verdict: { approve: true, summary: '', issues: [] },
      },
    },
    { type: 'node_state', nodeId: 'impl', state: 'failed' },
  ] as const;
  for (const e of events) r = applyEvent(r, e as never, 1);
  r.nodes.impl = { ...r.nodes.impl!, error: 'critic rejected', approved: false, output: '' };
  r.patches = [
    { nodeId: 'impl', patch: PATCH, files: ['src/auth.ts'] },
    { nodeId: 'tests', patch: '+t', files: ['t.ts'] },
    { nodeId: 'arch', patch: '+a', files: [] },
  ];
  r.applied = ['arch'];
  return r;
}

describe('views of a finished run (no kernel)', () => {
  beforeEach(() => {
    studio.setState({ ...initialState(), runs: { r1: seededRun() }, activeRunId: 'r1' }, true);
  });
  afterEach(() => teardown(undefined));

  it('renders contributions, verdicts, errors and outputs as text', async () => {
    render(<App url="ws://127.0.0.1:1/rpc" />);
    const conv = screen.getByRole('tabpanel');
    expect(within(conv).getByText('add <OAuth>')).toBeTruthy();
    expect(within(conv).getByText('Changes requested (1)')).toBeTruthy();
    expect(within(conv).getByText('no refresh token test')).toBeTruthy();
    expect(within(conv).getByText('Approved')).toBeTruthy();
    expect(within(conv).getByText('Reason: critic rejected')).toBeTruthy();
    expect(within(conv).getByText('(no output)')).toBeTruthy();
    expect(within(conv).getByText('not approved')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /#impl/ }));
    const detail = screen.getByRole('complementary');
    expect(within(detail).getByRole('heading', { name: 'Contributions' })).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Redirect to…' })).toBeNull();
    expect(within(detail).getByRole('button', { name: 'Replay (phase 4)' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('offers Apply all for the patches not yet applied', async () => {
    render(<App url="ws://127.0.0.1:1/rpc" />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Diff (3)' }));
    expect(screen.getByRole('button', { name: 'Apply all (2)' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '✓ Applied' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Apply all (2)' }));
    await until(() => expect(studio.getState().logs.at(-1)?.message).toMatch(/not connected/));
    expect(screen.getByText(/Error: Applying the patch failed/)).toBeTruthy();
  });

  it('shows warnings in the status line and hides info', () => {
    render(<App url="ws://127.0.0.1:1/rpc" />);
    log('info', 'quiet');
    expect(document.querySelector('.status-line')).toBeNull();
    log('warn', 'heads up');
    return until(() => expect(screen.getByText(/Warning: heads up/)).toBeTruthy());
  });
});

describe('explorer and planning blockers', () => {
  let kernel: FakeKernel | undefined;
  afterEach(() => teardown(kernel));

  it('refreshes sessions and blocks Run when the plan cannot run', async () => {
    const incomplete = {
      planId: 'p2',
      graph: GRAPH,
      estimate: {
        nodes: [
          {
            nodeId: 'arch',
            protocol: 'solo',
            ref: null,
            minUsd: 0,
            expectedUsd: 0,
            error: 'no provider',
          },
        ],
        minUsd: 0,
        totalUsd: 0,
        complete: false,
        problems: ['arch: no provider'],
      },
    };
    ({ kernel } = await renderStudio({ plan: () => incomplete, 'sessions.list': () => [] }));
    const user = userEvent.setup();
    expect(await screen.findByText(/No sessions yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Refresh sessions' }));
    await until(() => kernel!.calls('sessions.list').length === 2);
    await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'x{Enter}');
    expect(await screen.findByText(/Cannot run as planned: arch: no provider/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Run/ })).toHaveProperty('disabled', true);
    expect(screen.getByText('unroutable')).toBeTruthy();
  });
});
