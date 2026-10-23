/**
 * Message catalogue (WI-S6-02): every user-facing string of KP Studio (web and terminal)
 * by key, in English and French. A message is a whole sentence with named `{params}`; a
 * plural message picks its form with `Intl.PluralRules` from `count`. Sentences are never
 * built by concatenating pieces. Model output and kernel data are never translated.
 */
import { en } from './en';
import { fr } from './fr';

export type Plural = { one: string; other: string };
export type Message = string | Plural;
export type Key = keyof typeof en;
export type Catalogue = Record<Key, Message>;
export type Locale = 'en' | 'fr';
export type LocalePref = 'system' | Locale;
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
  return /^fr\b|^fr[-_]/i.test(tag?.trim() ?? '') ? 'fr' : 'en';
}

/** The browser's (or the OS's, in a terminal) preferred language. */
export function systemLocale(): Locale {
  const nav = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } })
    .navigator;
  if (nav?.languages?.length || nav?.language)
    return localeFrom(nav.languages?.[0] ?? nav.language);
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return localeFrom(env?.['LC_ALL'] || env?.['LC_MESSAGES'] || env?.['LANG']);
}

export function resolveLocale(pref: LocalePref): Locale {
  return pref === 'system' ? systemLocale() : pref;
}

function pick(m: Message, locale: Locale, params: Params | undefined): string {
  if (typeof m === 'string') return m;
  const n = Number(params?.['count'] ?? 0);
  return new Intl.PluralRules(locale).select(n) === 'one' ? m.one : m.other;
}

/** The message for `key` in the current locale (English if missing), params filled in. */
export function t(key: Key, params?: Params): string {
  const m = CATALOGUES[current][key] ?? en[key];
  const text = pick(m, current, params);
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (all, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : all,
  );
}

/** Placeholder names of a message (all plural forms), for the catalogue test. */
export function placeholders(m: Message): string[] {
  const forms = typeof m === 'string' ? [m] : [m.one, m.other];
  return [...new Set(forms.flatMap((f) => [...f.matchAll(/\{(\w+)\}/g)].map((x) => x[1]!)))].sort();
}
