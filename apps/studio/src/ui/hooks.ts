import { useEffect, useState } from 'react';
import { patch, setPrefs, studio, useStudio } from '../store/store';
import { activeRun } from './view';
import { applyTheme, resolveTheme } from './theme';

/** Current time, refreshed every `ms` while `enabled` (agents board elapsed timers). */
export function useNow(ms = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
  return now;
}

function prefersDark(): MediaQueryList | undefined {
  return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
}

/** Applies theme and density to <html>, following the OS when the preference is "system". */
export function useThemeEffect(): void {
  const theme = useStudio((s) => s.prefs.theme);
  const density = useStudio((s) => s.prefs.density);
  useEffect(() => {
    const mq = prefersDark();
    const apply = () =>
      applyTheme(document.documentElement, resolveTheme(theme, mq?.matches ?? true), density);
    apply();
    mq?.addEventListener?.('change', apply);
    return () => mq?.removeEventListener?.('change', apply);
  }, [theme, density]);
}

/** "KP Studio — <run state>" in the window title. */
export function useDocumentTitle(): void {
  const state = useStudio((s) => activeRun(s)?.state);
  const planning = useStudio((s) => s.planning);
  useEffect(() => {
    const what = planning ? 'planning' : state;
    document.title = what ? `KP Studio — ${what}` : 'KP Studio';
  }, [state, planning]);
}

export const ZONE_IDS = ['command', 'explorer', 'center', 'agents', 'thread'] as const;

function focusZone(n: number): void {
  const id = ZONE_IDS[n];
  if (!id) return;
  if (id === 'explorer' || id === 'agents' || id === 'thread') {
    setPrefs((p) => (p.collapsed[id] ? { ...p, collapsed: { ...p.collapsed, [id]: false } } : p));
  }
  requestAnimationFrame(() => {
    const target =
      id === 'command'
        ? document.getElementById('command-input')
        : document.getElementById(`zone-${id}-heading`);
    target?.focus();
  });
}

function isEditable(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

/** Ctrl/Cmd+K palette, `/` focuses the command bar, Alt+1..5 focuses a zone. */
export function onGlobalKey(e: KeyboardEvent): void {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    patch({ paletteOpen: !studio.getState().paletteOpen });
  } else if (e.altKey && /^[1-5]$/.test(e.key)) {
    e.preventDefault();
    focusZone(Number(e.key) - 1);
  } else if (e.key === '/' && !isEditable(e.target) && !studio.getState().paletteOpen) {
    e.preventDefault();
    document.getElementById('command-input')?.focus();
  }
}

export function useGlobalKeys(): void {
  useEffect(() => {
    window.addEventListener('keydown', onGlobalKey);
    return () => window.removeEventListener('keydown', onGlobalKey);
  }, []);
}
