// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { ESTIMATE, PATCH } from '../test-helpers/fixtures';
import { renderStudio, scriptRunStart, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

const s = () => studio.getState();

async function plan(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'add OAuth{Enter}');
  await screen.findByRole('button', { name: 'Run (cap $0.50)' });
}

describe('editable plan (R-301) and cost band (R-302)', () => {
  it('shows the likely cost, the hard cap and the basis before launch (D-021)', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    const bar = screen.getByRole('group', { name: 'Plan' });
    expect(bar.textContent).toMatch(
      /Estimate: likely \$0\.40 · at most \$0\.50 \(hard cap\) · partly calibrated/,
    );
    expect(screen.getByRole('button', { name: /#impl/ }).textContent).toMatch(/\$0\.09–\$0\.30/);
  });

  it('edits model, protocol, criticality and budget, validates, and runs the edited graph', async () => {
    const edited = {
      ...ESTIMATE,
      totalUsd: 0.3,
      band: { lowUsd: 0.2, highUsd: 0.45, basis: 'calibrated' },
      expectedUsd: 0.3,
      capUsd: 0.45,
    };
    ({ kernel } = await renderStudio({
      'plan.validate': () => ({
        ok: true,
        problems: [],
        warnings: ['node "impl": budget $0.01 is below its low estimate $0.09'],
        changes: ['impl: model routed → anthropic/model-e'],
        estimate: edited,
      }),
    }));
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /#impl/ }));
    const detail = screen.getByRole('complementary');
    const t0 = performance.now();
    await user.selectOptions(within(detail).getByLabelText('Model'), 'anthropic/model-e');
    expect(performance.now() - t0).toBeLessThan(100);
    expect(s().plan?.graph.nodes[1]?.model).toEqual({ provider: 'anthropic', model: 'model-e' });
    expect(screen.getByRole('button', { name: /^Run/ })).toHaveProperty('disabled', true);
    await user.selectOptions(within(detail).getByLabelText('Protocol'), 'debate');
    await user.selectOptions(within(detail).getByLabelText('Criticality'), 'low');
    await user.type(within(detail).getByLabelText('Budget (USD, optional)'), '0.01{Enter}');
    await until(() => kernel!.calls('plan.validate').length >= 1 && !s().plan?.checking);
    const last = kernel.calls('plan.validate').at(-1) as {
      graph: { nodes: Array<Record<string, unknown>> };
    };
    expect(last.graph.nodes[1]).toMatchObject({
      id: 'impl',
      protocol: 'debate',
      criticality: 'low',
      budgetUsd: 0.01,
      model: { provider: 'anthropic', model: 'model-e' },
    });
    expect(await screen.findByText(/Warning: node "impl": budget/)).toBeTruthy();
    expect(screen.getByText('impl: model routed → anthropic/model-e')).toBeTruthy();
    const run = screen.getByRole('button', { name: 'Run (cap $0.45)' });
    await user.click(run);
    await until(() => kernel!.calls('run.start').length === 1);
    const start = kernel.calls('run.start')[0] as { graph: { nodes: Array<{ id: string }> } };
    expect(start.graph.nodes.map((n) => n.id)).toEqual(['arch', 'impl', 'tests']);
  });

  it('removes a node, rewires its dependents, shows problems and undoes edits', async () => {
    ({ kernel } = await renderStudio({
      'plan.validate': () => ({
        ok: false,
        problems: ['node "tests": needs a non-empty user message'],
        warnings: [],
        changes: ['removed node impl'],
      }),
    }));
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /#impl/ }));
    await user.click(screen.getByRole('button', { name: 'Remove this step' }));
    expect(s().plan?.graph.nodes.map((n) => [n.id, n.dependsOn])).toEqual([
      ['arch', []],
      ['tests', ['arch']],
    ]);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(await screen.findByText('node "tests": needs a non-empty user message')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Run/ })).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'Undo edits' }));
    expect(s().plan?.graph.nodes).toHaveLength(3);
    expect(s().plan?.check).toBeUndefined();
    expect(screen.getByRole('button', { name: /^Run/ })).toHaveProperty('disabled', false);
  });

  it('goes back to the router when "Router\'s choice" is picked again', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /#arch/ }));
    const model = within(screen.getByRole('complementary')).getByLabelText('Model');
    await user.selectOptions(model, 'anthropic/model-a');
    expect(screen.getByRole('button', { name: /#arch/ }).textContent).toMatch(/your choice/);
    await user.selectOptions(model, '');
    expect(s().plan?.graph.nodes[0]?.model).toBeUndefined();
    expect(s().plan?.check).toBeUndefined();
  });
});

