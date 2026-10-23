import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n/core';
import {
  ReplayViewSchema,
  parseDisputeRecords,
  parseReused,
  parseVerification,
} from '../rpc/learning-schemas';
import { MEMORY_SUMMARY, REPLAY } from '../test-helpers/learn-fixtures';
import { applyDisputeControl, applyDisputeRecords, isDisputed } from './disputes';
import { formatPct } from './format';
import { newRun } from './reducer';
import { memoryLines, verificationText } from './summaries';
import type { MemorySummary } from './types';

afterEach(() => setLocale('en'));

const VERIFICATION = {
  reviewUsd: 0.02,
  totalUsd: 0.08,
  share: 0.25,
  issuesRaised: 3,
  acceptedFindings: 2,
  acceptedRevisions: 1,
  usdPerAcceptedFinding: 0.01,
  nodes: [],
};

describe('disputes (R-405)', () => {
  it('marks a node disputed, then names the chosen option', () => {
    let r = newRun('r1', 'q', 0);
    expect(isDisputed(r, 'n')).toBe(false);
    r = applyDisputeControl(r, {
      type: 'node_disputed',
      nodeId: 'n',
      reason: 'no majority',
      options: [{ id: 'choice-1', label: 'redis (1 vote)' }, { bad: true }],
    } as never);
    expect(isDisputed(r, 'n')).toBe(true);
    expect(r.disputes?.n?.options).toEqual([{ id: 'choice-1', label: 'redis (1 vote)' }]);
    const chosen = applyDisputeControl(r, {
      type: 'dispute_resolved',
      nodeId: 'n',
      choice: 'choice-1',
    } as never);
    expect(chosen.disputes?.n).toMatchObject({ status: 'chosen', choice: 'redis (1 vote)' });
    const rejected = applyDisputeControl(r, {
      type: 'dispute_resolved',
      nodeId: 'n',
      choice: null,
    } as never);
    expect(rejected.disputes?.n?.status).toBe('rejected');
    expect(isDisputed(rejected, 'n')).toBe(false);
    // Other control events and events without a node leave the run alone.
    expect(applyDisputeControl(r, { type: 'run_paused' })).toBe(r);
    expect(applyDisputeControl(r, { type: 'node_disputed' })).toBe(r);
  });

  it('folds the run result records: chosen label, or rejected (fail closed)', () => {
    const records = parseDisputeRecords({
      disputes: {
        a: {
          kind: 'vote',
          reason: 'tie',
          options: [{ id: 'x', label: 'X' }],
          choice: 'x',
          by: 'human',
        },
        b: { kind: 'critics', reason: 'split', options: [], choice: null, by: 'none' },
        c: { nope: 1 },
      },
    });
    expect(Object.keys(records)).toEqual(['a', 'b']);
    const r = applyDisputeRecords(newRun('r', 'q', 0), records);
    expect(r.disputes?.a).toMatchObject({ status: 'chosen', choice: 'X', reason: 'tie' });
    expect(r.disputes?.b).toMatchObject({ status: 'rejected', reason: 'split' });
    const same = newRun('r', 'q', 0);
    expect(applyDisputeRecords(same, {})).toBe(same);
    expect(parseDisputeRecords(null)).toEqual({});
    expect(parseDisputeRecords({ disputes: [] })).toEqual({});
  });
});

describe('phase 4 shapes read leniently', () => {
  it('reads verification, reused nodes and replay attempts', () => {
    expect(parseVerification(VERIFICATION)).toMatchObject({ share: 0.25 });
    expect(parseVerification({ reviewUsd: 'x' })).toBeUndefined();
    expect(parseVerification(undefined)).toBeUndefined();
    expect(parseReused({ reused: ['a', 1, 'b'] })).toEqual(['a', 'b']);
    expect(parseReused({})).toEqual([]);
    const r = ReplayViewSchema.parse({
      ...REPLAY,
      original: { ...REPLAY.original, verdicts: 'bad' },
    });
    expect(r.original.verdicts).toEqual([]);
    expect(r.replay.verdicts).toHaveLength(1);
  });
});

describe('summaries shared by web and terminal', () => {
  it('says what memory a plan sends, in English and French', () => {
    const lines = memoryLines(MEMORY_SUMMARY as unknown as MemorySummary);
    expect(lines.map((l) => l.text)).toEqual([
      'Memory: 2 facts sent to every node (user 1, project 2); 1 as untrusted data. ~40 of 2000 tokens.',
      '1 fact left out: the 2000-token memory budget is full.',
      '1 local-only fact is withheld from cloud models.',
      'The memory files are inside the workspace, where models can write: every fact is sent as untrusted.',
      'Memory: memory/user.md line 3 kept as is',
      '1 proposed fact waits for you.',
    ]);
    expect(lines.map((l) => l.tone)).toEqual(['info', 'warn', 'muted', 'warn', 'warn', 'info']);
    setLocale('fr');
    expect(memoryLines(MEMORY_SUMMARY as unknown as MemorySummary)[0]!.text).toBe(
      'Mémoire : 2 faits envoyés à chaque nœud (utilisateur 1, projet 2) ; 1 comme données non fiables. ~40 jetons sur 2000.',
    );
    setLocale('en');
    const none = { ...MEMORY_SUMMARY, included: [], truncated: false, localOnly: 0 };
    const quiet = { ...none, distrusted: false, problems: [], pending: 0 };
    expect(memoryLines(quiet as unknown as MemorySummary)).toEqual([
      { text: 'Memory: no fact is sent with this plan.', tone: 'info' },
    ]);
  });

  it('states the verification ROI with or without accepted findings', () => {
    const v = parseVerification(VERIFICATION)!;
    expect(verificationText(v)).toBe(
      'review $0.02 (25% of $0.08) · issues raised: 3 · accepted findings: 2 · $0.01 per accepted finding',
    );
    expect(verificationText({ ...v, usdPerAcceptedFinding: null })).toMatch(/no accepted finding$/);
    setLocale('fr');
    expect(formatPct(0.25)).toMatch(/^25\s%$/);
    expect(formatPct(null)).toBe('—');
  });
});
