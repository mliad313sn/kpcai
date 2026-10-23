import { formatUsd, refToString, type ScoredCandidate } from '@kernelpai/core';
import type { Contributions } from './score.js';

const LABELS: Record<keyof Contributions, string> = {
  competence: 'static competence',
  measured: 'measured competence',
  cost: 'cost',
  latency: 'latency',
};

/** The factor whose weighted difference most favours the winner over the runner-up. */
export function decisiveFactor(win: Contributions, next: Contributions): keyof Contributions {
  let best: keyof Contributions = 'competence';
  let gap = -Infinity;
  for (const k of Object.keys(LABELS) as (keyof Contributions)[]) {
    const d = win[k] - next[k];
    if (d > gap) {
      gap = d;
      best = k;
    }
  }
  return best;
}

/** Scores closer than this are a tie. */
export const SCORE_EPSILON = 1e-9;

const f3 = (x: number): string => x.toFixed(3);

/**
 * One-line justification (principle 1), e.g.
 * `openai/gpt-x for code_generation: score 0.712, ~$0.0042; beats mistral/large (0.655) on cost (+0.061); 3 rejected`
 */
export function explain(args: {
  type: string;
  chosen: ScoredCandidate;
  chosenParts: Contributions;
  runnerUp?: { scored: ScoredCandidate; parts: Contributions } | undefined;
  rejected: number;
}): string {
  const { chosen, runnerUp } = args;
  const head = `${refToString(chosen.ref)} for ${args.type}: score ${f3(chosen.score)}, ~${formatUsd(chosen.estimate.expectedCostUsd)}`;
  let tail: string;
  if (!runnerUp) {
    tail = 'only candidate left after filters';
  } else {
    const vs = `${refToString(runnerUp.scored.ref)} (${f3(runnerUp.scored.score)})`;
    const k = decisiveFactor(args.chosenParts, runnerUp.parts);
    const d = args.chosenParts[k] - runnerUp.parts[k];
    tail =
      chosen.score - runnerUp.scored.score > SCORE_EPSILON
        ? `beats ${vs} on ${LABELS[k]} (+${f3(d)})`
        : `ties ${vs}, kept by tie-break (cheaper, then name)`;
  }
  return `${head}; ${tail}; ${args.rejected} rejected`;
}
