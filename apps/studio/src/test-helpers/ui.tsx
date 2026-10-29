import { cleanup, render } from '@testing-library/react';
import WebSocket from 'ws';
import { connect, disconnect } from '../connection';
import { initialState, setPrefs, studio } from '../store/store';
import type { Prefs } from '../store/types';
import { App } from '../ui/App';
import { FakeKernel, TOKEN, until } from './fake-kernel';
import { kernelHandlers } from './fixtures';

export const WS = WebSocket as unknown as typeof globalThis.WebSocket;

/**
 * Renders the whole console connected to a fresh fake kernel. The tier is the first-run
 * default (Beginner) unless the test sets another one in `prefs`.
 */
export async function renderStudio(
  handlers: Record<string, (p: unknown) => unknown> = {},
  prefs: Partial<Prefs> = {},
): Promise<{ kernel: FakeKernel }> {
  studio.setState(initialState(), true);
  setPrefs((p) => ({ ...p, onboarded: true, ...prefs }));
  const kernel = await new FakeKernel({ ...kernelHandlers(), ...handlers }).start();
  connect(kernel.url, TOKEN, { WebSocketImpl: WS, backoff: { initialMs: 10, maxMs: 20 } });
  render(<App url={kernel.url} />);
  await until(() => studio.getState().conn === 'open' && studio.getState().models.length > 0);
  return { kernel };
}

export async function teardown(kernel: FakeKernel | undefined): Promise<void> {
  cleanup();
  disconnect();
  await kernel?.stop();
  localStorage.clear();
  sessionStorage.clear();
}

/** Plays a scripted run: started, impl running then streaming. */
export function scriptRunStart(kernel: FakeKernel): void {
  const ref = { provider: 'openai', model: 'model-b' };
  kernel.notify('run.state', { runId: 'r1', state: 'running' });
  kernel.notify('run.event', {
    runId: 'r1',
    event: { type: 'node_state', nodeId: 'arch', state: 'done' },
  });
  kernel.notify('run.event', {
    runId: 'r1',
    event: {
      type: 'node_state',
      nodeId: 'impl',
      state: 'running',
      ref,
      role: 'author',
      score: 0.9,
    },
  });
  kernel.notify('run.event', {
    runId: 'r1',
    event: { type: 'text', nodeId: 'impl', role: 'author', ref, delta: 'export const <i>x</i>' },
  });
}

export { until };
