import { refToString, type ModelRef, type ProtocolResult } from '@kernelpai/core';
import { disputed, type Dispute } from '../dispute.js';
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
 * that fails or answers unreadably is left out; cancellation stops the vote. Without a
 * clear majority the node is disputed (R-405): the human picks, nothing is picked silently.
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
  const rows = tally(ballots);
  const [winner] = rows;
  if (!winner) return failure(run, 'vote', { error: 'no valid vote' });
  if (!hasMajority(winner, rows, ballots.length)) {
    return disputed(run, 'vote', voteDispute(rows, ballots));
  }
  return finish(run, 'vote', winner.choice);
}

/**
 * A clear majority (R-405): the leading choice has more than half of the ballots and more
 * than half of the competence weight. Weights rank the choices but never turn a split
 * (1–1–1, 1–1, or a 2–1 outweighed by one stronger voter) into a decision.
 */
export function hasMajority(winner: TallyRow, rows: readonly TallyRow[], ballots: number): boolean {
  const weight = rows.reduce((a, r) => a + r.weight, 0);
  return winner.votes * 2 > ballots && winner.weight * 2 > weight + EPS;
}

function voteDispute(rows: readonly TallyRow[], ballots: readonly Ballot[]): Dispute {
  const options = rows.map((row, i) => ({
    id: `choice-${i + 1}`,
    label: `${row.choice} (${row.votes} vote${row.votes === 1 ? '' : 's'})`,
    text: row.choice,
    backers: ballots.filter((b) => b.choice === row.choice).map((b) => b.ref),
  }));
  const split = rows.map((r) => r.votes).join('–');
  return {
    kind: 'vote',
    reason: `no majority among ${ballots.length} voters (${split})`,
    options,
    positions: ballots.map((b) => ({
      ref: b.ref,
      role: 'voter' as const,
      says: `${refToString(b.ref)} votes ${b.choice}`,
      option: options.find((o) => o.text === b.choice)?.id ?? '',
    })),
  };
}
