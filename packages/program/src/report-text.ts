/** Report wording in English and French (executive style: short, figures first). */
import type { Locale, ProgramStatus } from './schemas.js';

export interface ReportText {
  title: (kind: string, programId: string) => string;
  status: Record<ProgramStatus, string>;
  phase: (n: number, of: number, title: string) => string;
  delivered: string;
  notVerified: (why: string) => string;
  sections: {
    progress: string;
    evidence: string;
    budget: string;
    gates: string;
    decisions: string;
    waiting: string;
    risks: string;
  };
  ciOk: (commit: string) => string;
  ciMissing: (commit: string) => string;
  ciOther: (commit: string, status: string) => string;
  tests: (passed: number, failed: number) => string;
  noTests: string;
  budgetLine: (spent: string, committed: string, cap: string, pct: number) => string;
  phaseBudget: (id: string, committed: string, cap: string) => string;
  bySource: (api: string, localHours: number) => string;
  subscription: (agent: string, runs: number, quota: string, hours: number) => string;
  gate: (phase: string, verdict: string, reviewer: string) => string;
  noGates: string;
  decision: (actor: string, text: string) => string;
  noDecisions: string;
  escalation: (question: string) => string;
  noWaiting: string;
  noRisks: string;
  wps: (done: number, total: number) => string;
  link: string;
}

const en: ReportText = {
  title: (k, id) => `${id}: ${k} report`,
  status: {
    draft: 'Charter in draft',
    proposed: 'Charter waiting for your approval',
    approved: 'Approved, not started',
    running: 'Running',
    gate: 'At a gate (independent review)',
    paused: 'Paused',
    stopped: 'Stopped',
    delivered: 'Delivered',
  },
  phase: (n, of, t) => `Phase ${n}/${of}: ${t}`,
  delivered: 'Delivered, every claim below backed by journal evidence',
  notVerified: (why) => `Not verified: ${why}`,
  sections: {
    progress: 'Progress',
    evidence: 'Evidence',
    budget: 'Budget against the envelope',
    gates: 'Gates',
    decisions: 'Decisions taken',
    waiting: 'Decisions waiting for you',
    risks: 'Risks',
  },
  ciOk: (c) => `CI green for ${c}`,
  ciMissing: (c) => `no CI result for ${c}`,
  ciOther: (c, s) => `CI ${s} for ${c}`,
  tests: (p, f) => `tests: ${p} passed, ${f} failed`,
  noTests: 'no test evidence in the journal',
  budgetLine: (s, c, cap, pct) => `spent ${s}, committed ${c} of ${cap} (${pct} %)`,
  phaseBudget: (id, c, cap) => `${id}: ${c} of ${cap}`,
  bySource: (api, h) => `by source: API ${api}, local compute ${h.toFixed(1)} h`,
  subscription: (a, r, q, h) => `subscription ${a}: ${r} runs of ${q}, ${h.toFixed(1)} h`,
  gate: (p, v, r) => `${p}: ${v} (reviewer ${r})`,
  noGates: 'no gate closed yet',
  decision: (a, t) => `${a}: "${t}"`,
  noDecisions: 'none',
  escalation: (q) => `"${q}"`,
  noWaiting: 'nothing waits for you',
  noRisks: 'none recorded',
  wps: (d, t) => `${d} of ${t} work packages finished in this phase`,
  link: 'Details: open kpai studio on the machine running the program',
};

const fr: ReportText = {
  title: (k, id) => `${id} : rapport ${k}`,
  status: {
    draft: 'Charte en brouillon',
    proposed: 'Charte en attente de votre approbation',
    approved: 'Approuvé, pas démarré',
    running: 'En cours',
    gate: 'À une porte de phase (revue indépendante)',
    paused: 'En pause',
    stopped: 'Arrêté',
    delivered: 'Livré',
  },
  phase: (n, of, t) => `Phase ${n}/${of} : ${t}`,
  delivered: 'Livré, chaque affirmation ci-dessous appuyée sur le journal',
  notVerified: (why) => `Non vérifié : ${why}`,
  sections: {
    progress: 'Avancement',
    evidence: 'Preuves',
    budget: "Budget par rapport à l'enveloppe",
    gates: 'Portes de phase',
    decisions: 'Décisions prises',
    waiting: 'Décisions qui vous attendent',
    risks: 'Risques',
  },
  ciOk: (c) => `CI verte pour ${c}`,
  ciMissing: (c) => `aucun résultat de CI pour ${c}`,
  ciOther: (c, s) => `CI ${s} pour ${c}`,
  tests: (p, f) => `tests : ${p} réussis, ${f} en échec`,
  noTests: 'aucune preuve de test dans le journal',
  budgetLine: (s, c, cap, pct) => `dépensé ${s}, engagé ${c} sur ${cap} (${pct} %)`,
  phaseBudget: (id, c, cap) => `${id} : ${c} sur ${cap}`,
  bySource: (api, h) => `par source : API ${api}, calcul local ${h.toFixed(1)} h`,
  subscription: (a, r, q, h) => `abonnement ${a} : ${r} exécutions sur ${q}, ${h.toFixed(1)} h`,
  gate: (p, v, r) => `${p} : ${v} (relecteur ${r})`,
  noGates: 'aucune porte franchie pour le moment',
  decision: (a, t) => `${a} : « ${t} »`,
  noDecisions: 'aucune',
  escalation: (q) => `« ${q} »`,
  noWaiting: 'rien ne vous attend',
  noRisks: 'aucun relevé',
  wps: (d, t) => `${d} lots de travail terminés sur ${t} dans cette phase`,
  link: 'Détails : ouvrez kpai studio sur la machine qui exécute le programme',
};

export function reportText(locale: Locale): ReportText {
  return locale === 'fr' ? fr : en;
}
