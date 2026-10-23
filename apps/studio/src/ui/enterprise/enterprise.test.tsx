// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { enterprise, flushNotices, resetEnterprise } from '../../enterprise/store';
import { setPrefs, studio } from '../../store/store';
import type { FakeKernel } from '../../test-helpers/fake-kernel';
import { RpcFailure } from '../../test-helpers/fake-kernel';
import {
  enterpriseFake,
  seat,
  snapshot,
  type SnapOptions,
} from '../../test-helpers/enterprise-fixtures';
import { renderStudio, teardown, until } from '../../test-helpers/ui';

let kernel: FakeKernel | undefined;

afterEach(async () => {
  await teardown(kernel);
  kernel = undefined;
  resetEnterprise();
});

async function openEnterprise(
  o: SnapOptions = {},
  extra: Record<string, (p: unknown) => unknown> = {},
) {
  resetEnterprise();
  ({ kernel } = await renderStudio({ ...enterpriseFake(snapshot(o)).handlers, ...extra }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /^Enterprise/ }));
  // Focus moves to the view's heading (a frame later).
  await until(() => document.activeElement?.id === 'ent-title');
  await until(
    () =>
      enterprise.getState().ui.status !== 'idle' && enterprise.getState().ui.status !== 'loading',
  );
  return user;
}

