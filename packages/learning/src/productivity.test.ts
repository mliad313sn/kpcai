import { describe, expect, it } from 'vitest';
import { productivity, productivityOf, REWORK_WINDOW_MS } from './productivity.js';
import { readRuns } from './grades.js';
import { Script, verdictText } from './test-helpers/script.js';

const P = { project: '/repo' };
const DAY = 24 * 3600 * 1000;

/**
 * One in-place run of one code node: plan, author answer billed `cost`, whatever `during`
 * journals while it runs (run records), then the outcome.
 */
function run(s: Script, id: string, cost: number, during: () => void = () => {}): void {
  s.plan([{ id: 'n1', type: 'code_generation' }]);
  s.answer('n1', 'a/m', 'author', 'diff', { costUsd: cost });
  during();
  s.outcome(id);
}

describe('productivity (R-406): cost and time per accepted change', () => {
  it('divides everything spent by the changes that reached the workspace', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    s.apply('r1', 'n1', 0, 'confirmed', false, ['src/a.ts']);
    run(s, 'r2', 0.3);
    s.apply('r2', 'n1', 0, 'declined');
    s.apply('r2', 'n1', 1, 'confirmed', true);
    // A cancelled run that delivered nothing still counts in the spend.
    run(s, 'r3', 0.2);
    const p = productivity(s.j, P);
    expect(p.runs).toBe(3);
    expect(p.spentUsd).toBe(0.6);
    expect(p.changes).toEqual({ accepted: 1, declined: 1, failed: 1, pending: 0, discarded: 0 });
    expect(p.costPerAcceptedChangeUsd).toBe(0.6);
    // Each run: routing, call, response one second apart → 2 s of wall time.
    expect(p.runTimeMs).toBe(6000);
    expect(p.timePerAcceptedChangeMs).toBe(6000);
    expect(p.runsWithAcceptedChange).toBe(1);
    expect(p.list[0]).toMatchObject({ runKey: 'r1', nodeId: 'n1', kind: 'patch' });
    expect(p.list[0]?.files).toEqual(['src/a.ts']);
  });

  it('gives null ratios, not zeros, when nothing was accepted', () => {
    const s = new Script();
    run(s, 'r1', 0.05);
    const p = productivity(s.j, P);
    expect(p.costPerAcceptedChangeUsd).toBeNull();
    expect(p.timePerAcceptedChangeMs).toBeNull();
    expect(p.rollbackRate).toBeNull();
    expect(p.reworkRate).toBeNull();
    expect(p.review.usdPerAcceptedFinding).toBeNull();
    expect(p.review.usdPerRevisedVerdict).toBeNull();
    expect(p.band).toEqual({ runs: 0, inBand: 0, rate: null });
  });

  it('counts only kernel writes of node outputs, never a model’s own tool calls', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    // A model writing through its tools, and a kernel event that is not a node write.
    s.tool('n1', 'a/m', { tool: 'fs.write', decision: 'allow', input: { path: 'x.ts' } });
    s.tool('workspace', 'kernel/workspace', { tool: 'git.apply', decision: 'allow' });
    s.tool('n1#patch-0', 'kernel/apply', { tool: 'shell.run', decision: 'allow' });
    s.artifact('r1', 'n1', 0, 'docs/report.md');
    const p = productivity(s.j, P);
    expect(p.list.map((c) => [c.kind, c.files])).toEqual([['artifact', ['docs/report.md']]]);
  });

  it('keeps to the project and to runs started since the given instant', () => {
    const s = new Script();
    run(s, 'old', 1);
    s.apply('old', 'n1', 0);
    s.advance(DAY);
    const cut = new Date(Date.parse('2026-10-23T10:00:00Z') + DAY);
    run(s, 'new', 0.25);
    s.apply('new', 'n1', 0);
    s.session('/elsewhere');
    run(s, 'other', 5);
    s.apply('other', 'n1', 0);
    const p = productivity(s.j, { ...P, since: cut.toISOString() });
    expect(p.runs).toBe(1);
    expect(p.spentUsd).toBe(0.25);
    expect(p.since).toBe(cut.toISOString());
    expect(productivity(s.j, { ...P, since: cut }).changes.accepted).toBe(1);
    expect(productivity(s.j, P).changes.accepted).toBe(2);
    expect(() => productivity(s.j, { ...P, since: 'last tuesday' })).toThrow(RangeError);
  });
});

