// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/core';
import { patch, setPrefs, studio } from '../store/store';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { renderStudio, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;
afterEach(async () => {
  await teardown(kernel);
  setLocale('en');
});

const s = () => studio.getState();

const RUN = {
  runId: 'r1',
  planId: 'p1',
  sessionId: 's1',
  request: 'ship it',
  state: 'done',
  startedAt: '2026-10-23T10:00:00Z',
  costUsd: 0.2,
  isolated: true,
  worktree: '/home/k/.kernelpai/worktrees/r1',
  diff: { files: 2, additions: 10, deletions: 3 },
  verdict: 'approved',
  patches: 1,
  artifacts: 1,
};

const CHECKPOINT = {
  ref: 'refs/kpai/r1/1',
  runId: 'r1',
  n: 1,
  label: 'before patch impl',
  createdAt: '2026-10-23T10:01:00Z',
  commit: 'abc',
  where: 'worktree',
};

const handlers = {
  'runs.list': () => ({ runs: [RUN] }),
  'run.checkpoints': () => ({ checkpoints: [CHECKPOINT] }),
  'run.restore': () => ({ restored: true, written: ['a'], deleted: [], skipped: 0, undo: 'u' }),
  'run.merge': () => ({ merged: true, files: ['a', 'b'], omitted: 0 }),
  'run.discard': () => ({ removed: true }),
  'artifacts.apply': () => ({
    results: [{ path: 'docs/report.md', nodeId: 'n1', ok: true, message: 'written' }],
  }),
};

describe('runs manager (R-305, R-307)', () => {
  it('lists runs from the kernel, restores a checkpoint, merges and discards', async () => {
    ({ kernel } = await renderStudio(handlers));
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Runs' }));
    const table = await screen.findByRole('table', { name: 'Runs in this window' });
    expect(await within(table).findByText('ship it')).toBeTruthy();
    expect(within(table).getByText('2 file(s), +10 −3')).toBeTruthy();
    expect(within(table).getByText('approved')).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Checkpoints' }));
    const list = await screen.findByRole('list', { name: 'Checkpoints' });
    expect(list.textContent).toMatch(/#1 before patch impl \(worktree/);
    await user.click(within(list).getByRole('button', { name: 'Restore…' }));
    await until(() => kernel!.calls('run.restore').length === 1);
    expect(kernel.calls('run.restore')[0]).toEqual({ runId: 'r1', ref: 'refs/kpai/r1/1' });
    await until(() => expect(s().announcement.text).toMatch(/Checkpoint restored: 1 file/));
    await user.click(within(table).getByRole('button', { name: 'Merge…' }));
    await until(() => expect(s().announcement.text).toBe('Run merged: 2 files'));
    await user.click(within(table).getByRole('button', { name: 'Discard worktree' }));
    await until(() => expect(s().announcement.text).toMatch(/Worktree removed/));
  });
});

describe('artifacts (WI-S6-01)', () => {
  it('shows artifacts as text with path, kind and provenance, and saves through the kernel', async () => {
    ({ kernel } = await renderStudio(handlers));
    const user = userEvent.setup();
    kernel.notify('run.done', {
      runId: 'r1',
      result: { ok: true },
      patches: [],
      artifacts: [
        {
          nodeId: 'n1',
          path: 'docs/report.md',
          kind: 'report',
          mime: 'text/markdown',
          content: '# Report\n<img src=x onerror=alert(1)>',
          bytes: 40,
          sha256: 'a'.repeat(64),
          reviewed: false,
          provenance: {
            runId: 'r1',
            sessionId: 's1',
            nodeId: 'n1',
            author: { provider: 'p', model: 'm' },
          },
        },
      ],
    });
    await until(() => (s().runs.r1?.artifacts.length ?? 0) === 1);
    act(() => patch({ activeRunId: 'r1' }));
    await user.click(screen.getByRole('tab', { name: 'Artifacts' }));
    const card = screen.getByRole('article', { name: 'docs/report.md' });
    expect(within(card).getByText('report')).toBeTruthy();
    expect(within(card).getByText('author: p/m')).toBeTruthy();
    expect(within(card).getByText(/not reviewed/)).toBeTruthy();
    expect(card.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(card.querySelector('img')).toBeNull();
    await user.click(within(card).getByRole('button', { name: 'Save…' }));
    await until(() => kernel!.calls('artifacts.apply').length === 1);
    expect(kernel.calls('artifacts.apply')[0]).toEqual({ runId: 'r1', paths: ['docs/report.md'] });
    expect(await within(card).findByRole('button', { name: '✓ Saved' })).toBeTruthy();
  });

  it('shows an artifact confirmation with its exact content', async () => {
    ({ kernel } = await renderStudio());
    kernel.notify('confirm.request', {
      confirmId: 'c1',
      kind: 'artifact',
      question: 'Write docs/report.md?',
      risk: 'write',
      content: '<b>raw</b>',
      artifact: {
        path: 'docs/report.md',
        kind: 'report',
        mime: 'text/markdown',
        bytes: 10,
        nodeId: 'n1',
        reviewed: false,
      },
      timeoutMs: 60_000,
    });
    const dialog = await screen.findByRole('alertdialog', { name: 'Write this artifact?' });
    const region = within(dialog).getByRole('region', { name: 'Content to write' });
    expect(region.textContent).toContain('<b>raw</b>');
    expect(region.textContent).toContain('docs/report.md · report · text/markdown · 10 bytes');
    expect(region.querySelector('b')).toBeNull();
    expect(region.textContent).toMatch(/No critic reviewed this document/);
  });
});

describe('onboarding (R-308) and language (WI-S6-02)', () => {
  it('opens on first run, lists providers, keeps the $0 path off without local models, plans a first task', async () => {
    ({ kernel } = await renderStudio());
    act(() => {
      setPrefs((p) => ({ ...p, onboarded: false }));
      patch({
        onboardingOpen: true,
        packs: [
          {
            id: 'data-science',
            name: 'Data science',
            tips: ['Keep raw data read-only'],
            glossary: [{ term: 'Notebook', meaning: 'Cells of code and prose' }],
          },
        ],
      });
    });
    const user = userEvent.setup();
    const dialog = await screen.findByRole('dialog', { name: 'Welcome to KP Studio' });
    expect(within(dialog).getByText(/Anthropic \(cloud, paid\): ready/)).toBeTruthy();
    expect(
      within(dialog).getByText(/Ollama \(local\) \(local, free\): not available/),
    ).toBeTruthy();
    expect(within(dialog).getByRole('checkbox', { name: /\$0 path/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(within(dialog).getByText('Keep raw data read-only')).toBeTruthy();
    await user.click(within(dialog).getByRole('radio', { name: 'Economy' }));
    await user.click(within(dialog).getByRole('button', { name: 'Plan this first task' }));
    await until(() => kernel!.calls('plan').length === 1);
    expect(kernel.calls('plan')[0]).toEqual({
      request: 'Explain what this project does and list its main folders',
      options: { profile: 'economy' },
    });
    expect(s().prefs).toMatchObject({ onboarded: true, profile: 'economy', localOnly: false });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('switches the whole console to French from the header', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Language'), 'fr');
    expect(await screen.findByRole('region', { name: 'Fil d’exécution' })).toBeTruthy();
    expect(screen.getByRole('search', { name: 'Barre de commande' })).toBeTruthy();
    expect(document.documentElement.lang).toBe('fr');
    await user.selectOptions(screen.getByLabelText('Langue'), 'en');
    expect(await screen.findByRole('region', { name: 'Execution thread' })).toBeTruthy();
  });
});