describe('Enterprise view (R-5E10)', () => {
  it('shows gauges, programs, asks and the team, with untrusted text as text', async () => {
    await openEnterprise();
    expect(screen.getByRole('heading', { level: 2, name: 'Enterprise' })).toBeTruthy();
    expect(screen.getByText('$12.40 spent')).toBeTruthy();
    expect(screen.getByText(/\$18\.00 committed \(36%/)).toBeTruthy();
    expect(screen.getByText('$2.10 per hour')).toBeTruthy();
    expect(screen.getByText('Speed limit $5.00 per hour')).toBeTruthy();
    expect(screen.getByText('3 of 8 workers busy')).toBeTruthy();
    expect(screen.getByText(/3 of 10 runs/)).toBeTruthy();
    expect(screen.getByText(/2\.5 h of local compute/)).toBeTruthy();
    expect(screen.getByText(/Approved without looking: 25% of 4 important approvals/)).toBeTruthy();
    expect(screen.getByText('1 job waiting.')).toBeTruthy();
    // Goals and questions are quoted text: no element is created from them.
    expect(screen.getByText('OAuth login <script>alert(1)</script> with tests')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByText('Merge wp3 into <i>main</i>?')).toBeTruthy();
    expect(screen.getByText('Lead <b>builder</b>')).toBeTruthy();
    expect(
      screen.getByText(/2 programs · 6 seats: 2 working, 1 waiting for you, 1 blocked · 3 asks/),
    ).toBeTruthy();
    expect(screen.getByText('Paused by the daemon:')).toBeTruthy();
    expect(screen.getByText(/A yes covers one run of wp3, up to \$0\.50/)).toBeTruthy();
    const ask = screen.getByRole('article', { name: 'Merge wp3 into <i>main</i>?' });
    expect(within(ask).getByText('V1')).toBeTruthy();
    expect(within(ask).getByText(/critic mock-delta/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Enterprise · 3 asks/ })).toBeTruthy();
  });

  it('says loudly when the heartbeat goes stale or is missing', async () => {
    await openEnterprise({ heartbeatAgeSec: 3 * 3600 });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/The enterprise has gone silent\..*3 h 0 min/);
    expect(screen.getAllByText(/No heartbeat for 3 h/).length).toBeGreaterThan(0);
    await teardown(kernel);
    await openEnterprise({ noHeartbeat: true });
    expect(screen.getByRole('alert').textContent).toMatch(/Liveness unknown/);
    expect(screen.getByText('never')).toBeTruthy();
  });

  it('shows watchdog alerts, and a fresh heartbeat as alive', async () => {
    await openEnterprise();
    expect(screen.getAllByText(/Alive · heartbeat 1\d s ago/).length).toBe(2);
    expect(screen.getByRole('alert').textContent).toBe('');
    act(() =>
      kernel!.notify('enterprise.heartbeat', {
        ...snapshot().heartbeat,
        status: 'alert',
        alerts: [{ rule: 'ask-old', text: 'An ask waits <b>2 days</b>', programId: 'p-auth' }],
        seq: 41,
      }),
    );
    await until(() => screen.getByRole('alert').textContent!.includes('watchdog'));
    expect(screen.getByText('An ask waits <b>2 days</b>')).toBeTruthy();
  });

  it('unlocks Approve only after the evidence is opened (R8), then answers', async () => {
    const user = await openEnterprise();
    const ask = screen.getByRole('article', { name: 'Merge wp3 into <i>main</i>?' });
    const approve = within(ask).getByRole('button', { name: 'Approve' });
    expect(approve.getAttribute('aria-disabled')).toBe('true');
    await user.click(approve);
    expect(kernel!.calls('program.answer')).toHaveLength(0);
    expect(studio.getState().announcement.text).toBe('Open the evidence before you approve.');
    await user.click(within(ask).getByRole('button', { name: 'Open the evidence (2)' }));
    await until(() => approve.getAttribute('aria-disabled') === 'false');
    expect(within(ask).getByText('merge-default-branch')).toBeTruthy();
    expect(within(ask).getByText('Evidence opened')).toBeTruthy();
    await user.click(approve);
    await until(() => kernel!.calls('program.answer').length === 1);
    await until(() => !screen.queryByRole('article', { name: 'Merge wp3 into <i>main</i>?' }));
  });

  it('opens evidence references in the workspace', async () => {
    const user = await openEnterprise();
    const ask = screen.getByRole('article', { name: 'Merge wp3 into <i>main</i>?' });
    await user.click(within(ask).getByRole('button', { name: /Open the evidence/ }));
    await user.click(within(ask).getByRole('button', { name: 'changes d-1' }));
    expect(studio.getState()).toMatchObject({ view: 'workspace', tab: 'diff' });
  });

  it('batches trivial asks behind a review', async () => {
    const user = await openEnterprise();
    await user.click(screen.getByRole('button', { name: 'Review them' }));
    expect(screen.getByText('Write src/a.ts in the worktree?')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve these 2 asks' }));
    await until(() => kernel!.calls('program.answerBatch').length === 2);
    await until(() => !screen.queryByText('2 low-risk asks'));
  });

  it('pauses, resumes and stops a program; stop asks first', async () => {
    const user = await openEnterprise();
    await user.click(screen.getByRole('button', { name: 'Pause program p-auth' }));
    await until(() => kernel!.calls('program.pause').length === 1);
    await user.click(screen.getByRole('button', { name: 'Resume program p-bracket' }));
    await until(() => kernel!.calls('program.resume').length === 1);
    await user.click(screen.getByRole('button', { name: 'Stop program p-auth' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Stop program p-auth?' });
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Keep it' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(kernel!.calls('program.stop')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Stop program p-auth' }));
    await user.click(screen.getByRole('button', { name: 'Stop the program' }));
    await until(() => kernel!.calls('program.stop').length === 1);
  });

  it('moves work packages live and links the next decision to its ask', async () => {
    await openEnterprise();
    act(() => {
      kernel!.notify('enterprise.wp', {
        seq: 41,
        programId: 'p-auth',
        wpId: 'wp0',
        from: 's0',
        to: 's1',
        state: 'review',
      });
    });
    await until(() => !!screen.queryByText('1 in review'));
    const link = screen.getByRole('link', { name: 'Merge wp3 into main?' });
    expect(link.getAttribute('href')).toBe('#ask-e-merge');
  });

  it('stops everything in one click and allows work again', async () => {
    const user = await openEnterprise();
    await user.click(screen.getByRole('button', { name: 'Stop everything' }));
    await until(() => !!screen.queryByText('Everything is stopped'));
    await user.click(screen.getByRole('button', { name: 'Allow work again' }));
    await until(() => !!screen.queryByRole('button', { name: 'Stop everything' }));
  });

  it('switches between one team and departments, filters, and shows a seat', async () => {
    const user = await openEnterprise();
    const grid = screen.getByRole('group', { name: 'Seats (6)' });
    const first = within(grid).getAllByRole('button')[0]!;
    expect(first.textContent).toMatch(/waiting for you/);
    await user.click(screen.getByRole('button', { name: 'Departments (expert)' }));
    expect(screen.getByRole('heading', { level: 4, name: /engineering/ })).toBeTruthy();
    expect(localStorage.getItem('kp-studio.enterprise')).toContain('departments');
    await user.click(screen.getByRole('button', { name: 'One team' }));
    await user.selectOptions(screen.getByLabelText('Show'), 'attention');
    expect(screen.getByText('2 seats shown')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Program'), 'p-bracket');
    expect(screen.getByText('No seat matches these filters.')).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Program'), '');
    await user.selectOptions(screen.getByLabelText('Show'), 'all');
    await user.click(screen.getByRole('button', { name: /Lead <b>builder<\/b>/ }));
    const detail = screen.getByRole('region', { name: 'Seat details' });
    expect(within(detail).getByText('mock-alpha/m1')).toBeTruthy();
    await user.click(
      within(detail).getByRole('button', { name: 'Open run run-1 in the workspace' }),
    );
    expect(studio.getState().view).toBe('workspace');
  });

  it('moves between seats with the keyboard', async () => {
    const user = await openEnterprise();
    const cards = () => within(screen.getByRole('group', { name: /Seats/ })).getAllByRole('button');
    cards()[0]!.focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement).toBe(cards()[1]);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(cards().at(-1));
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(cards().at(-1));
    await user.keyboard('{Home}{x}');
    expect(document.activeElement).toBe(cards()[0]);
  });

  it('renders only a window of 500 seats', async () => {
    await openEnterprise({ seats: 500 });
    const grid = screen.getByRole('group', { name: 'Seats (500)' });
    const shown = within(grid).getAllByRole('button').length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(150);
  });

  it('shows the live activity feed and the reports archive', async () => {
    const user = await openEnterprise();
    await user.click(screen.getByRole('tab', { name: 'Activity' }));
    await until(() => !!screen.queryByText('wp3 reviewed: <b>approved</b>'));
    const feed = screen.getByRole('feed', { name: 'Live activity' });
    expect(within(feed).getAllByRole('article')).toHaveLength(2);
    act(() =>
      kernel!.notify('enterprise.activity', {
        seq: 41,
        at: snapshot().at,
        programId: 'p-bracket',
        text: 'New line',
        refs: [],
      }),
    );
    act(() => flushNotices());
    await until(() => !!screen.queryByText('New line'));
    const first = within(feed).getAllByRole('article')[0]!;
    first.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(feed).getAllByRole('article')[1]);
    await user.selectOptions(screen.getByLabelText('Program'), 'p-bracket');
    expect(within(screen.getByRole('feed')).getAllByRole('article')).toHaveLength(1);
    await user.click(screen.getByRole('tab', { name: 'Reports' }));
    const table = screen.getByRole('table', { name: 'Reports sent, newest first' });
    expect(within(table).getByText('Gate <u>ph1</u>')).toBeTruthy();
    expect(within(table).getByText('markdown, email')).toBeTruthy();
    expect(within(table).getByText('archive only')).toBeTruthy();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('explains a kernel without Enterprise mode, and retries after an error', async () => {
    await openEnterprise(
      {},
      {
        'enterprise.snapshot': () => {
          throw new RpcFailure(-32005, 'not enabled');
        },
      },
    );
    expect(screen.getByText('Enterprise mode is not running')).toBeTruthy();
    expect(screen.getByText(/kpai serve --headless/)).toBeTruthy();
    await teardown(kernel);
    let fail = true;
    const user = await openEnterprise(
      {},
      {
        'enterprise.snapshot': () => {
          if (fail) throw new Error('boom');
          return snapshot();
        },
      },
    );
    expect(screen.getByText('Could not load the enterprise: boom')).toBeTruthy();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await until(() => !!screen.queryByText('$12.40 spent'));
  });

  it('shows an empty enterprise calmly, in French too', async () => {
    const empty = {
      ...snapshot(),
      programs: [],
      seats: [],
      inbox: [],
      gauges: [],
      results: [],
      reports: [],
      queue: [],
    };
    setPrefs((p) => ({ ...p, locale: 'fr' }));
    resetEnterprise();
    ({ kernel } = await renderStudio(enterpriseFake(empty).handlers));
    setPrefs((p) => ({ ...p, locale: 'fr' }));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /^Entreprise/ }));
    await until(() => !!screen.queryByText('Rien ne vous attend.'));
    expect(screen.getByText('Aucun poste n’est encore pourvu.')).toBeTruthy();
    expect(screen.getByText('Aucune dépense pour l’instant.')).toBeTruthy();
    expect(screen.getByText('Aucun résultat terminé pour l’instant.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Rapports' }));
    expect(screen.getByText('Aucun rapport envoyé pour l’instant.')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Activité' }));
    expect(seat(0).seatId).toBe('s0');
  });

  it('switches views with Alt+E and the palette', async () => {
    resetEnterprise();
    ({ kernel } = await renderStudio(enterpriseFake().handlers));
    const user = userEvent.setup();
    await user.keyboard('{Alt>}e{/Alt}');
    expect(studio.getState().view).toBe('enterprise');
    await until(() => enterprise.getState().ui.status === 'ready');
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Stop everything{Enter}');
    await until(() => kernel!.calls('enterprise.kill').length === 1);
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Show the workspace{Enter}');
    expect(studio.getState().view).toBe('workspace');
  });
});