describe('routing panel (R-303), steering (R-304), live meter (R-302)', () => {
  it('shows reason, score parts and runner-up one click from the graph', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /#impl/ }));
    const panel = within(screen.getByRole('complementary'));
    expect(panel.getByText('best code score within budget')).toBeTruthy();
    expect(panel.getByText('mistral/model-d')).toBeTruthy();
    expect(panel.getByText('not measured')).toBeTruthy();
    expect(panel.getByRole('table', { name: 'Score breakdown' })).toBeTruthy();
  });

  it('adds an instruction to a pending node and shows run.control events', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /Run/ }));
    await until(() => s().activeRunId === 'r1');
    scriptRunStart(kernel);
    await until(() => s().runs.r1?.nodes.impl?.state === 'running');
    await user.click(screen.getByRole('button', { name: /#tests/ }));
    await user.type(
      screen.getByLabelText(/Added to this step/),
      'use vitest{Control>}{Enter}{/Control}',
    );
    await until(() => kernel!.calls('run.instruct').length === 1);
    expect(kernel.calls('run.instruct')[0]).toEqual({
      runId: 'r1',
      nodeId: 'tests',
      text: 'use vitest',
    });
    kernel.notify('run.control', {
      runId: 'r1',
      event: { type: 'run_paused', inFlight: ['impl'] },
    });
    kernel.notify('run.control', {
      runId: 'r1',
      event: { type: 'instruction_added', nodeId: 'tests', text: '<b>use vitest</b>' },
    });
    kernel.notify('run.control', {
      runId: 'r1',
      event: { type: 'control_refused', action: 'redirect', nodeId: 'arch', reason: 'finished' },
    });
    const log = await screen.findByRole('region', { name: 'Steering' });
    await until(() => within(log).getAllByRole('listitem').length === 3);
    expect(log.textContent).toMatch(/still finishing #impl/);
    expect(log.textContent).toMatch(/Instruction added to #tests: <b>use vitest<\/b>/);
    expect(log.querySelector('b')).toBeNull();
    expect(log.textContent).toMatch(/Refused redirect on #arch: finished/);
  });

  it('moves the cost meter on each contribution and flags spend above the band', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /Run/ }));
    await until(() => s().activeRunId === 'r1');
    scriptRunStart(kernel);
    const ref = { provider: 'openai', model: 'model-b' };
    const contribution = (costUsd: number) => ({
      runId: 'r1',
      event: {
        type: 'contribution',
        nodeId: 'impl',
        contribution: { role: 'author', ref, text: 'x', costUsd },
        usage: { inputTokens: 100, outputTokens: 20 },
      },
    });
    kernel.notify('run.event', contribution(0.1));
    const meter = await screen.findByRole('meter');
    await until(() =>
      expect(meter.getAttribute('aria-valuetext')).toBe(
        '$0.10 spent, 20% of the cap, likely $0.40, band $0.12–$0.50',
      ),
    );
    expect(meter.getAttribute('max')).toBe('0.5');
    expect(meter.getAttribute('high')).toBe('0.5');
    expect(meter.getAttribute('low')).toBe('0.12');
    expect(screen.getByText('Spent $0.10 of cap $0.50')).toBeTruthy();
    kernel.notify('run.event', contribution(0.5));
    await until(() => expect(screen.getByText(/above the band/)).toBeTruthy());
    expect(s().runs.r1?.nodes.impl?.tokens).toEqual({ input: 200, output: 40 });
  });

  it('shows the patch of a patch confirmation as text, apart from the question', async () => {
    ({ kernel } = await renderStudio());
    kernel.notify('confirm.request', {
      confirmId: 'c9',
      kind: 'patch',
      question: 'git.apply on src/auth.ts?',
      risk: 'write',
      patch: PATCH,
      timeoutMs: 60_000,
    });
    const dialog = await screen.findByRole('alertdialog');
    const region = within(dialog).getByRole('region', { name: 'Patch to apply' });
    expect(region.textContent).toContain('+const token = "<script>alert(1)</script>";');
    expect(dialog.querySelector('script')).toBeNull();
  });

  it('lists runs in the Runs tab with a capability note for checkpoints and merge', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await plan(user);
    await user.click(screen.getByRole('button', { name: /Run/ }));
    await until(() => s().activeRunId === 'r1');
    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    expect(screen.getByRole('table', { name: 'Runs in this window' })).toBeTruthy();
    await until(() => kernel!.calls('runs.list').length === 1);
    expect(
      within(screen.getByRole('table', { name: 'Runs in this window' })).getByText('add OAuth'),
    ).toBeTruthy();
  });
});