describe('productivity (R-406): rollback and rework', () => {
  it('a restore undoes the changes that landed after its checkpoint', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    const second = s.apply('r1', 'n1', 1, 'confirmed', false, ['b.ts']);
    s.restore('r1', second);
    const p = productivity(s.j, P);
    expect(p.rolledBack).toBe(1);
    expect(p.rollbackRate).toBe(0.5);
    expect(p.reworkRate).toBe(0.5);
    expect(p.list.map((c) => c.rolledBackSeq !== undefined)).toEqual([false, true]);
  });

  it('a no-op restore, a worktree restore and an unknown checkpoint undo nothing', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    const cp = s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    s.restore('r1', cp, 0);
    s.restore('r1', 'refs/kpai/checkpoints/r1-wt/9');
    s.restore('r1', 'refs/kpai/checkpoints/gone/1');
    const p = productivity(s.j, P);
    expect(p.rolledBack).toBe(0);
    expect(p.unattributedRestores).toBe(1);
  });

  it('a later run touching the same file within the window is rework', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    s.apply('r1', 'n1', 0, 'confirmed', false, ['src/a.ts']);
    s.apply('r1', 'n1', 1, 'confirmed', false, ['src/a.ts']); // same run: not rework
    run(s, 'r2', 0.1);
    s.apply('r2', 'n1', 0, 'confirmed', false, ['src/a.ts', 'src/b.ts']);
    s.advance(REWORK_WINDOW_MS + DAY);
    run(s, 'r3', 0.1);
    s.apply('r3', 'n1', 0, 'confirmed', false, ['src/b.ts']);
    const p = productivity(s.j, P);
    expect(p.list.map((c) => [c.runKey, c.reworkedSeq !== undefined])).toEqual([
      ['r1', true],
      ['r1', true],
      ['r2', false],
      ['r3', false],
    ]);
    expect(p.reworked).toBe(2);
    expect(p.reworkRate).toBe(0.5);
    expect(p.rollbackRate).toBe(0);
    // A wider window turns r2's change into rework too.
    expect(productivity(s.j, { ...P, reworkWindowMs: 30 * DAY }).reworked).toBe(3);
  });
});

describe('productivity (R-406): isolated runs', () => {
  function isolated(s: Script, id: string): void {
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    s.note({ action: 'worktree created', runId: id, path: `/wt/${id}` });
    s.answer('n1', 'a/m', 'author', 'diff', { costUsd: 0.1 });
    s.outcome(id);
    s.apply(id, 'n1', 0, 'confirmed', false, ['src/x.ts'], `${id}-wt`);
  }

  it('a worktree write lands with the merge-back; declined, pending or discarded otherwise', () => {
    const s = new Script();
    isolated(s, 'merged');
    const cp = s.merge('merged', ['src/x.ts']);
    isolated(s, 'declined');
    s.note({ action: 'merge-back declined', runId: 'declined' });
    isolated(s, 'pending');
    isolated(s, 'dropped');
    s.note({ action: 'worktree discarded', runId: 'dropped', removed: true });
    let p = productivity(s.j, P);
    expect(p.list.map((c) => [c.runKey, c.status])).toEqual([
      ['merged', 'accepted'],
      ['declined', 'declined'],
      ['pending', 'pending'],
      ['dropped', 'discarded'],
    ]);
    const merged = p.list[0]!;
    expect(merged.landed!.seq).toBeGreaterThan(merged.seq);
    // Restoring the checkpoint taken before the merge undoes the merged change.
    s.restore('merged', cp, 2);
    p = productivity(s.j, P);
    expect(p.rolledBack).toBe(1);
    expect(p.rollbackRate).toBe(1);
  });

  it('a merge with no kernel write counts as one change with the merged files', () => {
    const s = new Script();
    s.plan([{ id: 'n1', type: 'code_generation' }]);
    s.note({ action: 'worktree created', runId: 'm', path: '/wt/m' });
    s.answer('n1', 'a/m', 'author', 'wrote files with tools', { costUsd: 0.4 });
    s.outcome('m');
    s.merge('m', ['a.ts', 'b.ts']);
    const p = productivity(s.j, P);
    expect(p.list).toMatchObject([{ kind: 'merge', status: 'accepted', files: ['a.ts', 'b.ts'] }]);
    expect(p.costPerAcceptedChangeUsd).toBe(0.4);
  });
});

