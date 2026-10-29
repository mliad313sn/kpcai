import { useState } from 'react';
import { resolveLocale, t, type Key } from '../i18n/core';
import { control, startRun, submit } from '../store/actions';
import { COMMANDS, commandHint } from '../store/commands';
import { patch, setPrefs, studio, useStudio } from '../store/store';
import type { StudioState, Tab } from '../store/types';
import { kill } from '../enterprise/actions';
import { enterprise } from '../enterprise/store';
import { visibleTabs } from './CenterTabs';
import { showView } from './hooks';
import { Modal } from './Modal';
import { toggleZone } from './Zone';
import { activeRun } from './view';
import { TIERS, TIER_LABEL, setTier, visibility, type Visibility } from '../store/tier';
import { delegateProject } from './Tier';

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function fillCommandBar(text: string): void {
  const input = document.getElementById('command-input') as HTMLInputElement | null;
  if (!input) return;
  // Native setter + input event so React's controlled input sees the change.
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  set?.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

const goTo = (tab: Tab, label: Key): PaletteItem => ({
  id: `tab-${tab}`,
  label: t('palette.goTo', { tab: t(label) }),
  run: () => patch({ tab, view: 'workspace' }),
});

/** The other view (or, for a beginner who has none yet, "Delegate a whole project"). */
function otherView(s: StudioState, v: Visibility): PaletteItem {
  if (!v.enterprise)
    return {
      id: 'delegate',
      label: t('palette.delegate'),
      hint: t('palette.delegateHint'),
      run: delegateProject,
    };
  if (s.view === 'enterprise')
    return {
      id: 'view-workspace',
      label: t(v.plainWords ? 'palette.workspace.plain' : 'palette.workspace'),
      run: () => showView('workspace'),
    };
  return {
    id: 'view-enterprise',
    label: t(v.plainWords ? 'palette.enterprise.plain' : 'palette.enterprise'),
    run: () => showView('enterprise'),
  };
}

/** The other view, and the portfolio kill switch when the Enterprise view knows one. */
function viewItems(s: StudioState, v: Visibility): PaletteItem[] {
  const ent = enterprise.getState();
  const items: PaletteItem[] = [otherView(s, v)];
  if (ent.ui.status === 'ready' && !ent.data.killSwitch)
    items.push({ id: 'stop-all', label: t('ent.kill.button'), run: () => void kill() });
  return items;
}

function runItems(s: StudioState): PaletteItem[] {
  const items: PaletteItem[] = [];
  if (s.plan)
    items.push({ id: 'run-plan', label: t('palette.runPlan'), run: () => void startRun() });
  const run = activeRun(s);
  if (run && (run.state === 'running' || run.state === 'starting'))
    items.push({
      id: 'pause',
      label: t('palette.pause'),
      run: () => void control('pause', run.runId),
    });
  if (run?.state === 'paused')
    items.push({
      id: 'resume',
      label: t('palette.resume'),
      run: () => void control('resume', run.runId),
    });
  if (run && ['starting', 'running', 'paused'].includes(run.state))
    items.push({
      id: 'cancel',
      label: t('palette.cancel'),
      run: () => void control('cancel', run.runId),
    });
  return items;
}

/** One entry per other tier (Charter §3: the tier is settable from here). */
function tierItems(s: StudioState): PaletteItem[] {
  return TIERS.filter((x) => x !== s.prefs.tier).map((x) => ({
    id: `tier-${x}`,
    label: t('palette.tier', { tier: t(TIER_LABEL[x]) }),
    run: () => setTier(x),
  }));
}

/** Everything the palette can do right now: run controls, commands, views, settings. */
export function paletteItems(s: StudioState): PaletteItem[] {
  const v = visibility(s.prefs, enterprise.getState().data.programs.length);
  return [
    ...runItems(s),
    ...viewItems(s, v),
    ...COMMANDS.filter((c) => v.tools || c.name !== 'tools').map((c) => ({
      id: `cmd-${c.name}`,
      label: `/${c.name}`,
      hint: commandHint(c.name),
      run: () =>
        c.name === 'plan' || c.name === 'run'
          ? fillCommandBar(`/${c.name} `)
          : void submit(`/${c.name}`),
    })),
    ...visibleTabs(v).map((x) => goTo(x.id, x.label)),
    ...(['explorer', 'agents', 'thread'] as const).map((z) => ({
      id: `toggle-${z}`,
      label: t('palette.toggle', { zone: t(`zone.${z}`) }),
      run: () => toggleZone(z),
    })),
    ...tierItems(s),
    {
      id: 'language',
      label: t('palette.language'),
      run: () =>
        setPrefs((p) => ({ ...p, locale: resolveLocale(p.locale) === 'fr' ? 'en' : 'fr' })),
    },
    {
      id: 'onboarding',
      label: t('palette.onboarding'),
      run: () => patch({ onboardingOpen: true }),
    },
    {
      id: 'theme',
      label: t('palette.theme'),
      run: () => setPrefs((p) => ({ ...p, theme: nextTheme(p.theme) })),
    },
    {
      id: 'density',
      label: t('palette.density'),
      run: () =>
        setPrefs((p) => ({ ...p, density: p.density === 'compact' ? 'comfortable' : 'compact' })),
    },
  ];
}

export const nextTheme = (t: StudioState['prefs']['theme']) =>
  t === 'system' ? 'dark' : t === 'dark' ? 'light' : 'system';

function close(): void {
  patch({ paletteOpen: false });
}

export function Palette() {
  const open = useStudio((s) => s.paletteOpen);
  return open ? <PaletteDialog /> : null;
}

function PaletteList(props: {
  items: PaletteItem[];
  active: number;
  pick: (i: PaletteItem) => void;
}) {
  return (
    <ul id="palette-list" role="listbox" aria-label={t('palette.list')}>
      {props.items.map((item, i) => (
        <li
          key={item.id}
          id={`pal-${item.id}`}
          role="option"
          aria-selected={i === props.active}
          onClick={() => props.pick(item)}
        >
          {item.label}
          {item.hint && <span className="muted"> — {item.hint}</span>}
        </li>
      ))}
      {props.items.length === 0 && <li className="muted">{t('palette.noMatch')}</li>}
    </ul>
  );
}

function PaletteDialog() {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const query = q.trim().toLowerCase();
  const items = paletteItems(studio.getState()).filter((i) =>
    `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(query),
  );
  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (items.length ? (a + d + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(items[active]);
    }
  };
  return (
    <Modal labelledBy="palette-title" onClose={close} className="palette" initialFocus="input">
      <h2 id="palette-title" className="sr-only">
        {t('palette.title')}
      </h2>
      <input
        type="text"
        role="combobox"
        aria-label={t('palette.search')}
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={items.length ? `pal-${items[active]?.id}` : undefined}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      <PaletteList items={items} active={active} pick={pick} />
    </Modal>
  );
}
