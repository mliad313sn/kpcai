import { describe, expect, it } from 'vitest';
import { checkAction } from './envelope.js';
import { smallTeamCharter, workPackagesFromGoal } from './team.js';
import { NOW } from './test-helpers/fixtures.js';

const base = {
  programId: 'prog-1',
  goal: 'OAuth login with tests',
  locale: 'en' as const,
  totalCapUsd: 5,
  workPackages: [{ title: 'Login', request: 'OAuth login with tests' }],
  now: NOW,
};

describe('default charter (S10 R7)', () => {
  it('is one small team: builder and independent reviewer, no departments', () => {
    const c = smallTeamCharter(base);
    expect(c.departments.map((d) => d.kind)).toEqual(['engineering', 'review']);
    expect(c.seats.map((s) => s.kind)).toEqual(['builder', 'reviewer']);
    // Q-8 (ADR-0036): a daily digest, sent only when something changed.
    expect(c.reports.cadence).toEqual({ every: 'hours', hours: 24 });
  });

  it('adds a pack specialist when a pack applies; departments only on request', () => {
    const c = smallTeamCharter({ ...base, packs: ['cad'] });
    expect(c.seats.map((s) => s.kind)).toEqual(['builder', 'specialist', 'reviewer']);
    expect(c.departments).toHaveLength(2);
    const d = smallTeamCharter({ ...base, packs: ['cad'], departments: true });
    expect(d.departments.map((x) => x.kind)).toEqual(['engineering', 'domain', 'review']);
  });

  it('expires in 14 days and pre-answers only the two closed values', () => {
    const c = smallTeamCharter(base);
    expect(c.envelope.expires).toBe(new Date(NOW.getTime() + 14 * 86_400_000).toISOString());
    expect(c.envelope.preAnswer).toEqual(['budget-within-envelope', 'write-in-worktree']);
    expect(c.envelope.write).toEqual({ mode: 'isolated-only' });
  });

  it('a reserved item still escalates under the drafted envelope', () => {
    const c = smallTeamCharter(base);
    const s = {
      version: 1 as const,
      status: 'running' as const,
      charter: c,
      approval: { charterHash: 'h', at: NOW.toISOString() },
      phaseIndex: 0,
      runs: [],
      gates: [],
      decisions: [],
      escalations: [],
      updatedAt: NOW.toISOString(),
    };
    expect(checkAction(s, { kind: 'reserved', item: 'publish' }, NOW).verdict).toBe('escalate');
  });

  it('splits a goal written as a list into work packages', () => {
    expect(workPackagesFromGoal('Ship it')).toEqual([{ title: 'Ship it', request: 'Ship it' }]);
    const wps = workPackagesFromGoal('Two parts:\n- the parser\n2. the printer');
    expect(wps.map((w) => w.title)).toEqual(['the parser', 'the printer']);
    expect(wps[0]!.request).toContain('Part of the program goal');
  });
});
