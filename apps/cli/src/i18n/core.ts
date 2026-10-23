/**
 * The CLI's message catalogue (WI-S6-02): English and French, picked by `--lang`, then
 * `KPAI_LANG`, then the POSIX locale (`LC_ALL`, `LC_MESSAGES`, `LANG`); `fr*` is French.
 * Messages are whole sentences with named `{params}`, never assembled from pieces. Model
 * output, kernel questions and journal text are passed through as data, untranslated.
 */
import { en } from './en.js';
import { fr } from './fr.js';

export type Key = keyof typeof en;
export type Catalogue = Record<Key, string>;
export type Locale = 'en' | 'fr';
export type Params = Record<string, string | number>;

export const LOCALES: readonly Locale[] = ['en', 'fr'];
export const CATALOGUES: Record<Locale, Catalogue> = { en, fr };

let current: Locale = 'en';

export function getLocale(): Locale {
  return current;
}

export function setLocale(locale: Locale): void {
  current = locale;
}

/** `fr`, `fr-CA`, `fr_FR.UTF-8` → fr; anything else → en. */
export function localeFrom(tag: string | undefined): Locale {
  return /^fr(?:$|[-_.@])/i.test(tag?.trim() ?? '') ? 'fr' : 'en';
}

/** `--lang` wins, then `KPAI_LANG`, then the first set POSIX locale variable. */
export function cliLocale(env: Record<string, string | undefined>, flag?: string): Locale {
  const pick = (v: string | undefined) => (v && v.trim() ? v : undefined);
  return localeFrom(
    pick(flag) ??
      pick(env['KPAI_LANG']) ??
      pick(env['LC_ALL']) ??
      pick(env['LC_MESSAGES']) ??
      pick(env['LANG']),
  );
}

/** The message for `key` in the current locale, `{params}` filled in. */
export function t(key: Key, params?: Params): string {
  const text = CATALOGUES[current][key];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : all,
  );
}

/** True for an answer that means yes in the current locale (`y`, `yes`; `o`, `oui`). */
export function isYes(answer: string): boolean {
  const words = t('confirm.yesWords')
    .split(',')
    .map((w) => w.trim().toLowerCase());
  return words.includes(answer.trim().toLowerCase());
}

/** Placeholder names of a message, for the catalogue test. */
export function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!))].sort();
}
