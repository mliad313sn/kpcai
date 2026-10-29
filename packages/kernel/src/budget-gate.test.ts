/** Caps always reach a person: the graph cap and a node's own budgetUsd (P2-F9, P3-F5). */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScoredCandidate } from '@kernelpai/core';
import { Journal } from '@kernelpai/journal';
import { describe, expect, it } from 'vitest';
import { BudgetGate } from './budget-gate.js';
import type { ConfirmRequest } from './confirm.js';

const NODE_LABEL = 'node implementation total: up to $0.40 would exceed budgetUsd $0.10 (author)';
const CANDIDATE = {
  ref: { provider: 'mock-beta', model: 'm1' },
  estimate: { expectedCostUsd: 0.001 },
} as unknown as ScoredCandidate;

function gate(answer: boolean | undefined, flags: { overBudget?: boolean; yes?: boolean } = {}) {
  const journal = Journal.open(join(mkdtempSync(join(tmpdir(), 'kpai-gate-')), 'j.db'));
  const asked: ConfirmRequest[] = [];
  const said: string[] = [];
  const host = {
    // Generous limits: the governor alone would let the call through silently.
    env: { KPAI_CONFIRM_ABOVE_USD: '100' },
    cwd: '/work',
    say: (t: string) => void said.push(t),
    confirm: (q: ConfirmRequest) => (asked.push(q), Promise.resolve(answer === true)),
  };
  const sessionId = journal.startSession('t', '/work');
  const m = { currency: 'USD', rate: 1 } as never;
  const g = new BudgetGate(host, journal, { sessionId, nodeId: 'g', m, runId: 'r1' }, flags);
  return { g, asked, said, journal };
}

describe('BudgetGate caps', () => {
  it('always asks a person when a node would exceed its budgetUsd; no answer is no', async () => {
    const no = gate(undefined);
    expect(await no.g.allow(CANDIDATE, NODE_LABEL)).toBe(false);
    expect(no.asked).toEqual([
      expect.objectContaining({
        kind: 'budget',
        runId: 'r1',
        question: expect.stringMatching(/node implementation total/),
      }),
    ]);
    const yes = gate(true, { yes: true });
    expect(await yes.g.allow(CANDIDATE, NODE_LABEL)).toBe(true);
    expect(yes.asked).toHaveLength(1); // `yes` accepts cost prompts, never a cap
    no.journal.close();
    yes.journal.close();
  });

  it('says a cap question is over-cap, with no amount, so no program batches it (D-035)', async () => {
    const g = gate(undefined);
    await g.g.allow(CANDIDATE, 'graph total $9.50 > cap $1.00');
    await g.g.allow(CANDIDATE, NODE_LABEL);
    expect(g.asked.map((q) => [q.overCap, q.amountUsd])).toEqual([
      [true, undefined],
      [true, undefined],
    ]);
    g.journal.close();
  });

  it('recognises a node cap whatever the id looks like (NF-1)', async () => {
    const spaced = gate(undefined);
    const label = 'node my node total: up to $0.40 would exceed budgetUsd $0.10 (author)';
    expect(await spaced.g.allow(CANDIDATE, label)).toBe(false);
    expect(spaced.asked).toHaveLength(1);
    spaced.journal.close();
  });

  it('honours an over-budget waiver without asking (CLI only), journaled', async () => {
    const over = gate(false, { overBudget: true });
    expect(await over.g.allow(CANDIDATE, NODE_LABEL)).toBe(true);
    expect(over.asked).toEqual([]);
    const actions = over.journal.events().map((e) => e.payload.action);
    expect(actions).toEqual([`accepted: ${NODE_LABEL}`]);
    over.journal.close();
  });
});
