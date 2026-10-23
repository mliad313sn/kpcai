/** Per-viewer display preferences, kept in localStorage when it is available. */
import type { Prefs, Zone } from './types';

const KEY = 'kp-studio.prefs';

export const SIZE_LIMITS: Record<Zone, { min: number; max: number }> = {
  explorer: { min: 160, max: 480 },
  agents: { min: 220, max: 560 },
  thread: { min: 140, max: 640 },
};

export function defaultPrefs(): Prefs {
  return {
    theme: 'system',
    density: 'comfortable',
    collapsed: { explorer: false, agents: false, thread: false },
    sizes: { explorer: 220, agents: 320, thread: 260 },
  };
}

export const clampSize = (zone: Zone, px: number): number =>
  Math.round(Math.min(SIZE_LIMITS[zone].max, Math.max(SIZE_LIMITS[zone].min, px)));

export function loadPrefs(): Prefs {
  const d = defaultPrefs();
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return d;
    const p = JSON.parse(raw) as Partial<Prefs>;
    const zones: Zone[] = ['explorer', 'agents', 'thread'];
    return {
      theme: ['system', 'dark', 'light'].includes(p.theme ?? '') ? p.theme! : d.theme,
      density: p.density === 'compact' ? 'compact' : 'comfortable',
      collapsed: Object.fromEntries(
        zones.map((z) => [z, p.collapsed?.[z] === true]),
      ) as Prefs['collapsed'],
      sizes: Object.fromEntries(
        zones.map((z) => {
          const v = p.sizes?.[z];
          return [z, typeof v === 'number' && Number.isFinite(v) ? clampSize(z, v) : d.sizes[z]];
        }),
      ) as Prefs['sizes'],
    };
  } catch {
    return d;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable: preferences last for this page only */
  }
}
