import type { Classification, TaskType } from '@kernelpai/core';

/**
 * Transparent keyword heuristic over the seven task types (spec §3.1), English + French.
 *
 * Rules:
 * 1. The prompt is lower-cased and accents are stripped ("rédige" → "redige"), so every
 *    pattern below is plain ASCII.
 * 2. Each pattern that matches adds its weight (1, or 2 for strong signals such as a
 *    code fence) to its task type. A pattern counts once however often it matches.
 * 3. The highest score wins. Ties go to the more specific type, in PRIORITY order
 *    (test > critique > code_generation > decision > research > writing > analysis):
 *    "write tests for this function" is a test task, "review this code" a critique.
 * 4. confidence = clamp(0.4 + 0.2·top − 0.15·runnerUp, 0.3, 0.95).
 * 5. Nothing matches → `analysis` with confidence 0.2 (the safest generalist type).
 * The reason names the matched keywords and the runner-up.
 */
interface Rule {
  type: TaskType;
  pattern: RegExp;
  label: string;
  weight?: number;
}

export const PRIORITY: readonly TaskType[] = [
  'test',
  'critique',
  'code_generation',
  'decision',
  'research',
  'writing',
  'analysis',
];

const CODE_NOUNS_EN = 'function|class|script|program|module|endpoint|api|component|query|method';
const CODE_NOUNS_FR = 'fonction|classe|script|programme|module|composant|requete|methode';
const PROSE_EN = 'e-?mail|letter|article|blog|post|essay|story|announcement|newsletter|speech';
const PROSE_FR = 'e-?mail|courriel|lettre|article|billet|essai|histoire|discours|annonce';

const r = (type: TaskType, label: string, pattern: RegExp, weight = 1): Rule => ({
  type,
  label,
  pattern,
  weight,
});

export const RULES: readonly Rule[] = [
  // test
  r('test', 'tests', /\b(unit |integration |e2e )?tests?\b/),
  r('test', 'test framework', /\b(vitest|jest|pytest|mocha|junit|playwright)\b/),
  r('test', 'coverage', /\b(coverage|couverture)\b/),
  r('test', 'tests (fr)', /\b(tests? unitaires?|cas de test|teste[rz]?)\b/),
  // critique
  r('critique', 'review', /\b(review|critique|critici[sz]e|proofread|feedback)\b/),
  r('critique', "what's wrong", /\b(what'?s wrong|weaknesses|flaws|issues with)\b/),
  r('critique', 'relis (fr)', /\b(relis|relire|relecture|revue|avis sur|points faibles|defauts)\b/),
  // code_generation
  r('code_generation', 'code fence', /```/, 2),
  r(
    'code_generation',
    'write code',
    new RegExp(`\\b(write|create|implement|generate|build)\\b.{0,30}\\b(${CODE_NOUNS_EN})s?\\b`),
  ),
  r(
    'code_generation',
    'ecris du code (fr)',
    new RegExp(
      `\\b(ecris|ecrire|cree|creer|implemente[rz]?|genere[rz]?)\\b.{0,30}\\b(${CODE_NOUNS_FR})s?\\b`,
    ),
  ),
  r(
    'code_generation',
    'refactor / fix',
    /\b(refactor\w*|fix (the |this |a )?bug|debug|corrige[rz]? (le |ce |un )?bug|implement\w*)\b/,
  ),
  r(
    'code_generation',
    'language',
    /\b(typescript|javascript|python|rust|golang|java|sql|regex|bash|code)\b/,
  ),
  // decision
  r('decision', 'should we', /\b(should (i|we)|which (one|is better))\b/),
  r('decision', 'trade-offs', /\b(pros and cons|trade-?offs?|versus|vs)\b/),
  r('decision', 'choose', /\b(choose|pick|decide|recommend)\b/),
  r('decision', 'faut-il (fr)', /\b(dois-je|devrions-nous|faut-il|lequel|laquelle)\b/),
  r('decision', 'compromis (fr)', /\b(avantages et inconvenients|compromis)\b/),
  r('decision', 'choisir (fr)', /\b(choisir|decider|recommandes?)\b/),
  // research
  r(
    'research',
    'research',
    /\b(research|look up|find (sources|papers|references)|state of the art|latest|citations?)\b/,
  ),
  r(
    'research',
    'recherche (fr)',
    /\b(recherche[rz]?|trouve[rz]? (des )?(sources|articles|references)|etat de l'art|dernieres?)\b/,
  ),
  r('research', 'sources', /\b(sources|papers|bibliograph\w*)\b/),
  // writing
  r(
    'writing',
    'write prose',
    new RegExp(`\\b(write|draft|compose)\\b.{0,30}\\b(${PROSE_EN})s?\\b`),
  ),
  r(
    'writing',
    'ecris un texte (fr)',
    new RegExp(`\\b(ecris|ecrire|redige[rz]?)\\b.{0,30}\\b(${PROSE_FR})s?\\b`),
  ),
  r(
    'writing',
    'rewrite',
    /\b(rewrite|rephrase|reword|translate|draft|redige[rz]?|reformule[rz]?|tradui[st]|traduire)\b/,
  ),
  // analysis
  r('analysis', 'analyse', /\b(analy[sz]e|analysis|explain|why|summari[sz]e|understand|assess)\b/),
  r(
    'analysis',
    'analyse (fr)',
    /\b(analyse[rz]?|explique[rz]?|pourquoi|resume[rz]?|comprendre|evalue[rz]?)\b/,
  ),
];

function normalise(prompt: string): string {
  return prompt.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function score(text: string): Map<TaskType, { score: number; labels: string[] }> {
  const scores = new Map<TaskType, { score: number; labels: string[] }>();
  for (const rule of RULES) {
    if (!rule.pattern.test(text)) continue;
    const s = scores.get(rule.type) ?? { score: 0, labels: [] };
    s.score += rule.weight ?? 1;
    s.labels.push(rule.label);
    scores.set(rule.type, s);
  }
  return scores;
}

export function classify(prompt: string): Classification {
  const scores = score(normalise(prompt));
  const ranked = [...scores.entries()].sort(
    ([a, sa], [b, sb]) => sb.score - sa.score || PRIORITY.indexOf(a) - PRIORITY.indexOf(b),
  );
  const [top, second] = ranked;
  if (!top) {
    return { type: 'analysis', confidence: 0.2, reason: 'no keyword matched; default analysis' };
  }
  const [type, { score: best, labels }] = top;
  const runnerUp = second?.[1].score ?? 0;
  const confidence = Math.min(0.95, Math.max(0.3, 0.4 + 0.2 * best - 0.15 * runnerUp));
  const tail = second ? ` (runner-up ${second[0]}: ${runnerUp})` : '';
  return {
    type,
    confidence: Math.round(confidence * 100) / 100,
    reason: `${type}: matched ${labels.join(', ')}${tail}`,
  };
}
