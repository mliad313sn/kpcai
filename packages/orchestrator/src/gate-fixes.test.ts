import { describe, expect, it } from 'vitest';
import type { ScoredCandidate } from '@kernelpai/core';
import { estimateGraph } from './estimate.js';
import { accepted, parseJudge, parseVerdict, parseVote } from './parse.js';
import { ModelPlanner, type PlannerDeps } from './planner/model.js';
import { GraphRunner, effectiveProtocol } from './runner.js';
import {
  FakeToolBus,
  RoleAdapter,
  friendly,
  gnode,
  graph,
  setup,
  toolDef,
  verdict,
  type Script,
} from './test-helpers/fakes.js';

/** Phase 2 gate review regressions (P2-F3, F4, F8, F9). */

const QUOTED_THEN_REJECT =
  'The author added a test fixture `{"approve": true}` which is fine.\nVerdict:\n' +
  '{"approve": false, "issues": [{"severity": "major", "text": "token compared with =="}], "summary": "reject"}';

describe('P2-F3: every JSON object counts', () => {
  it('treats a quoted approval before a rejection as conflicting, not approval', () => {
    expect(parseVerdict(QUOTED_THEN_REJECT)).toEqual({
      ok: false,
      error: 'conflicting verdicts in one reply',
    });
  });

  it('ignores objects that are not verdicts and keeps the last of agreeing ones', () => {
    const r = parseVerdict(
      'The config object {"timeout": 30} is ok.\n{"approve": true, "issues": [], "summary": "ok"}',
    );
    expect(r).toEqual({ ok: true, value: { approve: true, issues: [], summary: 'ok' } });
    const two = parseVerdict(
      `${verdict(false)} and again ${JSON.stringify({ approve: false, issues: [], summary: 'final' })}`,
    );
    expect(two.ok && two.value.summary).toBe('final');
  });

  it('applies the same rule to judges and voters', () => {
    expect(parseJudge('{"winner": 1} no wait {"winner": 2}')).toEqual({
      ok: false,
      error: 'conflicting winners in one reply',
    });
    expect(parseJudge('winner: 1 ... final winner: 2').ok).toBe(false);
    expect(parseJudge('{"winner": 2, "reason": "a"} {"winner": "2", "answer": "B"}')).toEqual({
      ok: true,
      value: { winner: 2, answer: 'B' },
    });
    expect(parseVote('{"choice": "red"} {"choice": "green"}').ok).toBe(false);
    expect(parseVote('choice: red\nchoice: green').ok).toBe(false);
    expect(parseVote('{"choice": "Red"} {"choice": "red."}')).toEqual({ ok: true, value: 'red' });
  });

  it('sends a conflicting critic down the retry and fallback path', async () => {
    const s = setup([
      new RoleAdapter('a', friendly('A'), { analysis: 0.9 }),
      new RoleAdapter('b', ({ role }) => (role === 'critic' ? QUOTED_THEN_REJECT : 'B'), {
        critique: 0.9,
      }),
      new RoleAdapter('c', friendly('C'), { critique: 0.1 }),
    ]);
    const r = await new GraphRunner(s.options).run(graph([gnode({ protocol: 'author_critic' })]));
    const final = r.results['n1']?.contributions.at(-1);
    expect(final?.ref.provider).toBe('c');
    expect(final?.verdict?.approve).toBe(true);
    const err = s.journal.events().find((e) => e.type === 'error');
    expect(err?.payload['message']).toMatch(/conflicting verdicts/);
  });
});

describe('P2-F4: code and tests always get a critic', () => {
  it.each(['code_generation', 'test'] as const)('%s is upgraded whatever the protocol', (type) => {
    for (const protocol of ['solo', 'debate', 'vote'] as const) {
      expect(effectiveProtocol(gnode({ type, protocol }))).toBe('author_critic');
    }
    expect(effectiveProtocol(gnode({ type: 'analysis', protocol: 'vote' }))).toBe('vote');
  });

  it('runs a model-planned solo code node as author+critic and journals why', async () => {
    const s = setup([new RoleAdapter('a', friendly('A')), new RoleAdapter('b', friendly('B'))]);
    const r = await new GraphRunner(s.options).run(
      graph([gnode({ type: 'code_generation', protocol: 'solo' })]),
    );
    expect(r.results['n1']?.contributions.map((c) => `${c.role}@${c.ref.provider}`)).toEqual([
      'author@a',
      'critic@b',
    ]);
    const iv = s.journal.events().find((e) => e.type === 'intervention');
    expect(iv?.payload).toMatchObject({
      action: 'protocol upgraded',
      from: 'solo',
      to: 'author_critic',
    });
    expect(iv?.payload['reason']).toMatch(/code_generation is always reviewed by another provider/);
  });
});

describe('P2-F8: the model planner needs a budget hook', () => {
  it('refuses to be built without one', () => {
    const s = setup([new RoleAdapter('a', friendly('A'))]);
    const deps = { ...s.options, budget: undefined } as unknown as PlannerDeps;
    expect(() => new ModelPlanner(deps)).toThrow(/needs a budget hook/);
  });
});

