import type { ProtocolResult } from '@kernelpai/core';
import { describe, expect, it } from 'vitest';
import { GraphRunner } from './runner.js';
import { RoleAdapter, friendly, gnode, graph, setup, type Script } from './test-helpers/fakes.js';
import { nodeVerification, verificationRoi } from './verification.js';

// Every scripted call: 100 input + 50 output tokens at $1 / $2 per MTok = $0.0002.
const CALL = 0.0002;

const twoIssues = JSON.stringify({
  approve: false,
  issues: [
    { severity: 'major', text: 'no bounds check' },
    { severity: 'minor', text: 'naming' },
  ],
  summary: 'needs work',
});

/** Rejects the first draft with two issues, then approves. */
const strict: Script = ({ role, n }) =>
  role === 'critic'
    ? n === 0
      ? twoIssues
      : JSON.stringify({ approve: true, issues: [], summary: 'ok' })
    : 'B';

/** Never approves (one major issue each time). */
const never: Script = ({ role }) =>
  role === 'critic'
    ? JSON.stringify({
        approve: false,
        issues: [{ severity: 'major', text: 'bad' }],
        summary: 'no',
      })
    : 'C';

describe('verification ROI (R-404)', () => {
  it('counts review spend against the findings that led to an accepted revision', async () => {
    const a = new RoleAdapter('a', friendly('A'), { analysis: 0.9, critique: 0.1 });
    const b = new RoleAdapter('b', strict, { analysis: 0.1, critique: 0.9 });
    const s = setup([a, b]);
    const r = await new GraphRunner(s.options).run(
      graph([gnode({ id: 'n1', protocol: 'author_critic' }), gnode({ id: 'n2', title: 'Solo' })]),
    );
    // n1: author, critic (2 issues), revision, critic (approve) = 4 calls; n2: 1 call.
    const v = r.verification;
    expect(v.reviewUsd).toBeCloseTo(2 * CALL, 9);
    expect(v.totalUsd).toBeCloseTo(5 * CALL, 9);
    expect(v.share).toBeCloseTo(0.4, 6);
    expect(v.issuesRaised).toBe(2);
    expect(v.acceptedFindings).toBe(2);
    expect(v.acceptedRevisions).toBe(1);
    expect(v.usdPerAcceptedFinding).toBeCloseTo(CALL, 9);
    expect(v.revisedVerdicts).toBe(1);
    expect(v.majorFindings).toBe(1);
    expect(v.usdPerRevisedVerdict).toBeCloseTo(2 * CALL, 9);
    expect(v.nodes.map((n) => n.nodeId)).toEqual(['n1', 'n2']);
    expect(v.nodes[1]).toEqual({
      nodeId: 'n2',
      reviewUsd: 0,
      issuesRaised: 0,
      acceptedFindings: 0,
      acceptedRevisions: 0,
      revisedVerdicts: 0,
      majorFindings: 0,
    });
  });

  it('finds nothing accepted when the revised work is never approved', async () => {
    const a = new RoleAdapter('a', friendly('A'), { analysis: 0.9, critique: 0.1 });
    const c = new RoleAdapter('c', never, { analysis: 0.1, critique: 0.9 });
    const s = setup([a, c], { maxRevisions: 1 });
    const r = await new GraphRunner(s.options).run(graph([gnode({ protocol: 'author_critic' })]));
    expect(r.results['n1']?.approved).toBe(false);
    expect(r.verification).toMatchObject({
      issuesRaised: 2,
      acceptedFindings: 0,
      acceptedRevisions: 0,
      usdPerAcceptedFinding: null,
      revisedVerdicts: 0,
      usdPerRevisedVerdict: null,
    });
    expect(r.verification.reviewUsd).toBeCloseTo(2 * CALL, 9);
  });

  it('is zero on an empty run, and resets its count at each new author attempt', () => {
    expect(verificationRoi([])).toMatchObject({
      totalUsd: 0,
      share: 0,
      usdPerAcceptedFinding: null,
      usdPerRevisedVerdict: null,
    });
    const ref = { provider: 'b', model: 'm' };
    const reject = {
      approve: false,
      issues: [{ severity: 'major' as const, text: 'x' }],
      summary: '',
    };
    const res: ProtocolResult = {
      nodeId: 'n',
      protocol: 'author_critic',
      output: 'o',
      ok: true,
      approved: true,
      costUsd: 0.5,
      contributions: [
        // A cancelled first attempt (redirect): its rejection is not answered by a revision.
        { role: 'author', ref, text: 'a', costUsd: 0.1 },
        { role: 'critic', ref, text: 'v', costUsd: 0.1, verdict: reject },
        { role: 'author', ref, text: 'a2', costUsd: 0.1 },
        { role: 'critic', ref, text: 'v', costUsd: 0.1, verdict: reject },
        { role: 'revision', ref, text: 'r', costUsd: 0.1 },
      ],
    };
    expect(nodeVerification(res)).toMatchObject({
      issuesRaised: 2,
      acceptedFindings: 1,
      acceptedRevisions: 1,
      revisedVerdicts: 1,
    });
    expect(nodeVerification({ ...res, ok: false })).toMatchObject({ acceptedFindings: 0 });
  });

  it('a verbose critic inflates acceptedFindings but not revisedVerdicts (P4-F12)', () => {
    const ref = { provider: 'b', model: 'm' };
    const major = (text: string) => ({ severity: 'major' as const, text });
    const minor = (text: string) => ({ severity: 'minor' as const, text });
    // One defect padded into nine issues: the same major issue three times, six nitpicks.
    const verbose = {
      approve: false,
      issues: [
        major('No bounds check'),
        major('no  bounds check'),
        major(' NO BOUNDS CHECK '),
        ...Array.from({ length: 6 }, (_, i) => minor(`nit ${i}`)),
      ],
      summary: '',
    };
    const terse = { approve: false, issues: [major('no bounds check')], summary: '' };
    const approve = { approve: true, issues: [], summary: '' };
    const node = (verdict: typeof terse, id: string): ProtocolResult => ({
      nodeId: id,
      protocol: 'author_critic',
      output: 'o',
      ok: true,
      approved: true,
      costUsd: 0.4,
      contributions: [
        { role: 'author', ref, text: 'a', costUsd: 0.1 },
        { role: 'critic', ref, text: 'v', costUsd: 0.1, verdict },
        { role: 'revision', ref, text: 'r', costUsd: 0.1 },
        { role: 'critic', ref, text: 'v', costUsd: 0.1, verdict: approve },
      ],
    });
    const loud = verificationRoi([node(verbose, 'n1')]);
    const quiet = verificationRoi([node(terse, 'n1')]);
    expect(loud.acceptedFindings).toBe(9);
    expect(quiet.acceptedFindings).toBe(1);
    // The robust figures do not move with the critic's verbosity.
    for (const v of [loud, quiet]) {
      expect(v).toMatchObject({ revisedVerdicts: 1, majorFindings: 1, usdPerRevisedVerdict: 0.2 });
    }
    expect(loud.usdPerAcceptedFinding).toBeCloseTo(0.2 / 9, 6);
  });
});
