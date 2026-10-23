/**
 * Enterprise wording shared by the web view and the terminal: ages, hours, liveness and
 * assurance labels, whole sentences from the catalogue.
 */
import { getLocale, t, type Key } from '../i18n/core';
import type { HeartbeatStatus, Liveness } from './derive';
import type { Assurance } from './schemas';

/** "3 h 10 min", from milliseconds (whole seconds under a minute). */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return t('ent.age.s', { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t('ent.age.m', { n: m });
  const h = Math.floor(m / 60);
  if (h < 48) return t('ent.age.h', { h, m: m % 60 });
  return t('ent.age.d', { n: Math.floor(h / 24) });
}

export function formatHours(h: number): string {
  const n = new Intl.NumberFormat(getLocale() === 'fr' ? 'fr-FR' : 'en-US', {
    maximumFractionDigits: 1,
  }).format(h);
  return t('ent.hours', { n });
}

export const LIVENESS_KEY: Record<Liveness, Key> = {
  ok: 'ent.beat.ok',
  late: 'ent.beat.late',
  alert: 'ent.beat.alert',
  stale: 'ent.beat.stale',
  unknown: 'ent.beat.unknown',
  offline: 'ent.beat.offline',
};

export function livenessText(s: HeartbeatStatus): string {
  const age = s.ageMs === undefined ? '—' : formatAge(s.ageMs);
  return t(LIVENESS_KEY[s.level], { age });
}

export const ASSURANCE_KEY: Record<Assurance, Key> = {
  V0: 'ent.assurance.V0',
  V1: 'ent.assurance.V1',
  V2: 'ent.assurance.V2',
  V3: 'ent.assurance.V3',
};