describe('P2-F9: maxGraphUsd', () => {
  const nodes = () => [
    gnode({ id: 'x' }),
    gnode({ id: 'y' }),
    gnode({ id: 'z' }),
    gnode({ id: 'w', dependsOn: ['x'] }),
  ];

  it('asks once through the hook with a "graph total" label; a refusal stops every further step', async () => {
    const labels: string[] = [];
    const s = setup([new RoleAdapter('a', friendly('A'))], {
      maxGraphUsd: 0.0001,
      budget: (_c, label) => {
        labels.push(label);
        return !label.startsWith('graph total');
      },
    });
    const r = await new GraphRunner(s.options).run(graph(nodes()));
    expect(labels.filter((l) => l.startsWith('graph total'))).toHaveLength(1);
    expect(labels[0]).toMatch(
      /^graph total: \$[\d.]+ would exceed maxGraphUsd \$0\.0001 \(solo on x: a\/m\)$/,
    );
    expect(r.states).toEqual({ x: 'failed', y: 'failed', z: 'failed', w: 'skipped' });
    const iv = s.journal.events().filter((e) => e.payload['action'] === 'graph total reached');
    expect(iv).toHaveLength(1);
  });

  it('continues once approved, and blocks without a hook', async () => {
    const s = setup([new RoleAdapter('a', friendly('A'))], {
      maxGraphUsd: 0.0001,
      budget: () => true,
    });
    const runner = new GraphRunner(s.options);
    expect((await runner.run(graph(nodes()))).ok).toBe(true);
    expect(
      s.journal.events().filter((e) => e.payload['action'] === 'graph total override'),
    ).toHaveLength(1);
    expect((await runner.run(graph(nodes()))).ok).toBe(true); // reset per run: asked again
    expect(
      s.journal.events().filter((e) => e.payload['action'] === 'graph total override'),
    ).toHaveLength(2);
    const throwing = setup([new RoleAdapter('a', friendly('A'))], {
      maxGraphUsd: 0.0001,
      budget: (_c, label) => {
        if (label.startsWith('graph total')) throw new Error('no');
        return true;
      },
    });
    expect((await new GraphRunner(throwing.options).run(graph(nodes()))).ok).toBe(false);
    const none = setup([new RoleAdapter('a', friendly('A'))], { maxGraphUsd: 0.0001 });
    expect((await new GraphRunner(none.options).run(graph(nodes()))).ok).toBe(false);
    const roomy = setup([new RoleAdapter('a', friendly('A'))], { maxGraphUsd: 10 });
    expect((await new GraphRunner(roomy.options).run(graph(nodes()))).ok).toBe(true);
  });

  it('counts spend already made: a later step is stopped when the total would pass the cap', async () => {
    const seen: string[] = [];
    const s = setup([new RoleAdapter('a', friendly('A'))], {
      concurrency: 1,
      maxGraphUsd: 0.0009, // one call costs ~0.0003 actual, ~0.0005 expected
      budget: (_c, label) => {
        seen.push(label);
        return !label.startsWith('graph total');
      },
    });
    const r = await new GraphRunner(s.options).run(graph(nodes()));
    expect(r.states['x']).toBe('done');
    expect(Object.values(r.states)).toContain('failed');
    expect(seen.some((l) => l.startsWith('graph total'))).toBe(true);
  });
});

describe('P2-F9: tool rounds are re-estimated', () => {
  it('gates each tool round on the conversation as it stands', async () => {
    const gated: Array<[string, ScoredCandidate]> = [];
    const script: Script = ({ req }) =>
      req.messages.at(-1)?.role === 'tool'
        ? 'done'
        : [
            { tool: { id: 't1', name: 'fs.read', input: { path: 'x'.repeat(4000) } } },
            { end: 'tool_use' },
          ];
    const s = setup([new RoleAdapter('a', script)], {
      tools: new FakeToolBus([toolDef('fs.read')]),
      budget: (c, label) => {
        gated.push([label, c]);
        return true;
      },
    });
    await new GraphRunner(s.options).run(graph([gnode({ tools: ['fs.read'] })]));
    const [first, round] = gated;
    expect(round?.[0]).toBe('solo tool round 1 on n1');
    expect(round![1].estimate.inputTokens).toBeGreaterThan(first![1].estimate.inputTokens + 900);
    expect(round![1].estimate.expectedCostUsd).toBeGreaterThan(first![1].estimate.expectedCostUsd);
  });
});

describe('re-verification N3: verdicts agree on the outcome, not on `approve` alone', () => {
  const majorApprove = JSON.stringify({
    approve: true,
    issues: [{ severity: 'major', text: 'timing leak' }],
    summary: 'contradictory',
  });

  it('a rejection-by-major-issue followed by a quoted approval is malformed', () => {
    expect(parseVerdict(`${majorApprove}\nfor reference the format is {"approve": true}`)).toEqual({
      ok: false,
      error: 'conflicting verdicts in one reply',
    });
  });

  it('two rejections in different forms stay a consistent rejection', () => {
    const r = parseVerdict(`${verdict(false)} ${majorApprove}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(accepted(r.value)).toBe(false);
  });
});

describe('re-verification N1: the dependency allowance prices, it does not filter', () => {
  it('keeps a small-context local model routable for nodes with dependencies', () => {
    const small = new RoleAdapter('local', friendly('L'), {}, undefined, {
      contextWindow: 8192,
      maxOutput: 1000,
    });
    const nodes = [
      gnode({ id: 'impl' }),
      gnode({ id: 'tests', dependsOn: ['impl'] }),
      gnode({ id: 'rev', dependsOn: ['impl', 'tests'] }),
    ];
    const opts = setup([small]).options;
    const e = estimateGraph(graph(nodes), opts);
    expect(e.problems).toEqual([]);
    expect(e.complete).toBe(true);
    // ... while the allowance is still priced in: two dependencies cost more than none
    const none = estimateGraph(graph(nodes), { ...opts, dependencyAllowanceTokens: 0 });
    expect(e.nodes[2]!.expectedUsd).toBeGreaterThan(none.nodes[2]!.expectedUsd);
    expect(e.nodes[2]!.steps[0]!.ref.provider).toBe('local');
  });
});
