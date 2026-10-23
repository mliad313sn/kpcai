/**
 * The CLI speaks English and French (WI-S6-02): every key in both languages, the locale
 * from `--lang`, `KPAI_LANG` or the POSIX variables, and kernel or model text untouched.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskGraph } from '@kernelpai/core';
import { money } from '../config.js';
import { renderGraphPlan, type PlanEstimate } from '../graph/render.js';
import { main, USAGE } from '../main.js';
import { fakeIo } from '../test-helpers/fake-io.js';
import {
  CATALOGUES,
  LOCALES,
  cliLocale,
  isYes,
  localeFrom,
  placeholders,
  setLocale,
  t,
  type Key,
} from './core.js';
import { en } from './en.js';

afterEach(() => setLocale('en'));

describe('CLI message catalogue', () => {
  it('has every key in both languages, with the same placeholders', () => {
    const keys = Object.keys(en).sort();
    for (const locale of LOCALES) {
      const cat = CATALOGUES[locale] as Record<string, string>;
      expect(Object.keys(cat).sort(), `keys of ${locale}`).toEqual(keys);
      for (const k of keys) {
        expect(cat[k]!.trim(), `${locale} ${k}`).not.toBe('');
        expect(placeholders(cat[k]!), `${locale} ${k}`).toEqual(placeholders(en[k as Key]));
      }
    }
  });

  it('picks the locale from --lang, then KPAI_LANG, then LC_ALL, LC_MESSAGES, LANG', () => {
    expect(cliLocale({})).toBe('en');
    expect(cliLocale({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(cliLocale({ LC_MESSAGES: 'fr_CA', LANG: 'en_US' })).toBe('fr');
    expect(cliLocale({ LC_ALL: 'C', LC_MESSAGES: 'fr_FR' })).toBe('en');
    expect(cliLocale({ KPAI_LANG: 'en', LC_ALL: 'fr_FR' })).toBe('en');
    expect(cliLocale({ KPAI_LANG: 'fr', LANG: 'en_GB' })).toBe('fr');
    expect(cliLocale({ KPAI_LANG: 'fr' }, 'en')).toBe('en');
    expect(cliLocale({ LANG: '', LC_ALL: '' }, 'fr')).toBe('fr');
    expect(localeFrom('frisian')).toBe('en');
    expect(localeFrom('fr')).toBe('fr');
  });

  it('accepts y/yes in English and o/oui (or y) in French', () => {
    expect(isYes(' Y ')).toBe(true);
    expect(isYes('o')).toBe(false);
    setLocale('fr');
    expect(isYes('oui')).toBe(true);
    expect(isYes('O')).toBe(true);
    expect(isYes('non')).toBe(false);
    expect(isYes('')).toBe(false);
    expect(t('confirm.prompt', { question: 'git.apply src/a.ts?' })).toBe(
      'git.apply src/a.ts? [o/N] ',
    );
  });
});

describe('kpai in French', () => {
  it('with locale fr, USAGE and the main errors render in French', async () => {
    const io = fakeIo({ LANG: 'fr_FR.UTF-8' });
    expect(await main([], io)).toBe(0);
    expect(io.stdout).toContain('Utilisation :');
    expect(io.stdout).toContain('Vérifie la chaîne de hachage du journal');
    expect(io.stdout).not.toContain('Check the journal hash chain');
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.stderr).toContain('Commande inconnue « frobnicate »');
    expect(io.stderr).toContain('Utilisation :');
    expect(await main(['ask', '--bogus', 'x'], io)).toBe(2);
    expect(io.stderr).toContain('Option inconnue --bogus');
    expect(await main(['ask', '-m', 'mock/echo', '--max-tokens', '0', 'x'], io)).toBe(2);
    expect(io.stderr).toContain('--max-tokens doit être un entier positif');
    expect(await main(['plan'], io)).toBe(2);
    expect(io.stderr).toContain('plan et do ont besoin d’une demande');
    expect(await main(['merge'], io)).toBe(2);
    expect(io.stderr).toContain('merge a besoin d’un identifiant d’exécution');
    expect(await main(['studio', '--port', '70000'], io)).toBe(2);
    expect(io.stderr).toContain('--port doit être un numéro de port');
    expect(io.stderr).not.toMatch(/Unknown command|must be|needs a/);
  });

  it('keeps the kernel and provider text as is inside a translated frame', async () => {
    const io = fakeIo({ KPAI_LANG: 'fr' });
    expect(await main(['ask', 'hello'], io)).toBe(2);
    // The provider's own sentence is data: untranslated, after a French frame.
    expect(io.stderr).toContain('never picks a model by default');
  });

  it('follows --lang over the environment, and refuses an unknown language', async () => {
    const io = fakeIo({ LANG: 'fr_FR.UTF-8' });
    expect(await main(['--lang', 'en', 'help'], io)).toBe(0);
    expect(io.stdout).toBe(USAGE);
    const io2 = fakeIo();
    expect(await main(['--lang=fr', '--help'], io2)).toBe(0);
    expect(io2.stdout).toContain('Utilisation :');
    const io3 = fakeIo();
    expect(await main(['--lang', 'de', 'help'], io3)).toBe(2);
    expect(io3.stderr).toContain('--lang must be en or fr, not "de"');
  });

  it('asks the budget question in French', async () => {
    const io = fakeIo({ KPAI_CONFIRM_ABOVE_USD: '0', KPAI_LANG: 'fr' });
    expect(await main(['ask', '-m', 'mock/echo', 'pricey'], io)).toBe(4);
    expect(io.questions[0]).toMatch(/^Le coût prévu .* dépasse votre seuil .*\. Continuer \?$/);
  });

  it('prints the plan and total line in French; planner text stays as is', () => {
    setLocale('fr');
    const graph = {
      id: 'g',
      request: 'r',
      createdBy: 'template',
      reason: 'one node per step',
      nodes: [
        {
          id: 'a',
          title: 'A',
          type: 'code_generation',
          protocol: 'solo',
          criticality: 'normal',
          dependsOn: [],
          messages: [],
        },
      ],
    } as unknown as TaskGraph;
    const est = {
      nodes: [{ nodeId: 'a', protocol: 'solo', ref: null }],
      minUsd: 0.01,
      totalUsd: 0.02,
      expectedUsd: 0.02,
      capUsd: 0.05,
      complete: false,
      problems: ['a: no route'],
      band: { lowUsd: 0.01, highUsd: 0.05, basis: 'heuristic' },
    } as unknown as PlanEstimate;
    const out = renderGraphPlan(graph, est, money({}));
    expect(out).toMatch(/^plan {3}1 nœud\(s\) · template : one node per step$/m);
    expect(out).toContain('non routable (aucun candidat)');
    expect(out).toMatch(
      /^total {2}probable \$0\.02 · au plus \$0\.05 \(plafond\) avant exécution \(exécution impossible telle que prévue : a: no route\)$/m,
    );
  });
});
