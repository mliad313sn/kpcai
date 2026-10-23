import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../../studio/src/connection';
import { setLocale } from '../../studio/src/i18n/core';
import { initialState, patch, studio } from '../../studio/src/store/store';
import { until } from '../../studio/src/test-helpers/fake-kernel';
import {
  REAL_REQUEST,
  startRealKernel,
  type RealKernel,
} from '../../studio/src/test-helpers/real-kernel';
import { TuiApp } from './App';

let k: RealKernel | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(async () => {
  ui?.unmount();
  disconnect();
  await k?.stop();
});

const s = () => studio.getState();

describe('KP Studio in the terminal on the real kernel server', () => {
  it('plans, runs with Ctrl+R and follows the run to the end', async () => {
    studio.setState(initialState(), true);
    setLocale('en');
    k = await startRealKernel({ KPAI_CONFIRM_ABOVE_USD: '100' });
    patch({ runOptions: { allowTest: true } });
    connect(k.wsUrl, k.server.token, { clientName: 'kp-studio-tui' });
    ui = render(<TuiApp />);
    await until(() => s().conn === 'open', 5000);
    for (const ch of REAL_REQUEST) ui.stdin.write(ch);
    ui.stdin.write('\r');
    await until(() => expect(ui!.lastFrame()).toMatch(/Plan · Estimate/), 5000);
    ui.stdin.write('\x12');
    const frame = () => ui!.lastFrame() ?? '';
    await until(() => expect(frame()).toMatch(/Thread · ✓ done/), 10_000);
    if (process.env['KP_TUI_FRAME']) process.stdout.write(`\n${frame()}\n`);
    // `run.state` (shown as done) and `run.done` (which carries the patches) are separate
    // notifications: wait for the patches rather than assume they arrived with the frame.
    await until(() => expect(s().runs[s().activeRunId!]?.patches.length).toBe(2), 10_000);
  });
});
