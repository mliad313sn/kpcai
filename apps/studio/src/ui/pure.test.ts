// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GRAPH } from '../test-helpers/fixtures';
import type { GraphNode } from '../rpc/schemas';
import { clampSize, defaultPrefs, loadPrefs, savePrefs } from '../store/prefs';
import { columns, neighbour } from './layout';
import { THEMES, TEXT_PAIRS, UI_PAIRS, applyTheme, contrast, resolveTheme } from './theme';

const node = (id: string, dependsOn: string[] = []): GraphNode => ({
  id,
  title: id,
  type: 'code',
  protocol: 'solo',
  dependsOn,
});

describe('graph layout', () => {
  it('puts nodes in dependency columns, tolerating unknown and cyclic deps', () => {
    const cols = columns([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c', 'zz']),
    ]);
    expect(cols.map((c) => c.map((n) => n.id))).toEqual([['a'], ['b', 'c'], ['d']]);
    const cyc = columns([node('x', ['y']), node('y', ['x'])]);
    expect(
      cyc
        .flat()
        .map((n) => n.id)
        .sort(),
    ).toEqual(['x', 'y']);
    expect(columns(GRAPH.nodes).length).toBe(3);
  });

  it('moves between neighbours with arrows', () => {
    const cols = columns([node('a'), node('b', ['a']), node('c', ['a'])]);
    expect(neighbour(cols, 'a', 'ArrowRight')).toBe('b');
    expect(neighbour(cols, 'b', 'ArrowDown')).toBe('c');
    expect(neighbour(cols, 'c', 'ArrowUp')).toBe('b');
    expect(neighbour(cols, 'c', 'ArrowLeft')).toBe('a');
    expect(neighbour(cols, 'a', 'ArrowLeft')).toBeUndefined();
    expect(neighbour(cols, 'zz', 'ArrowLeft')).toBeUndefined();
  });
});

describe('themes (WCAG 2.2 AA)', () => {
  for (const name of ['dark', 'light'] as const) {
    it(`${name}: text pairs reach 4.5:1 and UI pairs 3:1`, () => {
      const t = THEMES[name];
      for (const [fg, bg] of TEXT_PAIRS)
        expect(contrast(t[fg], t[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of UI_PAIRS)
        expect(contrast(t[fg], t[bg]), `${fg}/${bg}`).toBeGreaterThanOrEqual(3);
    });
  }

  it('resolves the system theme and applies tokens', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    const el = document.createElement('div');
    applyTheme(el, 'light', 'compact');
    expect(el.style.getPropertyValue('--bg')).toBe(THEMES.light.bg);
    expect(el.dataset).toMatchObject({ theme: 'light', density: 'compact' });
  });
});

describe('preferences', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips, clamps sizes and ignores garbage', () => {
    const p = { ...defaultPrefs(), theme: 'light' as const, density: 'compact' as const };
    p.sizes.explorer = 9999;
    savePrefs(p);
    const back = loadPrefs();
    expect(back.theme).toBe('light');
    expect(back.density).toBe('compact');
    expect(back.sizes.explorer).toBe(480);
    localStorage.setItem('kp-studio.prefs', '{bad');
    expect(loadPrefs()).toEqual(defaultPrefs());
    localStorage.setItem(
      'kp-studio.prefs',
      JSON.stringify({ theme: 'neon', sizes: { thread: 'x' } }),
    );
    expect(loadPrefs()).toEqual(defaultPrefs());
    expect(clampSize('thread', 10)).toBe(140);
  });

  it('survives storage that throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => savePrefs(defaultPrefs())).not.toThrow();
    spy.mockRestore();
  });
});
