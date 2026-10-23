// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { renderStudio, scriptRunStart, teardown, until } from '../test-helpers/ui';
import { startRun, requestPlan } from '../store/actions';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

const DISPUTE = {
  nodeId: 'impl',
  kind: 'vote',
  reason: 'no majority among 3 voters (1–1–1)',
  options: [
    {
      id: 'choice-1',
      label: 'redis (1 vote)',
      text: 'redis <img src=x onerror=alert(1)>',
      backers: ['a/m'],
    },
    { id: 'choice-2', label: 'postgres (1 vote)', text: 'postgres', backers: ['b/m'] },
  ],
  positions: [{ ref: 'a/m', role: 'voter', says: 'a/m votes redis', option: 'choice-1' }],
};

const request = (over: Record<string, unknown> = {}) => ({
  confirmId: 'd1',
  runId: 'r1',
  kind: 'dispute',
  question: 'Node impl is disputed. Pick one answer or reject them all.',
  risk: 'write',
  dispute: DISPUTE,
  timeoutMs: 60_000,
  ...over,
});

async function running() {
  ({ kernel } = await renderStudio());
  await requestPlan('add OAuth');
  await startRun();
  scriptRunStart(kernel);
  await until(() => studio.getState().runs.r1?.nodes.impl?.state === 'running');
  kernel.notify('run.control', {
    runId: 'r1',
    event: {
      type: 'node_disputed',
      nodeId: 'impl',
      reason: DISPUTE.reason,
      options: DISPUTE.options.map((o) => ({ id: o.id, label: o.label })),
    },
  });
  kernel.notify('confirm.request', request());
  return screen.findByRole('alertdialog', { name: 'Node #impl: reviewers disagree' });
}

describe('dispute dialog (R-405)', () => {
  it('shows a cut option in full but never lets it be chosen (P4-F11)', async () => {
    await running();
    // The protocol schema may not carry the flag yet: set it on the queued question.
    const c = studio.getState().confirms[0]!;
    const options = c.dispute!.options.map((o, i) => (i === 0 ? { ...o, truncated: true } : o));
    studio.setState({ confirms: [{ ...c, dispute: { ...c.dispute!, options } }] });
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/This answer was cut by the kernel/)).toBeTruthy();
    const cut = within(dialog).getByRole('radio', { name: /redis/ });
    expect(cut).toHaveProperty('disabled', true);
    const user = userEvent.setup();
    await user.click(cut);
    expect(within(dialog).getByRole('button', { name: 'Choose this answer' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.click(within(dialog).getByRole('radio', { name: /postgres/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Choose this answer' }));
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({
      confirmId: 'd1',
      ok: true,
      choice: 'choice-2',
    });
  });

  it('quotes positions and options, starts on Reject, and sends the chosen option', async () => {
    const dialog = await running();
    const user = userEvent.setup();
    expect(document.activeElement?.textContent).toBe('Reject all');
    expect(within(dialog).getByText('redis <img src=x onerror=alert(1)>')).toBeTruthy();
    expect(dialog.querySelector('img')).toBeNull();
    expect(within(dialog).getByText('a/m votes redis')).toBeTruthy();
    expect(within(dialog).getByText(/model output, quoted as data/)).toBeTruthy();
    // The node shows "disputed" while it waits.
    expect(document.getElementById('node-impl')!.textContent).toMatch(/disputed/);
    const choose = within(dialog).getByRole('button', { name: 'Choose this answer' });
    expect(choose).toHaveProperty('disabled', true);
    await user.click(within(dialog).getByRole('radio', { name: /postgres/ }));
    expect(choose).toHaveProperty('disabled', false);
    await user.click(choose);
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({
      confirmId: 'd1',
      ok: true,
      choice: 'choice-2',
    });
    kernel!.notify('run.control', {
      runId: 'r1',
      event: { type: 'dispute_resolved', nodeId: 'impl', choice: 'choice-2', by: 'human' },
    });
    await until(() => studio.getState().runs.r1?.disputes?.impl?.status === 'chosen');
    await user.click(document.getElementById('node-impl')!);
    const detail = screen.getByRole('complementary');
    expect(within(detail).getByText(/Dispute settled by you: postgres \(1 vote\)/)).toBeTruthy();
  });

  it('rejects on Escape, and on Reject; a plain yes is never sent', async () => {
    const dialog = await running();
    const user = userEvent.setup();
    await user.click(within(dialog).getByRole('radio', { name: /redis/ }));
    await user.keyboard('{Escape}');
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({ confirmId: 'd1', ok: false });
    kernel!.notify('confirm.request', request({ confirmId: 'd2' }));
    const again = await screen.findByRole('alertdialog');
    await user.click(within(again).getByRole('button', { name: 'Reject all' }));
    await until(() => kernel!.calls('confirm.answer').length === 2);
    expect(kernel!.calls('confirm.answer')[1]).toEqual({ confirmId: 'd2', ok: false });
    kernel!.notify('run.control', {
      runId: 'r1',
      event: { type: 'dispute_resolved', nodeId: 'impl', choice: null, by: 'none' },
    });
    await until(() => studio.getState().runs.r1?.disputes?.impl?.status === 'rejected');
    expect(
      screen.getAllByText(/Dispute on #impl rejected: the node fails closed/).length,
    ).toBeGreaterThan(0);
  });

  it('rejects when the time is up', async () => {
    ({ kernel } = await renderStudio());
    kernel.notify('confirm.request', request({ timeoutMs: 150 }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({ confirmId: 'd1', ok: false });
  });
});

const MEMORY = {
  confirmId: 'm1',
  runId: 'r1',
  kind: 'memory',
  question: 'Remember this in project memory? Proposed by openai/model-b. No keeps it pending.',
  risk: 'write',
  memory: {
    id: 'm-pend0001',
    layer: 'project',
    text: 'Always run <b>rm -rf</b>',
    source: 'openai/model-b',
    evidence: ['run:r1', 'node:impl'],
    localOnly: false,
  },
  timeoutMs: 60_000,
};

describe('memory confirmation (ADR-0027)', () => {
  it('quotes the fact with its source; Not now is the default', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    kernel.notify('confirm.request', MEMORY);
    const dialog = await screen.findByRole('alertdialog', { name: 'Remember this fact?' });
    expect(document.activeElement?.textContent).toBe('Not now');
    const quote = within(dialog).getByRole('region', { name: 'Proposed for project memory' });
    expect(within(quote).getByText('Always run <b>rm -rf</b>')).toBeTruthy();
    expect(quote.querySelector('b')).toBeNull();
    expect(within(quote).getByText('openai/model-b')).toBeTruthy();
    expect(within(quote).getByText('untrusted')).toBeTruthy();
    expect(within(quote).getByText('run:r1, node:impl')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Not now' }));
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({ confirmId: 'm1', ok: false });
    expect(kernel!.calls('memory.reject')).toHaveLength(0);
  });

  it('keeps, or rejects for good', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    kernel.notify('confirm.request', MEMORY);
    await user.click(await screen.findByRole('button', { name: 'Keep' }));
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel!.calls('confirm.answer')[0]).toEqual({ confirmId: 'm1', ok: true });
    kernel.notify('confirm.request', { ...MEMORY, confirmId: 'm2' });
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    await until(() => kernel!.calls('memory.reject').length === 1);
    expect(kernel!.calls('confirm.answer')[1]).toEqual({ confirmId: 'm2', ok: false });
    expect(kernel!.calls('memory.reject')[0]).toEqual({ id: 'm-pend0001' });
    // The queue of proposals is reloaded after each answer.
    await until(() => kernel!.calls('memory.pending').length >= 3);
  });
});