describe('productivity (R-406): review yield and band', () => {
  const critic = (approve: boolean, issues: number, costUsd: number) => ({
    role: 'critic',
    costUsd,
    verdict: {
      approve,
      issues: Array.from({ length: issues }, () => ({ severity: 'major', text: 'x' })),
      summary: '',
    },
  });

  it('counts findings answered by an approved revision, from the run records', () => {
    const s = new Script();
    run(s, 'r1', 0.1, () => records(s));
    const r = productivity(s.j, P).review;
    expect(r).toEqual({
      nodes: 3,
      reviewUsd: 0.05,
      issuesRaised: 5,
      acceptedFindings: 2,
      acceptedRevisions: 1,
      usdPerAcceptedFinding: 0.025,
      revisedVerdicts: 1,
      majorFindings: 1,
      usdPerRevisedVerdict: 0.05,
    });
  });

  it('a verbose critic multiplies findings, not revised verdicts (P4-F12)', () => {
    const yieldOf = (issues: number) => {
      const s = new Script();
      run(s, 'r1', 0.1, () =>
        s.record('r1', 'n1', {
          protocol: 'author_critic',
          ok: true,
          approved: true,
          contributions: [
            { role: 'author', costUsd: 0.1 },
            critic(false, issues, 0.02),
            { role: 'revision', costUsd: 0.05 },
            critic(true, 0, 0.02),
          ],
        }),
      );
      return productivity(s.j, P).review;
    };
    const [terse, verbose] = [yieldOf(1), yieldOf(8)];
    expect([terse.acceptedFindings, verbose.acceptedFindings]).toEqual([1, 8]);
    expect(verbose.usdPerAcceptedFinding).toBe(0.005);
    for (const r of [terse, verbose]) {
      expect(r).toMatchObject({ revisedVerdicts: 1, majorFindings: 1, usdPerRevisedVerdict: 0.04 });
    }
  });

  function records(s: Script): void {
    s.record('r1', 'n1', {
      protocol: 'author_critic',
      ok: true,
      approved: true,
      costUsd: 0.13,
      contributions: [
        { role: 'author', costUsd: 0.1 },
        critic(false, 2, 0.02),
        { role: 'revision', costUsd: 0.05 },
        critic(true, 0, 0.01),
      ],
    });
    // A failed node: issues raised, nothing accepted.
    s.record('r1', 'n2', {
      ok: false,
      contributions: [{ role: 'author' }, critic(false, 3, 0.02), { role: 'revision' }],
    });
    // A reused fork node and a malformed record are left out.
    s.record('r1', 'n3', { ok: true, approved: true, contributions: [critic(false, 9, 1)] }, true);
    s.record('r1', 'n4', { contributions: 'nope' });
    s.record('r1', 'n5', { ok: true, contributions: [null, { role: 'critic', verdict: 'x' }] });
  }

  it('reports the share of finished runs whose billed cost fell inside the band', () => {
    const s = new Script();
    for (const [id, actual] of [
      ['in', 0.1],
      ['above', 0.5],
    ] as const) {
      const band = { lowUsd: 0.05, highUsd: 0.2, basis: 'calibrated' };
      s.plan([{ id: 'n1', type: 'test' }], { expectedUsd: 0.1, band, nodes: [] });
      s.answer('n1', 'a/m', 'author', verdictText(true), { costUsd: actual });
      s.outcome(id);
    }
    expect(productivity(s.j, P).band).toEqual({ runs: 2, inBand: 1, rate: 0.5 });
  });

  it('is pure over the journal: the same runs give the same report', () => {
    const s = new Script();
    run(s, 'r1', 0.1);
    s.apply('r1', 'n1', 0, 'confirmed', false, ['a.ts']);
    const runs = readRuns(s.j);
    expect(productivityOf(runs, P)).toEqual(productivityOf(runs, P));
    expect(productivityOf(runs, { project: '/nowhere' }).runs).toBe(0);
  });
});
