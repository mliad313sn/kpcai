/**
 * Messages of `kpai stats --north-star` (S10, docs/metrics/NORTH-STAR.md), English and
 * French, spread into the main catalogues. States are words, never colour alone.
 */
export const nsEn = {
  'ns.header':
    'north star here: Durable Verified Outcomes (from the journal only; see docs/metrics/NORTH-STAR.md)',
  'ns.since': '  outcomes since {since}',
  'ns.counts':
    '  {dvo} DVO (code, ≥ V2) · {doc} DVO-doc (documents, ≥ V1) · {provisional} still provisional · {intents} intent(s)',
  'ns.mix': '  assurance V1 {v1} · V2 {v2} · V3 {v3} (V3 share {share}) · durability: {durability}',
  'ns.week': '  week {week}: {dvo} DVO · {doc} DVO-doc ({state})',
  'ns.final': 'final',
  'ns.provisional': 'provisional',
  'ns.guardrails': 'guardrails',
  'ns.g1':
    '  G1 cost per DVO {cost} · billed cost in band {band} · band top ÷ likely (median) {cap}',
  'ns.g2':
    '  G2 {asks} question(s), {perDvo} per DVO · median answer time {age} · rubber-stamped {stamped}/{consequential} ({rate})',
  'ns.g3':
    '  G3 silent runs {silent}/{started} ({rate}) · alerts without a report {unfollowed} · heartbeat gaps {gaps}',
  'ns.g4': '  G4 escapes {escaped}/{accepted} ({rate}) · at V1 {v1} · at V2 {v2}',
  'ns.g5': '  G5 safety invariants: {total} ({state})',
  'ns.g6': '  G6 energy per DVO: {energy}',
  'ns.ok': 'ok',
  'ns.breach': 'BREACHED',
  'ns.notMeasured': 'not measured',
  'ns.breached': '  breached: {list}',
  'ns.noBreach': '  no guardrail breached',
  'ns.gap': '  not measured: {item}',
  'error.northStarInvalid': 'kpai stats --north-star: {message}',
} as const;

export const nsFr: Record<keyof typeof nsEn, string> = {
  'ns.header':
    'étoile polaire ici : résultats vérifiés et durables (d’après le journal seul ; voir docs/metrics/NORTH-STAR.md)',
  'ns.since': '  résultats depuis {since}',
  'ns.counts':
    '  {dvo} DVO (code, ≥ V2) · {doc} DVO-doc (documents, ≥ V1) · {provisional} encore provisoire(s) · {intents} intention(s)',
  'ns.mix': '  assurance V1 {v1} · V2 {v2} · V3 {v3} (part V3 {share}) · durabilité : {durability}',
  'ns.week': '  semaine {week} : {dvo} DVO · {doc} DVO-doc ({state})',
  'ns.final': 'définitif',
  'ns.provisional': 'provisoire',
  'ns.guardrails': 'garde-fous',
  'ns.g1':
    '  G1 coût par DVO {cost} · coût facturé dans la fourchette {band} · plafond ÷ probable (médiane) {cap}',
  'ns.g2':
    '  G2 {asks} question(s), {perDvo} par DVO · délai médian de réponse {age} · validées sans examen {stamped}/{consequential} ({rate})',
  'ns.g3':
    '  G3 exécutions silencieuses {silent}/{started} ({rate}) · alertes sans rapport {unfollowed} · trous de battement {gaps}',
  'ns.g4': '  G4 échappements {escaped}/{accepted} ({rate}) · en V1 {v1} · en V2 {v2}',
  'ns.g5': '  G5 invariants de sûreté : {total} ({state})',
  'ns.g6': '  G6 énergie par DVO : {energy}',
  'ns.ok': 'ok',
  'ns.breach': 'DÉPASSÉ',
  'ns.notMeasured': 'non mesuré',
  'ns.breached': '  dépassés : {list}',
  'ns.noBreach': '  aucun garde-fou dépassé',
  'ns.gap': '  non mesuré : {item}',
  'error.northStarInvalid': 'kpai stats --north-star : {message}',
};
