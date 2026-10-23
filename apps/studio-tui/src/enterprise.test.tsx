import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import { connect, disconnect } from '../../studio/src/connection';
import { enterprise, resetEnterprise } from '../../studio/src/enterprise/store';
import { fromSnapshot } from '../../studio/src/enterprise/state';
import { setLocale } from '../../studio/src/i18n/core';
import { initialState, studio } from '../../studio/src/store/store';
import { FakeKernel, RpcFailure, TOKEN, until } from '../../studio/src/test-helpers/fake-kernel';
import {
  enterpriseFake,
  snapshot,
  type SnapOptions,
} from '../../studio/src/test-helpers/enterprise-fixtures';
import { kernelHandlers } from '../../studio/src/test-helpers/fixtures';
import { TuiApp } from './App';
import { askLine, oneLine, programLine, quotaLine, rateLine, spendLine } from './enterprise-text';

const CTRL = (c: string) => String.fromCharCode(c.charCodeAt(0) - 96);

let kernel: FakeKernel | undefined;
let ui: ReturnType<typeof render> | undefined;

afterEach(async () => {
  ui?.unmount();
  disconnect();
  await kernel?.stop();
  resetEnterprise();
  setLocale('en');
});

async function boot(o: SnapOptions = {}, extra: Record<string, (p: unknown) => unknown> = {}) {
  studio.setState(initialState(), true);
  resetEnterprise();
  setLocale('en');
  kernel = await new FakeKernel({
    ...kernelHandlers(),
    ...enterpriseFake(snapshot(o)).handlers,
    ...extra,
  }).start();
  connect(kernel.url, TOKEN, { clientName: 'kp-studio-tui' });
  ui = render(<TuiApp />);
  await until(() => studio.getState().conn === 'open');
}

const frame = () => ui!.lastFrame() ?? '';
const key = async (k: string) => {
  ui!.stdin.write(k);
  await new Promise((r) => setTimeout(r, 30));
};

describe('Enterprise summary in the terminal (R-5E14)', () => {
  it('shows liveness, gauges, programs, team and asks (snapshot)', async () => {
    await boot();
    await key(CTRL('e'));
    await until(() => expect(frame()).toMatch(/Your decisions \(3\)/));
    const shown = frame()
      .replace(/heartbeat \d+ s ago *│/, 'heartbeat N s ago │')
      .replace(/[ \t]+$/gm, '');
    expect(shown).toMatchInlineSnapshot(`
      "KP Studio — terminal · Connected to KernelPAI kernel
      ╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
      │ Enterprise                                                                                       │
      │ ● Alive · heartbeat N s ago │
      │ Spend: $12.40 spent · $18.00 committed of $50.00 (36%)                                           │
      │ Rate: $2.10 per hour · Speed limit $5.00 per hour                                                │
      │ Quota: claude-code 3 of 10 runs · ollama 2.5 h of local compute                                  │
      │ Checked: V0 1 · V1 1 · V2 1 · V3 0                                                               │
      │ Programs (2)                                                                                     │
      │   ▶ p-auth · running · ✓ on track · Build “OAuth login <script>alert(1)</script> with tests”     │
      │   ❚❚ p-bracket · paused · ◐ at risk · Model “A parametric 3D-printable bracket”                  │
      │ Team: 6 seats · 2 working · 1 waiting for you · 1 blocked · 2 idle                               │
      │ Runs on: 2 local · 2 API · 2 subscription                                                        │
      │ Your decisions (3)                                                                               │
      │   1. ◆ [p-auth] “Merge wp3 into <i>main</i>?”                                                    │
      │   2. [p-auth] “Write src/a.ts in the worktree?”                                                  │
      │   3. [p-bracket] “Write model.scad in the worktree?”                                             │
      │ Open the evidence and answer in the web console (kpai studio).                                   │
      ╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
      Request › describe a task, then Enter
      Connected to the KernelPAI kernel
      Ctrl+E workspace · Ctrl+X stop everything · Ctrl+U allow work again · Ctrl+Q quit"
    `);
    // eslint-disable-next-line no-control-regex
    expect(frame()).not.toMatch(/\u001b\[3[0-9]m/); // no colour codes from data
  });

  it('stops everything with Ctrl+X and allows work again with Ctrl+U', async () => {
    await boot();
    await key(CTRL('x')); // workspace: no run to cancel, nothing happens
    expect(kernel!.calls('enterprise.kill')).toHaveLength(0);
    await key(CTRL('e'));
    await until(() => expect(enterprise.getState().ui.status).toBe('ready'));
    await key(CTRL('x'));
    await until(() => expect(frame()).toMatch(/Everything is stopped/));
    await key(CTRL('u'));
    await until(() => expect(kernel!.calls('enterprise.unkill')).toHaveLength(1));
    await key(CTRL('e'));
    await until(() => expect(frame()).toMatch(/No plan yet/));
    await key(CTRL('u')); // workspace: ignored
    expect(kernel!.calls('enterprise.unkill')).toHaveLength(1);
  });

  it('says loudly when the heartbeat is stale, and when Enterprise mode is off', async () => {
    await boot({ heartbeatAgeSec: 7200 });
    await key(CTRL('e'));
    await until(() => expect(frame()).toMatch(/⚠ No heartbeat for 2 h 0 min/));
    ui!.unmount();
    disconnect();
    await kernel!.stop();
    await boot(
      {},
      {
        'enterprise.snapshot': () => {
          throw new RpcFailure(-32005, 'off');
        },
      },
    );
    await key(CTRL('e'));
    await until(() => expect(frame()).toMatch(/Enterprise mode is not running/));
  });

  it('builds inert, short lines from untrusted text', () => {
    expect(oneLine('a\u001b[31m red \n line')).toBe('a␛[31m red line');
    expect(oneLine('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
    const d = fromSnapshot(snapshot());
    expect(spendLine(d)).toBe('Spend: $12.40 spent · $18.00 committed of $50.00 (36%)');
    expect(rateLine(d)).toBe('Rate: $2.10 per hour · Speed limit $5.00 per hour');
    expect(quotaLine(d)).toBe('Quota: claude-code 3 of 10 runs · ollama 2.5 h of local compute');
    expect(programLine(d.programs[1]!)).toBe(
      '❚❚ p-bracket · paused · ◐ at risk · Model “A parametric 3D-printable bracket”',
    );
    expect(askLine(d.inbox[1]!, 2)).toBe('2. [p-auth] “Write src/a.ts in the worktree?”');
    const bare = { ...d, gauges: [] };
    expect(spendLine(bare)).toBeUndefined();
    expect(rateLine(bare)).toBeUndefined();
    expect(quotaLine(bare)).toBeUndefined();
  });
});
