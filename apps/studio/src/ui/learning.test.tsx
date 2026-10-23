// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Methods } from '@kernelpai/kernel/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPlan, startRun } from '../store/actions';
import { studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { ESTIMATE, PLAN } from '../test-helpers/fixtures';
import { renderStudio, scriptRunStart, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

const VERIFICATION = {
  reviewUsd: 0.02,
  totalUsd: 0.08,
  share: 0.25,
  issuesRaised: 3,
  acceptedFindings: 2,
  acceptedRevisions: 1,
  usdPerAcceptedFinding: 0.01,
  nodes: [],
};

async function finished(handlers: Record<string, (p: unknown) => unknown> = {}) {
  ({ kernel } = await renderStudio(handlers));
  await requestPlan('add OAuth');
  await startRun();
  scriptRunStart(kernel);
  for (const nodeId of ['impl', 'tests'])
    kernel.notify('run.event', {
      runId: 'r1',
      event: { type: 'node_state', nodeId, state: 'done' },
    });
  kernel.notify('run.done', {
    runId: 'r1',
    result: { ok: true, results: { impl: { output: 'x', approved: true } } },
    patches: [],
    verification: VERIFICATION,
  });
  kernel.notify('run.state', { runId: 'r1', state: 'done' });
  await until(() => studio.getState().runs.r1?.state === 'done');
  const user = userEvent.setup();
  await user.click(document.getElementById('node-impl')!);
  return { user, detail: screen.getByRole('complementary') };
}

describe('replay, fork and grades (R-403, ADR-0028)', () => {
  it('replays with another model and shows both attempts side by side, as text', async () => {
    const { user, detail } = await finished();
    expect(screen.getByText(/Verification:/).parentElement!.textContent).toMatch(
      /review \$0\.02 \(25% of \$0\.08\) · issues raised: 3 · accepted findings: 2/,
    );
    await user.click(within(detail).getByRole('button', { name: 'Replay…' }));
    const dialog = screen.getByRole('dialog', { name: 'Replay node #impl' });
    const submit = within(dialog).getByRole('button', { name: 'Replay' });
    expect(submit).toHaveProperty('disabled', true);
    await user.selectOptions(within(dialog).getByLabelText('Model'), 'anthropic/model-e');
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'solo');
    await user.click(submit);
    await until(() => kernel!.calls('run.replay').length === 1);
    expect(kernel!.calls('run.replay')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      model: { provider: 'anthropic', model: 'model-e' },
      protocol: 'solo',
    });
    const compare = await screen.findByRole('region', { name: 'Replay beside the original' });
    expect(within(compare).getByText(/Different output · cost \+\$0\.02/)).toBeTruthy();
    expect(within(compare).getByText('export const b = 2; <i>new</i>')).toBeTruthy();
    expect(compare.querySelector('i')).toBeNull();
    expect(within(compare).getByText('google/model-c rejected (2 issues)')).toBeTruthy();
    expect(within(compare).getByRole('row', { name: /Cost \$0\.05 \$0\.07/ })).toBeTruthy();
  });

  it('plans a fork as a plan the user runs with Run fork', async () => {
    const { user, detail } = await finished();
    await user.click(within(detail).getByRole('button', { name: 'Fork from here…' }));
    const dialog = screen.getByRole('dialog', { name: 'Fork from node #impl' });
    await user.type(
      within(dialog).getByLabelText('Instruction added to this node (optional)'),
      'cover the empty state',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Plan the fork' }));
    await until(() => studio.getState().plan?.fork !== undefined);
    expect(kernel!.calls('run.forkPlan')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      edit: { instruction: 'cover the empty state' },
    });
    expect(screen.getByText('Fork of run r1 from node #impl')).toBeTruthy();
    expect(screen.getByText('Runs again: #impl, #tests')).toBeTruthy();
    expect(screen.getByText(/Reused as recorded, not billed again: #arch/)).toBeTruthy();
    expect(document.getElementById('node-arch')!.textContent).toMatch(/reused/);
    const run = screen.getByRole('button', { name: /^Run fork \(cap \$0\.50\)/ });
    await user.click(document.getElementById('node-impl')!);
    expect(screen.getByText(/A fork runs as planned/)).toBeTruthy();
    await user.click(run);
    await until(() => kernel!.calls('run.fork').length === 1);
    expect(kernel!.calls('run.fork')[0]).toEqual({ planId: 'fp1' });
    expect(kernel!.calls('run.start')).toHaveLength(1);
    await until(() => studio.getState().activeRunId === 'r2');
    expect(studio.getState().runs.r2?.forkOf).toEqual({ runId: 'r1', nodeId: 'impl' });
  });

  it('grades a finished node good with a note', async () => {
    const { user, detail } = await finished();
    await user.type(within(detail).getByLabelText('Note (optional)'), 'clean diff');
    await user.click(within(detail).getByRole('button', { name: /Good/ }));
    await until(() => kernel!.calls('grade').length === 1);
    expect(kernel!.calls('grade')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      grade: 'good',
      note: 'clean diff',
    });
    await screen.findByText(/You graded openai\/model-b good\. Note: clean diff/);
    expect(within(detail).getByRole('button', { name: /Good/ }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('reports a refused replay and lets the user try again', async () => {
    const { user, detail } = await finished({
      'run.replay': () => {
        throw new Error('node never finished');
      },
    });
    await user.click(within(detail).getByRole('button', { name: 'Replay…' }));
    await user.selectOptions(screen.getByLabelText('Protocol'), 'vote');
    await user.click(screen.getByRole('button', { name: 'Replay' }));
    await until(() =>
      expect(studio.getState().logs.at(-1)?.message).toBe('Replay failed: node never finished'),
    );
    expect(within(detail).getByRole('button', { name: 'Replay…' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});

describe('evidence (R-402, ADR-0028)', () => {
  it('shows the accuracy table, competence and the routing evidence', async () => {
    const reason = 'best code score; evidence: approved 5/6 code generation tasks here';
    ({ kernel } = await renderStudio({
      plan: () => ({
        ...PLAN,
        estimate: {
          ...ESTIMATE,
          nodes: ESTIMATE.nodes.map((n) => (n.nodeId === 'impl' ? { ...n, reason } : n)),
        },
      }),
    }));
    const user = userEvent.setup();
    await requestPlan('add OAuth');
    await user.click(document.getElementById('node-impl')!);
    const routing = screen.getByRole('region', { name: 'Why this model' });
    expect(within(routing).getByText('best code score')).toBeTruthy();
    expect(
      within(routing).getByText('approved 5/6 code generation tasks here').textContent,
    ).toBeTruthy();
    await within(routing).findByText(
      /code_generation: approved 5\/6 code generation tasks here \(critics approved 5\/6\)/,
    );
    await user.click(screen.getByRole('tab', { name: 'Accuracy & competence' }));
    const acc = await screen.findByRole('region', { name: 'Estimate accuracy' });
    expect(within(acc).getByRole('row', { name: /All runs 2 \$0\.20 \$0\.10 100%/ })).toBeTruthy();
    expect(within(acc).getByText('By task type')).toBeTruthy();
    expect(within(acc).getByText(/Left out: 1 cancelled/)).toBeTruthy();
    if (Object.hasOwn(Methods, 'stats.productivity')) {
      const prod = screen.getByRole('region', { name: 'Productivity here' });
      expect(within(prod).getByText(/2 accepted · 1 declined · 0 failed · 1 pending/)).toBeTruthy();
      expect(within(prod).getByText('$0.15 · 45s')).toBeTruthy();
      expect(within(prod).getByText('50% (touched again within 7 days)')).toBeTruthy();
      expect(within(prod).getByText('2/3 (67%)')).toBeTruthy();
    }
    const comp = screen.getByRole('region', { name: 'Measured competence here' });
    expect(
      within(comp).getByRole('row', { name: /openai\/model-b code_generation 6 0\.83 5/ }),
    ).toBeTruthy();
  });

  it('says when measured competence is not in force yet', async () => {
    ({ kernel } = await renderStudio({
      plan: () => ({
        ...PLAN,
        estimate: {
          ...ESTIMATE,
          nodes: ESTIMATE.nodes.map((n) =>
            n.nodeId === 'impl' ? { ...n, parts: { measuredCompetence: null } } : n,
          ),
        },
      }),
      competence: () => {
        throw new Error('down');
      },
    }));
    const user = userEvent.setup();
    await requestPlan('add OAuth');
    await user.click(document.getElementById('node-impl')!);
    expect(screen.getByText(/fewer than 5 graded tasks here/)).toBeTruthy();
  });
});
