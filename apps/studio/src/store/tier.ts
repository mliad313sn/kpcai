/**
 * Progressive disclosure (Simplicity Charter §3, finding P5-F5). Beginner, the default,
 * sees the seven core jobs only; Regular adds the Enterprise view and Tools; Expert adds
 * departments and the advanced panels. The Enterprise view shows for a beginner once a
 * program exists or once they chose "Delegate a whole project", and then stays.
 */
import { t, type Key } from '../i18n/core';
import { announce, setPrefs } from './store';
import type { Prefs, Tier } from './types';

export const TIERS: readonly Tier[] = ['beginner', 'regular', 'expert'];

export const TIER_LABEL: Record<Tier, Key> = {
  beginner: 'tier.beginner',
  regular: 'tier.regular',
  expert: 'tier.expert',
};

const RANK: Record<Tier, number> = { beginner: 0, regular: 1, expert: 2 };

export const atLeast = (tier: Tier, min: Tier): boolean => RANK[tier] >= RANK[min];

export interface Visibility {
  /** The Workspace / Enterprise switch, Alt+E and the palette's view item. */
  enterprise: boolean;
  /** The Tools & skills tab and the `/tools` palette entry. */
  tools: boolean;
  /** The org map's team / departments toggle. */
  departments: boolean;
  /** Score breakdowns and other expert-only panels. */
  advanced: boolean;
  /** Labels in the beginner vocabulary (Charter §3: task, plan, cost, check…). */
  plainWords: boolean;
}

/** What this viewer sees, from their tier and the number of programs in the portfolio. */
export function visibility(
  prefs: Pick<Prefs, 'tier' | 'enterpriseShown'>,
  programs: number,
): Visibility {
  const regular = atLeast(prefs.tier, 'regular');
  return {
    enterprise: regular || prefs.enterpriseShown || programs > 0,
    tools: regular,
    departments: prefs.tier === 'expert',
    advanced: prefs.tier === 'expert',
    plainWords: !regular,
  };
}

export function setTier(tier: Tier): void {
  setPrefs((p) => (p.tier === tier ? p : { ...p, tier }));
  announce(t('tier.announce', { tier: t(TIER_LABEL[tier]) }));
}

/** Keeps the Enterprise view reachable from now on (a program appeared, or the user asked). */
export function keepEnterprise(): void {
  setPrefs((p) => (p.enterpriseShown ? p : { ...p, enterpriseShown: true }));
}
