// @vitest-environment jsdom
/**
 * Simplicity Charter §3 tiers (finding P5-F5): what Beginner, Regular and Expert see, how
 * the Enterprise view appears for a beginner, and Stop everything on every tier.
 */
import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { enterprise, resetEnterprise } from '../enterprise/store';
import { loadPrefs } from '../store/prefs';
import { studio } from '../store/store';
import type { EnterpriseSnapshot } from '../enterprise/schemas';
import type { Prefs } from '../store/types';
import type { FakeKernel } from '../test-helpers/fake-kernel';
import { enterpriseFake, snapshot } from '../test-helpers/enterprise-fixtures';
import { renderStudio, teardown, until } from '../test-helpers/ui';

let kernel: FakeKernel | undefined;

afterEach(async () => {
  await teardown(kernel);
  kernel = undefined;
  resetEnterprise();
});

const noPrograms = (): EnterpriseSnapshot => ({ ...snapshot(), programs: [], inbox: [] });

/** The console with this snapshot, once the snapshot is loaded (whatever the view). */
async function start(snap: EnterpriseSnapshot, prefs: Partial<Prefs> = {}) {
  resetEnterprise();
  ({ kernel } = await renderStudio(enterpriseFake(snap).handlers, prefs));
  await until(() => enterprise.getState().ui.status === 'ready');
  return userEvent.setup();
}

const viewSwitch = () => screen.queryByRole('navigation', { name: 'Views' });
const tab = (name: string | RegExp) => screen.queryByRole('tab', { name });

async function paletteLabels(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  await user.keyboard('{Control>}k{/Control}');
  const labels = within(screen.getByRole('listbox'))
    .getAllByRole('option')
    .map((o) => o.textContent ?? '');
  await user.keyboard('{Escape}');
  return labels;
}

describe('Beginner tier (the default)', () => {
  it('never shows the Enterprise switch without a program', async () => {
    const user = await start(noPrograms());
    expect(studio.getState().prefs.tier).toBe('beginner');
    expect(viewSwitch()).toBeNull();
    expect(screen.queryByRole('button', { name: /Enterprise|Delegated projects/ })).toBeNull();
    // Alt+E does nothing for a beginner who has no program.
    await user.keyboard('{Alt>}e{/Alt}');
    expect(studio.getState().view).toBe('workspace');
    expect(screen.queryByRole('heading', { name: 'Enterprise' })).toBeNull();
    // The Tools & skills tab is hidden; the core tabs stay.
    expect(tab('Tools & skills')).toBeNull();
    expect(tab('Conversation')).toBeTruthy();
    // Stop everything has nothing to stop yet.
    expect(screen.queryByRole('button', { name: 'Stop everything' })).toBeNull();
    const labels = await paletteLabels(user);
    expect(labels).toContain(
      'Delegate a whole project — KP does a whole project for you; you approve the plan and its cost',
    );
    expect(labels.some((l) => l.startsWith('Show the Enterprise view'))).toBe(false);
    expect(labels.some((l) => l.startsWith('/tools'))).toBe(false);
    expect(labels).not.toContain('Go to Tools & skills');
    expect(labels).toContain('Set the level to Regular');
    expect(labels).toContain('Set the level to Expert');
  });

  it('shows the Enterprise view once a program exists, in plain words, and keeps it', async () => {
    const user = await start(snapshot());
    const nav = viewSwitch();
    expect(nav).toBeTruthy();
    expect(within(nav!).getByRole('button', { name: 'My tasks' })).toBeTruthy();
    expect(
      within(nav!).getByRole('button', { name: /^Delegated projects · 3 questions/ }),
    ).toBeTruthy();
    expect(studio.getState().prefs.enterpriseShown).toBe(true);
    expect(loadPrefs().enterpriseShown).toBe(true);
    // A program runs: Stop everything is in the header of the workspace, on this tier too.
    await user.click(screen.getByRole('button', { name: 'Stop everything' }));
    await until(() => kernel!.calls('enterprise.kill').length === 1);
    await until(() => !screen.queryByRole('button', { name: 'Stop everything' }));
    // Still a beginner: no Tools tab, and the team is never split into departments.
    expect(tab('Tools & skills')).toBeNull();
    await user.click(within(nav!).getByRole('button', { name: /^Delegated projects/ }));
    await until(() => document.activeElement?.id === 'ent-title');
    expect(screen.queryByRole('group', { name: 'Show as' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Departments (expert)' })).toBeNull();
  });

  it('opens the Enterprise view from "Delegate a whole project", and it stays reachable', async () => {
    const user = await start(noPrograms());
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Delegate a whole project{Enter}');
    await until(() => document.activeElement?.id === 'ent-title');
    expect(studio.getState().view).toBe('enterprise');
    expect(loadPrefs().enterpriseShown).toBe(true);
    // A new page (a reload) keeps the switch, read back from storage.
    cleanup();
    await teardown(kernel);
    resetEnterprise();
    localStorage.setItem('kp-studio.prefs', JSON.stringify({ enterpriseShown: true }));
    ({ kernel } = await renderStudio(enterpriseFake(noPrograms()).handlers, loadPrefs()));
    expect(viewSwitch()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Delegated projects' })).toBeTruthy();
  });

  it('keeps a stopped portfolio calm: no Stop everything when every program is over', async () => {
    const snap = snapshot();
    const over = { ...snap, programs: snap.programs.map((p) => ({ ...p, status: 'delivered' })) };
    await start(over);
    expect(viewSwitch()).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop everything' })).toBeNull();
  });

  it('speaks French with the beginner words', async () => {
    await start(snapshot(), { locale: 'fr' });
    expect(screen.getByLabelText('Niveau')).toHaveProperty('value', 'beginner');
    expect(screen.getByRole('button', { name: 'Mes tâches' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Projets confiés · 3 questions/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tout arrêter' })).toBeTruthy();
  });
});

describe('Regular and Expert tiers', () => {
  it('Regular shows the Enterprise view and Tools, not departments; the switch persists', async () => {
    const user = await start(noPrograms());
    await user.selectOptions(screen.getByLabelText('Level'), 'regular');
    expect(loadPrefs().tier).toBe('regular');
    expect(within(viewSwitch()!).getByRole('button', { name: 'Enterprise' })).toBeTruthy();
    expect(tab('Tools & skills')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Enterprise' }));
    await until(() => document.activeElement?.id === 'ent-title');
    expect(screen.queryByRole('button', { name: 'Departments (expert)' })).toBeNull();
    // Back to Beginner: the Tools tab goes, a chosen Tools tab falls back to the conversation.
    studio.setState({ tab: 'tools', view: 'workspace' });
    await user.selectOptions(screen.getByLabelText('Level'), 'beginner');
    expect(tab('Tools & skills')).toBeNull();
    expect(tab('Conversation')?.getAttribute('aria-selected')).toBe('true');
    // Enterprise was shown once: it stays reachable for the beginner.
    expect(viewSwitch()).toBeTruthy();
  });

  it('Expert also shows departments; the palette sets the tier', async () => {
    const user = await start(snapshot(), { tier: 'regular' });
    await user.keyboard('{Control>}k{/Control}');
    await user.keyboard('Set the level to Expert{Enter}');
    expect(studio.getState().prefs.tier).toBe('expert');
    await user.click(screen.getByRole('button', { name: /^Enterprise/ }));
    await until(() => document.activeElement?.id === 'ent-title');
    expect(screen.getByRole('button', { name: 'Departments (expert)' })).toBeTruthy();
    expect(studio.getState().announcement.text).toBe('Level: Expert');
  });
});
