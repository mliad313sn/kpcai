import { describe, expect, it } from 'vitest';
import { WINDOW, notReady, quoteLines, scrolled, shownTo } from './dispute';

describe('dispute option view in the terminal (P4-F11)', () => {
  it('cuts very long lines so a window stays bounded, keeping every character', () => {
    const text = `short\n${'x'.repeat(450)}`;
    const lines = quoteLines(text);
    expect(lines.map((l) => l.length)).toEqual([5, 200, 200, 50]);
    expect(lines.slice(1).join('')).toBe('x'.repeat(450));
  });

  it('scrolls by windows within the text and counts what was shown', () => {
    expect(scrolled(0, 1, 30)).toBe(WINDOW);
    expect(scrolled(WINDOW, 1, 30)).toBe(30 - WINDOW);
    expect(scrolled(5, -1, 30)).toBe(0);
    expect(scrolled(0, 1, 5)).toBe(0);
    expect(shownTo(0, 5)).toBe(5);
    expect(shownTo(18, 30)).toBe(30);
  });

  it('refuses a cut option and one not read to the end', () => {
    expect(notReady({ text: 'a', truncated: true }, 1)).toBe('truncated');
    expect(notReady({ text: 'a\nb' }, 1)).toBe('unread');
    expect(notReady({ text: 'a\nb' }, 2)).toBeUndefined();
  });
});
