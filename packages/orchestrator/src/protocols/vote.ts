import type { ModelRef, ProtocolResult } from '@kernelpai/core';
import { parseVote } from '../parse.js';
import { voterPrompt } from '../prompts.js';
import type { StepRunner } from '../step.js';
import { DEFAULT_VOTERS, type NodeRun } from '../types.js';
import { failure, finish } from './result.js';
import { structured } from './structured.js';

export interface Ballot {
  choice: string;
  /** Competence of the voter on this task type (measured when known, else static). */
  weight: number;
  ref: ModelRef;
}

export interface TallyRow {
  choice: string;
  weight: number;
  votes: number;
  /** Highest single-voter competence behind this choice (tie-break). */
  best: number;
}

const EPS = 1e-9;

/**
 * Competence-weighted majority. Ties on weight go to the choice backed by the most
 * competent single voter, then to the alphabetically first choice (deterministic).
 */
export function tally(ballots: readonly Ballot[]): TallyRow[] {
  const rows = new Map<string, TallyRow>();
  for (const b of ballots) {
    const row = rows.get(b.choice) ?? { choice: b.choice, weight: 0, votes: 0, best: 0 };
    row.weight += b.weight;
    row.votes += 1;
    row.best = Math.max(row.best, b.weight);
    rows.set(b.choice, row);
  }
  return [...rows.values()].sort(
    (a, b) =>
      (Math.abs(b.weight - a.weight) > EPS ? b.weight - a.weight : 0) ||
      (Math.abs(b.best - a.best) > EPS ? b.best - a.best : 0) ||
      a.choice.localeCompare(b.choice),
  );
}

/**
 * Vote (spec §3.1): up to `voters` (default 3) voters, each from a provider not used yet.
 * When no new provider is left, voting continues with fewer voters (journaled). A voter
 * that fails or answers unreadably is left out; cancellation stops the vote.
 */
export async function vote(s: StepRunner, run: NodeRun): Promise<ProtocolResult> {
  const wanted = s.o.voters ?? DEFAULT_VOTERS;
  const ballots: Ballot[] = [];
  const used: string[] = [];
  const prompt = voterPrompt(run.node, run.context);
  for (let i = 0; i < wanted; i++) {
    const r = await structured(
      s,
      run,
      { role: 'voter', prompt, exclude: [...used], diversity: 'strict' },
      parseVote,
    );
    if (!r.ok && r.diversity) {
      s.intervention(run.node.id, {
        action: 'diversity reduced',
        role: 'voter',
        reason: `only ${i} distinct provider(s) available for ${wanted} voters`,
      });
      break;
    }
    if (!r.ok) {
      if (r.cancelled || i === 0) return failure(run, 'vote', r);
      s.intervention(run.node.id, { action: 'voter left out', role: 'voter', reason: r.error });
      continue;
    }
    const parts = r.step.served.parts;
    ballots.push({
      choice: r.value,
      weight: parts.measuredCompetence ?? parts.staticCompetence,
      ref: r.step.ref,
    });
    used.push(r.step.ref.provider);
  }
  const [winner] = tally(ballots);
  if (!winner) return failure(run, 'vote', { error: 'no valid vote' });
  return finish(run, 'vote', winner.choice);
}
