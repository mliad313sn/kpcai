/**
 * Wording of the executive report v2 (S10 R4) and of its notices, in English and French.
 * Plain text first, the ask in the first sentence. Every function takes typed figures; the
 * only free text it receives is runtime- or model-written text that the caller marks quoted.
 */
import type { Locale } from './schemas.js';

export interface Counts {
  asks: number;
  budgetPct: number;
  alerts: number;
  changes: number;
}

export interface ExecText {
  sections: { asks: string; changes: string; forecast: string; risk: string; results: string };
  asksLead: (n: number) => string;
  ask: (question: string, silent: string) => string;
  amendment: string;
  silentNo: (deadline: string) => string;
  silentPaused: string;
  silentWaits: string;
  noAsks: string;
  noChanges: (since: string) => string;
  started: string;
  approved: string;
  runStarted: (wp: string, purpose: string, top: string) => string;
  runSettled: (wp: string, status: string, label: string, basis: string) => string;
  gateOpen: (phase: string) => string;
  /** `counted` undefined: no machine counted the findings, the Sponsor decided (P5-F6). */
  gateClosed: (phase: string, verdict: string, counted?: number) => string;
  status: (type: string, actor: string) => string;
  amend: (type: string) => string;
  decision: (actor: string, text: string) => string;
  asked: (rule: string) => string;
  answered: (id: string, answer: string) => string;
  alert: (rule: string, text: string) => string;
  fcCost: (low: string, high: string, wide: boolean) => string;
  fcNoHistory: (cap: string) => string;
  fcDate: (low: string, high: string, answers: boolean) => string;
  fcDone: string;
  fcRemaining: (runs: number, live: number) => string;
  riskAlert: (rule: string) => string;
  riskOverCap: (high: string, cap: string) => string;
  riskExpiry: (at: string) => string;
  riskUnverified: (n: number) => string;
  riskAsks: (n: number, hours: number) => string;
  noRisk: string;
  noResults: string;
  counts: (c: Counts) => string;
  noticeTitle: (programId: string, kind: string) => string;
  alertTitle: string;
  alertBody: (rules: string[]) => string;
  staleBody: (since: string) => string;
  testTitle: string;
  delivery: (verified: boolean) => string;
  testBody: string;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** French takes the singular for 0 and 1. */
const pluralFr = (n: number, one: string, many: string): string => `${n} ${n <= 1 ? one : many}`;

const en: ExecText = {
  sections: {
    asks: 'What needs your answer',
    changes: 'What changed',
    forecast: 'Forecast',
    risk: 'Top risk',
    results: 'Results and assurance (V0–V3)',
  },
  asksLead: (n) => (n ? `${plural(n, 'decision waits', 'decisions wait')} for you.` : ''),
  ask: (q, s) => `"${q}" (if you say nothing: ${s})`,
  amendment: 'a charter amendment waits for your approval',
  silentNo: (d) => `no at ${d}`,
  silentPaused: 'the program stays paused',
  silentWaits: 'the work package waits',
  noAsks: 'nothing waits for you',
  noChanges: (s) => `no change since ${s}`,
  started: 'the program started',
  approved: 'you approved the charter',
  runStarted: (wp, p, top) => `${wp}: ${p} run started (band top ${top})`,
  runSettled: (wp, st, l, b) => `${wp}: ${st}, ${l} (${b})`,
  gateOpen: (p) => `phase ${p} reached its gate`,
  gateClosed: (p, v, n) =>
    `gate ${p}: ${v} (${n === undefined ? 'the Sponsor decided, findings not counted by a machine' : `${n} open Critical/High`})`,
  status: (ty, a) => `${ty} by ${a}`,
  amend: (ty) => `charter ${ty}`,
  decision: (a, tx) => `decision by ${a}: "${tx}"`,
  asked: (r) => `new question for you (${r})`,
  answered: (id, a) => `you answered ${a} to ${id}`,
  alert: (r, tx) => `watchdog ${r}: ${tx}`,
  fcCost: (lo, hi, w) =>
    `spend at completion ${lo} to ${hi}${w ? ' (band range, little history)' : ' (80 % interval)'}`,
  fcNoHistory: (cap) => `no settled run yet: spend at completion at most the cap, ${cap}`,
  fcDate: (lo, hi, a) =>
    `finish between ${lo} and ${hi}${a ? '' : ', plus the time your answers take'}`,
  fcDone: 'no work left',
  fcRemaining: (n, l) => `${plural(n, 'run', 'runs')} to start, ${l} live`,
  riskAlert: (r) => `the watchdog reports ${r}`,
  riskOverCap: (hi, cap) =>
    `the forecast reaches ${hi}, above the cap ${cap}: work would stop at the cap`,
  riskExpiry: (at) => `the delegation envelope expires at ${at}`,
  riskUnverified: (n) =>
    `${plural(n, 'finished result is', 'finished results are')} below V2 (not verified)`,
  riskAsks: (n, h) => `${plural(n, 'question', 'questions')} open, the oldest for ${h} h`,
  noRisk: 'no risk recorded',
  noResults: 'no settled result yet',
  counts: (c) =>
    `${plural(c.asks, 'decision', 'decisions')} waiting, ${c.budgetPct} % of budget used, ${plural(c.alerts, 'alert', 'alerts')}, ${plural(c.changes, 'change', 'changes')}.`,
  noticeTitle: (id, k) => `${id}: ${k} report`,
  alertTitle: 'KP Studio: watchdog alert',
  alertBody: (rules) => `${plural(rules.length, 'alert', 'alerts')}: ${rules.join(', ')}.`,
  staleBody: (s) => `The KP Studio daemon has been silent since ${s}.`,
  testTitle: 'KP Studio: test notification',
  delivery: (v) => (v ? 'Delivered and verified.' : 'Delivered, not verified.'),
  testBody: 'This channel works. No project data is included.',
};

const fr: ExecText = {
  sections: {
    asks: 'Ce qui attend votre réponse',
    changes: 'Ce qui a changé',
    forecast: 'Prévision',
    risk: 'Risque principal',
    results: 'Résultats et niveau de vérification (V0–V3)',
  },
  asksLead: (n) => (n ? `${pluralFr(n, 'décision vous attend', 'décisions vous attendent')}.` : ''),
  ask: (q, s) => `« ${q} » (sans réponse : ${s})`,
  amendment: 'une modification de la charte attend votre approbation',
  silentNo: (d) => `non à ${d}`,
  silentPaused: 'le programme reste en pause',
  silentWaits: 'le lot de travail attend',
  noAsks: 'rien ne vous attend',
  noChanges: (s) => `aucun changement depuis ${s}`,
  started: 'le programme a démarré',
  approved: 'vous avez approuvé la charte',
  runStarted: (wp, p, top) => `${wp} : exécution ${p} démarrée (haut de fourchette ${top})`,
  runSettled: (wp, st, l, b) => `${wp} : ${st}, ${l} (${b})`,
  gateOpen: (p) => `la phase ${p} est à sa porte`,
  gateClosed: (p, v, n) =>
    `porte ${p} : ${v} (${n === undefined ? 'décision du Sponsor, constats non comptés par une machine' : `${n} Critique/Élevé ouverts`})`,
  status: (ty, a) => `${ty} par ${a}`,
  amend: (ty) => `charte : ${ty}`,
  decision: (a, tx) => `décision de ${a} : « ${tx} »`,
  asked: (r) => `nouvelle question pour vous (${r})`,
  answered: (id, a) => `vous avez répondu ${a} à ${id}`,
  alert: (r, tx) => `surveillance ${r} : ${tx}`,
  fcCost: (lo, hi, w) =>
    `dépense finale de ${lo} à ${hi}${w ? ' (fourchette observée, peu d’historique)' : ' (intervalle à 80 %)'}`,
  fcNoHistory: (cap) => `aucune exécution terminée : dépense finale au plus le plafond, ${cap}`,
  fcDate: (lo, hi, a) =>
    `fin entre le ${lo} et le ${hi}${a ? '' : ', plus le temps de vos réponses'}`,
  fcDone: 'plus aucun travail',
  fcRemaining: (n, l) => `${pluralFr(n, 'exécution', 'exécutions')} à lancer, ${l} en cours`,
  riskAlert: (r) => `la surveillance signale ${r}`,
  riskOverCap: (hi, cap) =>
    `la prévision atteint ${hi}, au-dessus du plafond ${cap} : le travail s’arrêterait au plafond`,
  riskExpiry: (at) => `l’enveloppe de délégation expire le ${at}`,
  riskUnverified: (n) =>
    `${pluralFr(n, 'résultat terminé est', 'résultats terminés sont')} sous V2 (non vérifiés)`,
  riskAsks: (n, h) =>
    `${pluralFr(n, 'question ouverte', 'questions ouvertes')}, la plus ancienne depuis ${h} h`,
  noRisk: 'aucun risque relevé',
  noResults: 'aucun résultat terminé',
  counts: (c) =>
    `${pluralFr(c.asks, 'décision', 'décisions')} en attente, ${c.budgetPct} % du budget utilisé, ${pluralFr(c.alerts, 'alerte', 'alertes')}, ${pluralFr(c.changes, 'changement', 'changements')}.`,
  noticeTitle: (id, k) => `${id} : rapport ${k}`,
  alertTitle: 'KP Studio : alerte de surveillance',
  alertBody: (rules) => `${pluralFr(rules.length, 'alerte', 'alertes')} : ${rules.join(', ')}.`,
  staleBody: (s) => `Le démon KP Studio est silencieux depuis ${s}.`,
  testTitle: 'KP Studio : notification de test',
  delivery: (v) => (v ? 'Livré et vérifié.' : 'Livré, non vérifié.'),
  testBody: 'Ce canal fonctionne. Aucune donnée de projet n’est incluse.',
};

export function execText(locale: Locale): ExecText {
  return locale === 'fr' ? fr : en;
}
