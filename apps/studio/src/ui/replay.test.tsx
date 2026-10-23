// @vitest-environment jsdom
/**
 * Replay in two steps (P4-F5): the estimate and the inherited routing (P4-F2) first, with
 * nothing spent; Run then starts that plan once, and Cancel stops it.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { patch, studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { finishedRun } from '../test-helpers/finished';
import { REPLAY } from '../test-helpers/learn-fixtures';
import { teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(() => teardown(kernel));

async function finished(handlers: Record<string, (p: unknown) => unknown> = {}) {
  const r = await finishedRun(handlers);
  kernel = r.kernel;
  return r;
}

async function openDialog(handlers: Record<string, (p: unknown) => unknown> = {}) {
  const r = await finished(handlers);
  await r.user.click(within(r.detail).getByRole('button', { name: 'Replay…' }));
  const dialog = screen.getByRole('dialog', { name: 'Replay node #impl' });
  return { ...r, dialog };
}

describe('replay (R-403, P4-F5)', () => {
  it('shows likely, cap and inherited routing before running, then runs that plan', async () => {
    const { user, dialog } = await openDialog();
    patch({ runOptions: { profile: 'economy', exclude: ['xai'] } });
    const estimate = within(dialog).getByRole('button', { name: 'Estimate the replay' });
    expect(estimate).toHaveProperty('disabled', true);
    await user.selectOptions(within(dialog).getByLabelText('Model'), 'anthropic/model-e');
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'solo');
    await user.click(estimate);
    await until(() => kernel!.calls('run.replayPlan').length === 1);
    expect(kernel!.calls('run.replayPlan')[0]).toEqual({
      runId: 'r1',
      nodeId: 'impl',
      model: { provider: 'anthropic', model: 'model-e' },
      protocol: 'solo',
      options: { profile: 'economy', exclude: ['xai'] },
    });
    const box = await within(dialog).findByRole('region', { name: 'Before anything is spent' });
    expect(within(box).getByText(/likely \$0\.04 · at most \$0\.09 \(hard cap\)/)).toBeTruthy();
    expect(within(box).getByText('Local models only (from the original run).')).toBeTruthy();
    expect(
      within(box).getByText('Providers excluded (from the original run): openai.'),
    ).toBeTruthy();
    expect(within(box).getByText('Providers excluded (your setting): xai.')).toBeTruthy();
    expect(within(box).getByText('Routing profile: Economy.')).toBeTruthy();
    expect(kernel!.calls('run.replay')).toHaveLength(0);
    // Changing the choice drops the estimate: what runs is what was shown.
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'debate');
    expect(within(dialog).queryByRole('region', { name: 'Before anything is spent' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    await user.click(await within(dialog).findByRole('button', { name: 'Run replay (cap $0.09)' }));
    await until(() => kernel!.calls('run.replay').length === 1);
    expect(kernel!.calls('run.replay')[0]).toEqual({ runId: 'r1', nodeId: 'impl', planId: 'rpl1' });
    const compare = await screen.findByRole('region', { name: 'Replay beside the original' });
    expect(within(compare).getByText(/Different output · cost \+\$0\.02/)).toBeTruthy();
    expect(within(compare).getByText('export const b = 2; <i>new</i>')).toBeTruthy();
    expect(compare.querySelector('i')).toBeNull();
    expect(within(compare).getByText('google/model-c rejected (2 issues)')).toBeTruthy();
    expect(within(compare).getByRole('row', { name: /Cost \$0\.05 \$0\.07/ })).toBeTruthy();
  });

  it('cancels a running replay by its plan id and voids its questions', async () => {
    let stop: ((e: Error) => void) | undefined;
    const { user, dialog, detail } = await openDialog({
      'run.replay': () => new Promise((_, reject) => (stop = reject)),
      'run.cancel': () => {
        stop?.(new Error('replay cancelled before it started'));
        return { cancelled: true };
      },
    });
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'vote');
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    await user.click(await within(dialog).findByRole('button', { name: /^Run replay/ }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await within(detail).findByText('Replaying #impl…');
    // The replay's budget question carries the plan id as its run id.
    kernel!.notify('confirm.request', {
      confirmId: 'q1',
      runId: 'rpl1',
      kind: 'budget',
      question: 'Replay may cost up to $0.09. Continue?',
      timeoutMs: 60_000,
    });
    await until(() => studio.getState().confirms.length === 1);
    await user.click(within(detail).getByRole('button', { name: 'Cancel replay' }));
    await until(() => kernel!.calls('run.cancel').length === 1);
    expect(kernel!.calls('run.cancel')[0]).toEqual({ runId: 'rpl1' });
    await until(() => studio.getState().replays['r1:impl'] === undefined);
    expect(studio.getState().confirms).toEqual([]);
    expect(kernel!.calls('confirm.answer')).toEqual([{ confirmId: 'q1', ok: false }]);
    expect(studio.getState().announcement.text).toBe('Replay of node impl cancelled');
    expect(studio.getState().logs.some((l) => /Replay failed/.test(l.message))).toBe(false);
    expect(within(detail).getByRole('button', { name: 'Replay…' })).toHaveProperty(
      'disabled',
      false,
    );
  });

  it('keeps what a replay cancelled mid-node recorded, and says it was cancelled', async () => {
    let end: ((v: unknown) => void) | undefined;
    const { user, dialog, detail } = await openDialog({
      'run.replay': () => new Promise((resolve) => (end = resolve)),
      'run.cancel': () => {
        end?.({ ...REPLAY, replay: { ...REPLAY.replay, ok: false, error: 'cancelled' } });
        return { cancelled: true };
      },
    });
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'vote');
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    await user.click(await within(dialog).findByRole('button', { name: /^Run replay/ }));
    await user.click(await within(detail).findByRole('button', { name: 'Cancel replay' }));
    const compare = await screen.findByRole('region', { name: 'Replay beside the original' });
    expect(within(compare).getByRole('row', { name: /Outcome .*failed: cancelled/ })).toBeTruthy();
    expect(studio.getState().announcement.text).toBe('Replay of node impl cancelled');
  });

  it('says why an estimate failed in the dialog and refuses a scope problem', async () => {
    let fail = true;
    const { user, dialog } = await openDialog({
      'run.replayPlan': () => {
        if (fail) throw new Error('node never finished');
        return {
          planId: 'rpl2',
          runId: 'r1',
          nodeId: 'impl',
          routing: {},
          estimate: { nodes: [], minUsd: 0, totalUsd: 0.01, complete: true, problems: [] },
          scope: { required: ['infosec'], lines: [], problems: ['the authorised scope expired'] },
        };
      },
    });
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'vote');
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(
      'Replay could not be estimated: node never finished',
    );
    fail = false;
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    await within(dialog).findByText('No provider restriction from the original run.');
    expect(
      within(dialog).getByText(
        /Scope problem, the replay cannot run: the authorised scope expired/,
      ),
    ).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: /^Run replay/ })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('reports a refused replay and lets the user try again', async () => {
    const { user, dialog, detail } = await openDialog({
      'run.replay': () => {
        throw new Error('node never finished');
      },
    });
    await user.selectOptions(within(dialog).getByLabelText('Protocol'), 'vote');
    await user.click(within(dialog).getByRole('button', { name: 'Estimate the replay' }));
    await user.click(await within(dialog).findByRole('button', { name: /^Run replay/ }));
    await until(() =>
      expect(studio.getState().logs.at(-1)?.message).toBe('Replay failed: node never finished'),
    );
    expect(within(detail).getByRole('button', { name: 'Replay…' })).toHaveProperty(
      'disabled',
      false,
    );
  });
});
