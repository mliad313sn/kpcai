import { describe, expect, it } from 'vitest';
import { formatUsd } from '../store/format';
import {
  CATALOGUES,
  LOCALES,
  localeFrom,
  placeholders,
  resolveLocale,
  setLocale,
  t,
  type Key,
} from './core';
import { en } from './en';

describe('message catalogue (WI-S6-02)', () => {
  it('has every key in every language, with the same placeholders and plural shape', () => {
    const keys = Object.keys(en).sort();
    for (const locale of LOCALES) {
      const cat = CATALOGUES[locale] as Record<string, unknown>;
      expect(Object.keys(cat).sort(), `keys of ${locale}`).toEqual(keys);
      for (const k of keys) {
        const m = CATALOGUES[locale][k as Key];
        const ref = en[k as Key];
        expect(typeof m, `${locale} ${k}`).toBe(typeof ref);
        expect(placeholders(m), `${locale} ${k}`).toEqual(placeholders(ref));
        const forms = typeof m === 'string' ? [m] : [m.one, m.other];
        for (const f of forms) expect(f.trim(), `${locale} ${k}`).not.toBe('');
      }
    }
  });

  it('renders French with plurals and parameters, English as the fallback', () => {
    setLocale('fr');
    expect(t('plan.run', { cap: '1 $' })).toBe('Lancer (plafond 1 $)');
    expect(t('explorer.events', { count: 1 })).toBe('1 événement');
    expect(t('explorer.events', { count: 3 })).toBe('3 événements');
    expect(formatUsd(0.42)).toMatch(/^0,42\s\$$/);
    setLocale('en');
    expect(t('explorer.events', { count: 1 })).toBe('1 event');
    expect(t('explorer.events', { count: 2 })).toBe('2 events');
    expect(t('fail.cancel', {})).toBe('Cancel failed: {error}');
    expect(formatUsd(0.42)).toBe('$0.42');
  });

  it('picks the language from the browser or the OS locale', () => {
    expect(localeFrom('fr-CA')).toBe('fr');
    expect(localeFrom('fr_FR.UTF-8')).toBe('fr');
    expect(localeFrom('en-GB')).toBe('en');
    expect(localeFrom('frisian')).toBe('en');
    expect(localeFrom(undefined)).toBe('en');
    expect(resolveLocale('fr')).toBe('fr');
    expect(['en', 'fr']).toContain(resolveLocale('system'));
  });
});
