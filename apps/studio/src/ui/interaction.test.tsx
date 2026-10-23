// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect } from '../connection';
import { initialState, studio } from '../store/store';
import { FakeKernel, TOKEN } from '../test-helpers/fake-kernel';
import { kernelHandlers } from '../test-helpers/fixtures';
import { WS, renderStudio, teardown, until } from '../test-helpers/ui';
import { App } from './App';

let kernel: FakeKernel | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await teardown(kernel);
});

const confirm = (over: Record<string, unknown> = {}) => ({
  confirmId: 'c1',
  runId: 'r1',
  kind: 'patch',
  question: '--- a/x\n+++ b/x\n+  <img src=x onerror=alert(1)>  ',
  risk: 'destructive',
  timeoutMs: 60_000,
  ...over,
});

describe('confirmations', () => {
  it('shows risk and the exact text, focuses No, and Escape declines', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    kernel.notify('confirm.request', confirm());
    const dialog = await screen.findByRole('alertdialog', { name: 'Apply patch?' });
    expect(within(dialog).getByText('Destructive')).toBeTruthy();
    expect(dialog.querySelector('pre')!.textContent).toBe(confirm().question);
    expect(dialog.querySelector('img')).toBeNull();
    expect(document.activeElement?.textContent).toBe('No');
    await user.tab();
    await user.tab(); // focus is trapped inside the dialog
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel.calls('confirm.answer')[0]).toEqual({ confirmId: 'c1', ok: false });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('answers No by itself when the timeout passes', async () => {
    ({ kernel } = await renderStudio());
    kernel.notify('confirm.request', confirm({ kind: 'budget', risk: undefined, timeoutMs: 120 }));
    expect(await screen.findByRole('alertdialog', { name: 'Budget confirmation' })).toBeTruthy();
    await until(() => kernel!.calls('confirm.answer').length === 1);
    expect(kernel.calls('confirm.answer')[0]).toEqual({ confirmId: 'c1', ok: false });
  });

  it('queues confirmations and sends Yes when allowed', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    kernel.notify('confirm.request', confirm({ kind: 'tool', risk: 'write' }));
    kernel.notify('confirm.request', confirm({ confirmId: 'c2', kind: 'tool', risk: 'read' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Tool permission' });
    await until(() => within(dialog).getByText(/1 more waiting/));
    expect(within(dialog).getByText('Writes files')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, allow' }));
    expect(await screen.findByText('Read only')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'No' }));
    await until(() => kernel!.calls('confirm.answer').length === 2);
    expect(kernel.calls('confirm.answer')).toEqual([
      { confirmId: 'c1', ok: true },
      { confirmId: 'c2', ok: false },
    ]);
  });
});

describe('keyboard and palette', () => {
  it('opens the palette with Ctrl+K, filters and runs an item', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    await user.type(within(dialog).getByRole('combobox'), 'go to diff');
    expect(within(dialog).getAllByRole('option')).toHaveLength(1);
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Diff' }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('combobox', { name: 'Search commands' }), 'zzzz');
    expect(screen.getByText('No match')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('palette items cover commands, run controls, zones and settings', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.type(screen.getByRole('combobox', { name: /Ask KP Studio/ }), 'x{Enter}');
    await screen.findByRole('button', { name: /^Run/ });
    await user.keyboard('{Control>}k{/Control}');
    await user.click(screen.getByRole('option', { name: 'Run the plan' }));
    await until(() => studio.getState().activeRunId === 'r1');
    kernel.notify('run.state', { runId: 'r1', state: 'running' });
    await until(() => studio.getState().runs.r1?.state === 'running');
    for (const label of ['Pause run', 'Cancel run', '/stats', 'Show or hide Explorer']) {
      await user.keyboard('{Control>}k{/Control}');
      await user.click(screen.getByRole('option', { name: new RegExp(`^${label}`) }));
    }
    await until(() => kernel!.calls('stats').length === 1);
    expect(kernel.calls('run.pause')).toHaveLength(1);
    expect(kernel.calls('run.cancel')).toHaveLength(1);
    expect(studio.getState().prefs.collapsed.explorer).toBe(true);
    expect(await screen.findByRole('heading', { name: 'Stats' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await user.keyboard('{Control>}k{/Control}');
    await user.click(screen.getByRole('option', { name: /^\/plan/ }));
    expect(
      (screen.getByRole('combobox', { name: /Ask KP Studio/ }) as HTMLInputElement).value,
    ).toBe('/plan ');
    for (const label of ['Switch theme', 'Switch density']) {
      await user.keyboard('{Control>}k{/Control}');
      await user.click(screen.getByRole('option', { name: new RegExp(`^${label}`) }));
    }
    expect(studio.getState().prefs).toMatchObject({ theme: 'dark', density: 'compact' });
    expect(document.documentElement.dataset).toMatchObject({ theme: 'dark', density: 'compact' });
  });

  it('suggests commands and nodes in the command bar', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    const input = screen.getByRole('combobox', { name: /Ask KP Studio/ }) as HTMLInputElement;
    await user.type(input, '/st');
    expect(screen.getByRole('option', { name: /\/stats/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
    await user.keyboard('{Tab}');
    expect(input.value).toBe('/stats ');
    await user.clear(input);
    await user.type(input, 'plan me{Enter}');
    await screen.findByRole('button', { name: /^Run/ });
    await user.type(input, 'fix #');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowUp}{Tab}');
    expect(input.value).toBe('fix #impl ');
    await user.type(input, '#t');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('option')).toBeNull();
    await user.type(input, '@sr');
    expect(screen.queryByRole('option')).toBeNull();
  });

  it('focuses zones with Alt+digits and the command bar with /', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Hide Agents' }));
    await user.keyboard('{Alt>}4{/Alt}');
    await until(() => document.activeElement?.id === 'zone-agents-heading');
    expect(studio.getState().prefs.collapsed.agents).toBe(false);
    await user.keyboard('{Alt>}1{/Alt}');
    await until(() => document.activeElement?.id === 'command-input');
    document.getElementById('zone-thread-heading')!.focus();
    await user.keyboard('/');
    expect(document.activeElement?.id).toBe('command-input');
  });
});

describe('zones, theme and connection', () => {
  it('collapses zones and resizes them from the keyboard', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    const toggle = screen.getByRole('button', { name: 'Hide Explorer' });
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('zone-explorer-body')!.hidden).toBe(true);
    expect(screen.queryByRole('separator', { name: 'Resize Explorer' })).toBeNull();
    const sep = screen.getByRole('separator', { name: 'Resize Agents' });
    sep.focus();
    await user.keyboard('{ArrowLeft}');
    expect(sep.getAttribute('aria-valuenow')).toBe('336');
    await user.keyboard('{ArrowRight}{End}');
    expect(sep.getAttribute('aria-valuenow')).toBe('560');
    const thread = screen.getByRole('separator', { name: 'Resize Execution thread' });
    thread.focus();
    await user.keyboard('{Home}{ArrowUp}{ArrowDown}{ArrowDown}{a}');
    expect(thread.getAttribute('aria-valuenow')).toBe('140');
    act(() => {
      thread.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientY: 500 }));
      window.dispatchEvent(new MouseEvent('pointermove', { clientY: 400 }));
      window.dispatchEvent(new MouseEvent('pointerup'));
    });
    expect(thread.getAttribute('aria-valuenow')).toBe('240');
  });

  it('cycles theme and density from the header', async () => {
    ({ kernel } = await renderStudio());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Theme: system' }));
    await user.click(screen.getByRole('button', { name: 'Theme: dark' }));
    expect(document.documentElement.dataset.theme).toBe('light');
    await user.click(screen.getByRole('button', { name: 'Theme: light' }));
    const compact = screen.getByRole('button', { name: 'Compact' });
    await user.click(compact);
    expect(compact.getAttribute('aria-pressed')).toBe('true');
  });

  it('asks for a token when none was given, and connects with it', async () => {
    // The prompt connects with the global WebSocket; in jsdom use the `ws` client for it.
    vi.stubGlobal('WebSocket', WS);
    studio.setState(initialState(), true);
    kernel = await new FakeKernel(kernelHandlers()).start();
    render(<App url={kernel.url} />);
    const user = userEvent.setup();
    const dialog = screen.getByRole('dialog', { name: 'Connect to the KernelPAI kernel' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Enter token' }));
    const connectBtn = screen.getByRole('button', { name: 'Connect' }) as HTMLButtonElement;
    expect(connectBtn.disabled).toBe(true);
    await user.type(screen.getByLabelText('Token'), TOKEN);
    await user.click(connectBtn);
    await until(() => studio.getState().conn === 'open', 4000);
    expect(screen.getByText('Connected to KernelPAI kernel')).toBeTruthy();
  });

  it('reports a refused token and shows errors in the status line', async () => {
    studio.setState(initialState(), true);
    kernel = await new FakeKernel(kernelHandlers()).start();
    render(<App url={kernel.url} />);
    act(() => void connect(kernel!.url, 'wrong-token-1234', { WebSocketImpl: WS }));
    expect(await screen.findByText('Token refused')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: /Connect to/ })).toBeTruthy();
    cleanup();
  });
});
