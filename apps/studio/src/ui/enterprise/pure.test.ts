import { describe, expect, it } from 'vitest';
import { setLocale } from '../../i18n/core';
import { clock, formatAge, programStatusLabel } from './parts';
import { moveIndex, rowTops, windowRange } from './virtual';

describe('windowed lists', () => {
  it('renders the rows in view plus a few around them', () => {
    const uniform = rowTops(new Array<number>(1000).fill(100));
    expect(uniform.total).toBe(100_000);
    expect(windowRange(uniform.tops, 0, 600)).toEqual({ start: 0, end: 11 });
    expect(windowRange(uniform.tops, 5000, 600)).toEqual({ start: 46, end: 61 });
    expect(windowRange(rowTops([100, 100, 100]).tops, 0, 600)).toEqual({ start: 0, end: 3 });
    expect(windowRange([], 0, 600)).toEqual({ start: 0, end: 0 });
    // Short heading rows and tall seat rows.
    const mixed = rowTops([40, 100, 100, 40, 100]);
    expect(mixed.tops).toEqual([0, 40, 140, 240, 280]);
    expect(windowRange(mixed.tops, 250, 20, 0)).toEqual({ start: 3, end: 4 });
    expect(windowRange(mixed.tops, 250, 40, 0)).toEqual({ start: 3, end: 5 });
  });

  it('moves the focus with arrows, pages, Home and End, within bounds', () => {
    expect(moveIndex('ArrowDown', 0, 10, 3)).toBe(3);
    expect(moveIndex('ArrowUp', 1, 10, 3)).toBe(0);
    expect(moveIndex('ArrowRight', 9, 10, 3)).toBe(9);
    expect(moveIndex('ArrowLeft', 4, 10, 3)).toBe(3);
    expect(moveIndex('PageDown', 0, 100, 2, 4)).toBe(8);
    expect(moveIndex('PageUp', 3, 100, 2, 4)).toBe(0);
    expect(moveIndex('Home', 7, 10)).toBe(0);
    expect(moveIndex('End', 0, 10)).toBe(9);
    expect(moveIndex('ArrowRight', 0, 10, 1)).toBeUndefined();
    expect(moveIndex('Enter', 0, 10)).toBeUndefined();
    expect(moveIndex('ArrowDown', 0, 0)).toBeUndefined();
  });
});

describe('enterprise wording', () => {
  it('says ages and times in the display language', () => {
    setLocale('en');
    expect(formatAge(5_000)).toBe('5 s');
    expect(formatAge(-1)).toBe('0 s');
    expect(formatAge(125_000)).toBe('2 min');
    expect(formatAge(3 * 3600_000 + 60_000)).toBe('3 h 1 min');
    expect(formatAge(72 * 3600_000)).toBe('3 days');
    expect(clock('not a date')).toBe('—');
    expect(clock('2026-10-23T12:34:56Z')).toMatch(/\d\d:\d\d:\d\d/);
    expect(programStatusLabel('gate')).toBe('at the gate');
    expect(programStatusLabel('mystery')).toBe('mystery');
    setLocale('fr');
    expect(formatAge(72 * 3600_000)).toBe('3 jours');
    expect(programStatusLabel('paused')).toBe('en pause');
    setLocale('en');
  });
});
