/** A finished run r1 (impl and tests done) with its node impl selected, for phase 4 UI tests. */
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { requestPlan, startRun } from '../store/actions';
import { studio } from '../store/store';
import type { FakeKernel } from './fake-kernel';
import { renderStudio, scriptRunStart, until } from './ui';

export const VERIFICATION = {
  reviewUsd: 0.02,
  totalUsd: 0.08,
  share: 0.25,
  issuesRaised: 3,
  acceptedFindings: 2,
  acceptedRevisions: 1,
  usdPerAcceptedFinding: 0.01,
  revisedVerdicts: 1,
  majorFindings: 1,
  usdPerRevisedVerdict: 0.02,
  nodes: [],
};

export async function finishedRun(handlers: Record<string, (p: unknown) => unknown> = {}) {
  const { kernel } = await renderStudio(handlers);
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
  return { kernel: kernel as FakeKernel, user, detail: screen.getByRole('complementary') };
}
