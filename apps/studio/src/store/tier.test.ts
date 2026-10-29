// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultPrefs, loadPrefs, savePrefs } from './prefs';
import { atLeast, visibility } from './tier';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('disclosure tiers (Simplicity Charter §3, P5-F5)', () => {
  it('Beginner shows the core jobs only until a program exists or the view was chosen', () => {
    const b = { tier: 'beginner' as const, enterpriseShown: false };
    expect(visibility(b, 0)).toEqual({
      enterprise: false,
      tools: false,
      departments: false,
      advanced: false,
      plainWords: true,
    });
    expect(visibility(b, 1).enterprise).toBe(true);
    expect(visibility({ ...b, enterpriseShown: true }, 0).enterprise).toBe(true);
    expect(visibility({ ...b, enterpriseShown: true }, 0).tools).toBe(false);
  });

  it('Regular adds the Enterprise view and Tools; Expert adds departments and panels', () => {
    expect(visibility({ tier: 'regular', enterpriseShown: false }, 0)).toEqual({
      enterprise: true,
      tools: true,
      departments: false,
      advanced: false,
      plainWords: false,
    });
    expect(visibility({ tier: 'expert', enterpriseShown: false }, 0)).toEqual({
      enterprise: true,
      tools: true,
      departments: true,
      advanced: true,
      plainWords: false,
    });
    expect(atLeast('expert', 'regular')).toBe(true);
    expect(atLeast('beginner', 'regular')).toBe(false);
  });

  it('defaults to Beginner, keeps the tier per viewer and ignores garbage', () => {
    expect(defaultPrefs()).toMatchObject({ tier: 'beginner', enterpriseShown: false });
    savePrefs({ ...defaultPrefs(), tier: 'expert', enterpriseShown: true });
    expect(loadPrefs()).toMatchObject({ tier: 'expert', enterpriseShown: true });
    localStorage.setItem('kp-studio.prefs', JSON.stringify({ tier: 'god', enterpriseShown: 1 }));
    expect(loadPrefs()).toMatchObject({ tier: 'beginner', enterpriseShown: false });
  });

  it('falls back to Beginner when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPrefs().tier).toBe('beginner');
  });
});
