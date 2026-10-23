// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Methods } from '@kernelpai/kernel/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { requestPlan } from '../store/actions';
import { studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { ESTIMATE, PLAN } from '../test-helpers/fixtures';
import { finishedRun } from '../test-helpers/finished';
import { renderStudio, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

async function finished(handlers: Record<string, (p: unknown) => unknown> = {}) {
  const r = await finishedRun(handlers);
  kernel = r.kernel;
  return r;
}

describe('fork and grades (R-403, ADR-0028)', () => {
  it('heads the run bar ROI with revised verdicts, raw issues second (P4-F12)', async () => {
    await finished();
    expect(screen.getByText(/Verification:/).parentElement!.textContent).toMatch(
      /review \$0\.02 \(25% of \$0\.08\) · 1 revised verdict · \$0\.02 per revised verdict · raw issues raised: 3/,
    );
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
    // The console's routing goes along; the kernel keeps the run's floor (P4-F2).
    expect(kernel!.calls('run.forkPlan')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      edit: { instruction: 'cover the empty state' },
      options: { profile: 'balanced' },
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
    // The server names the author (P4-F9): the console never sends one.
    expect(kernel!.calls('grade')[0]).not.toHaveProperty('author');
    await screen.findByText(/You graded openai\/model-b good\. Note: clean diff/);
    expect(within(detail).getByRole('button', { name: /Good/ }).getAttribute('aria-pressed')).toBe(
      'true',
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
      // P4-F12: revised verdicts head the review line, raw issues second.
      expect(
        within(prod).getByText(
          '$0.04 spent · revised verdicts: 1 ($0.04 each) · raw issues raised: 3',
        ),
      ).toBeTruthy();
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
