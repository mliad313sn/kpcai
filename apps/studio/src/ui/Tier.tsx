/**
 * The tier switch, what each tier shows, and the parts that never hide (Simplicity Charter
 * §2 and §3, P5-F5): Stop everything stays one action away whenever a program runs.
 */
import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { t } from '../i18n/core';
import { ENDED_PROGRAM } from '../enterprise/derive';
import { kill, loadSnapshot } from '../enterprise/actions';
import { useEnt } from '../enterprise/store';
import { useStudio } from '../store/store';
import {
  TIERS,
  TIER_LABEL,
  keepEnterprise,
  setTier,
  visibility,
  type Visibility,
} from '../store/tier';
import type { Tier } from '../store/types';
import { showView } from './hooks';

export function useVisibility(): Visibility {
  const prefs = useStudio(
    useShallow((s) => ({ tier: s.prefs.tier, enterpriseShown: s.prefs.enterpriseShown })),
  );
  const programs = useEnt((s) => s.data.programs.length);
  return visibility(prefs, programs);
}

/** "Delegate a whole project": the beginner's one way in to the Enterprise view. */
export function delegateProject(): void {
  showView('enterprise');
}

/**
 * Loads the enterprise snapshot once connected, whatever the view, so the console knows
 * whether a program exists; and keeps the Enterprise view once a program was seen.
 */
export function useEnterpriseWatch(): void {
  const conn = useStudio((s) => s.conn);
  const status = useEnt((s) => s.ui.status);
  const programs = useEnt((s) => s.data.programs.length);
  const shown = useStudio((s) => s.prefs.enterpriseShown);
  useEffect(() => {
    if (conn === 'open' && status === 'idle') void loadSnapshot();
  }, [conn, status]);
  useEffect(() => {
    if (programs > 0 && !shown) keepEnterprise();
  }, [programs, shown]);
}

/** The visible tier switch (Charter §3), next to the language. */
export function TierSelect() {
  const tier = useStudio((s) => s.prefs.tier);
  return (
    <span className="lang">
      <label htmlFor="tier-select">{t('tier.label')}</label>
      <select id="tier-select" value={tier} onChange={(e) => setTier(e.target.value as Tier)}>
        {TIERS.map((x) => (
          <option key={x} value={x}>
            {t(TIER_LABEL[x])}
          </option>
        ))}
      </select>
    </span>
  );
}

/** A program is not over and work is allowed: Stop everything must be on screen. */
export function useProgramsRunning(): boolean {
  return useEnt(
    (s) =>
      s.ui.status === 'ready' &&
      !s.data.killSwitch &&
      s.data.programs.some((p) => !ENDED_PROGRAM.has(p.status)),
  );
}

/**
 * Stop everything in the header while a program runs, on every tier. The Enterprise view
 * shows its own, so this one is for the workspace.
 */
export function HeaderStopAll() {
  const running = useProgramsRunning();
  const view = useStudio((s) => s.view);
  const busy = useEnt((s) => !!s.ui.busy['portfolio']);
  if (!running || view === 'enterprise') return null;
  return (
    <button type="button" className="danger stop-all" disabled={busy} onClick={() => void kill()}>
      <span aria-hidden="true">■ </span>
      {t('ent.kill.button')}
    </button>
  );
}
